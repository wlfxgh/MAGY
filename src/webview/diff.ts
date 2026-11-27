import type { FileTarget, NormalizedToolMeta, StoredMessage, ToolDiff } from "./types";

export interface DiffRow {
    type: "add" | "del" | "ctx" | "hunk";
    text: string;
    newLine?: number;
}

export function unwrapJsonOutput(text: string): string {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const obj = JSON.parse(trimmed) as unknown;
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                const record = obj as Record<string, unknown>;
                const parts: string[] = [];
                for (const key of ["stdout", "output", "content", "text", "result", "stderr"]) {
                    const val = record[key];
                    if (typeof val === "string" && val.trim()) {
                        parts.push(val.replace(/\r\n/g, "\n").trimEnd());
                    }
                }
                if (parts.length) {
                    return parts.join("\n");
                }
            }
        } catch {
            // Keep raw text
        }
    }
    return text;
}

export function normalizeToolMeta(message: StoredMessage): NormalizedToolMeta {
    const role = message.role || "assistant";
    let status = message.status || "";
    if (role === "thought" && !status) {
        status = "completed";
    }
    let kind = message.kind || "";
    let title = message.title || (role === "thought" ? "思考" : "工具");
    let detail = message.detail || "";
    let text = message.text || "";
    if (role === "tool" && !kind) {
        if (Array.isArray(message.diffs) && message.diffs.length) {
            kind = "edit";
        } else if (/^File\s+(.+)$/i.test(title)) {
            kind = "read";
            const rawPath = title.replace(/^File\s+/i, "").replace(/^\/([A-Za-z]:[\\/])/, "$1");
            const parts = rawPath.split(/[\\/]/);
            const name = parts[parts.length - 1] || rawPath;
            title = `读取 ${name}`;
            detail = rawPath.replace(/\\/g, "/");
            const lines = text.trim().split(/\r?\n/);
            if (lines.length >= 2 && lines[1].trim().startsWith("{")) {
                text = "";
            }
        } else if (/^Created At:/m.test(text) || /^Command exited/m.test(text)) {
            kind = "execute";
            const created = /^Created At:\s*(.+)$/m.exec(text);
            const completed = /^Completed At:\s*(.+)$/m.exec(text);
            const exit = /^Command exited with code (-?\d+)\.?$/m.exec(text);
            const out = /\r?\nCommand output:\r?\n([\s\S]*)$/.exec(text);
            const dp: string[] = [];
            if (exit) {
                dp.push(`退出 ${exit[1]}`);
            }
            if (created && completed) {
                const s = (Date.parse(completed[1]) - Date.parse(created[1])) / 1000;
                if (Number.isFinite(s) && s >= 0) {
                    dp.push(s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`);
                }
            }
            detail = dp.join(" · ");
            const cmd = title;
            title = cmd.replace(/\s+/g, " ").trim() || "运行命令";
            if (out) {
                text = `$ ${cmd}\n\n${out[1].replace(/^\r?\n+/, "").trimEnd()}`;
            }
        } else if (/^(Read|Glob|Grep|Shell|Bash|Edit|Write|CallDynamicTool|GetDynamicTools)\b/i.test(title)) {
            if (/^Read/i.test(title)) {
                kind = "read";
            } else if (/^(Glob|Grep)/i.test(title)) {
                kind = "search";
            } else if (/^(Shell|Bash)/i.test(title)) {
                kind = "execute";
            } else if (/^(Edit|Write)/i.test(title)) {
                kind = "edit";
            } else {
                kind = "tool";
            }
        } else {
            kind = "tool";
        }
    }
    return { role, status, kind, title, detail, text };
}

export function inferToolFileTarget(message: StoredMessage, norm: NormalizedToolMeta): FileTarget | null {
    if (message.filePath) {
        return { path: message.filePath, line: message.line };
    }
    if (Array.isArray(message.diffs) && message.diffs.length && message.diffs[0]?.path) {
        const rows = buildDiffLines(message.diffs[0].oldText || "", message.diffs[0].newText || "");
        const firstChanged = rows.find((r) => (r.type === "add" || r.type === "del") && typeof r.newLine === "number" && r.newLine > 0);
        return { path: message.diffs[0].path, line: firstChanged?.newLine };
    }
    if (norm.kind === "read" || norm.kind === "edit") {
        const rangeMatch = /:(\d+)(?:-\d+)?$/.exec(norm.title || "");
        const lineNum = rangeMatch ? Number(rangeMatch[1]) : undefined;
        if (norm.detail && !/^\+\d+\s+-\d+$/.test(norm.detail) && !/^退出\s/.test(norm.detail)) {
            return { path: norm.detail, line: lineNum };
        }
        const titlePathMatch = /^(?:读取|编辑|写入|新建|删除)\s+(.+?)(?::\d+(?:-\d+)?)?(?:\s+等\s+\d+\s+个文件)?$/.exec(norm.title || "");
        if (titlePathMatch?.[1]) {
            return { path: titlePathMatch[1].trim(), line: lineNum };
        }
    }
    return null;
}

export function buildDiffLines(oldText: string, newText: string): DiffRow[] {
    const a = oldText ? oldText.replace(/\r\n?/g, "\n").split("\n") : [];
    const b = newText ? newText.replace(/\r\n?/g, "\n").split("\n") : [];
    if (!a.length && !b.length) {
        return [];
    }
    if (!a.length) {
        return b.map((text, idx) => ({ type: "add", text, newLine: idx + 1 }));
    }
    if (!b.length) {
        return a.map((text) => ({ type: "del", text, newLine: 1 }));
    }
    if (a.length * b.length > 160000) {
        return [
            ...a.slice(0, 60).map((text): DiffRow => ({ type: "del", text, newLine: 1 })),
            ...b.slice(0, 60).map((text, idx): DiffRow => ({ type: "add", text, newLine: idx + 1 })),
        ];
    }
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
        for (let j = n - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            ops.push({ type: "ctx", text: a[i], newLine: j + 1 });
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ type: "del", text: a[i], newLine: j + 1 });
            i += 1;
        } else {
            ops.push({ type: "add", text: b[j], newLine: j + 1 });
            j += 1;
        }
    }
    while (i < m) {
        ops.push({ type: "del", text: a[i++], newLine: j + 1 });
    }
    while (j < n) {
        const lineNum = j + 1;
        ops.push({ type: "add", text: b[j++], newLine: lineNum });
    }
    const keep = new Uint8Array(ops.length);
    for (let k = 0; k < ops.length; k += 1) {
        if (ops[k].type !== "ctx") {
            for (let c = Math.max(0, k - 2); c <= Math.min(ops.length - 1, k + 2); c += 1) {
                keep[c] = 1;
            }
        }
    }
    const out: DiffRow[] = [];
    let skipping = false;
    for (let k = 0; k < ops.length; k += 1) {
        if (keep[k]) {
            out.push(ops[k]);
            skipping = false;
        } else if (!skipping) {
            out.push({ type: "hunk", text: "···" });
            skipping = true;
        }
    }
    return out;
}

export function renderDiffs(diffs: ToolDiff[], onOpenFile: (path: string, line?: number) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "diff-list";
    for (const diff of diffs) {
        const card = document.createElement("div");
        card.className = "diff-card";
        const head = document.createElement("div");
        head.className = "diff-head";
        const rows = buildDiffLines(diff.oldText || "", diff.newText || "");
        const firstChanged = rows.find((r) => (r.type === "add" || r.type === "del") && typeof r.newLine === "number" && r.newLine > 0);
        const jumpLine = firstChanged?.newLine ?? 1;
        const file = diff.path ? document.createElement("button") : document.createElement("span");
        if (file instanceof HTMLButtonElement && diff.path) {
            file.type = "button";
            file.className = "diff-file diff-file-link";
            file.title = `打开 ${diff.path}${jumpLine > 1 ? `:${jumpLine}` : ""}`;
            file.addEventListener("click", (e) => {
                e.stopPropagation();
                onOpenFile(diff.path, jumpLine);
            });
        } else {
            file.className = "diff-file";
        }
        file.textContent = diff.path || "文件";
        let addCount = 0;
        let delCount = 0;
        for (const row of rows) {
            if (row.type === "add") {
                addCount += 1;
            }
            if (row.type === "del") {
                delCount += 1;
            }
        }
        const stats = document.createElement("span");
        stats.className = "diff-stats";
        if (addCount) {
            const a = document.createElement("span");
            a.className = "diff-stat-add";
            a.textContent = `+${addCount}`;
            stats.append(a);
        }
        if (delCount) {
            const d = document.createElement("span");
            d.className = "diff-stat-del";
            d.textContent = `-${delCount}`;
            stats.append(d);
        }
        head.append(file, stats);
        const code = document.createElement("div");
        code.className = "diff-code";
        const maxLines = 180;
        const visible = rows.slice(0, maxLines);
        for (const row of visible) {
            const line = document.createElement("div");
            line.className = `diff-line ${row.type}`;
            const sign = document.createElement("span");
            sign.className = "diff-sign";
            sign.textContent = row.type === "add" ? "+" : row.type === "del" ? "-" : row.type === "hunk" ? "@" : " ";
            const txt = document.createElement("span");
            txt.className = "diff-text";
            txt.textContent = row.text;
            line.append(sign, txt);
            code.append(line);
        }
        if (rows.length > maxLines) {
            const more = document.createElement("div");
            more.className = "diff-more";
            more.textContent = `还有 ${rows.length - maxLines} 行变更`;
            code.append(more);
        }
        card.append(head, code);
        wrap.append(card);
    }
    return wrap;
}
