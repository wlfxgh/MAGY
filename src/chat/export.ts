import type { ChatRecord, CodeAttachment, StoredMessage } from "./types";

/** Produces a safe cross-platform base filename (without extension) from a chat title. */
export function sanitizeExportFileName(title: string): string {
    const cleaned = String(title || "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");
    if (!cleaned) {
        return "magy-chat";
    }
    return cleaned.slice(0, 60).trim() || "magy-chat";
}

/** Formats a chat record and all messages cleanly as portable Markdown. */
export function formatChatAsMarkdown(chat: ChatRecord): string {
    const lines: string[] = [];
    const title = chat.title?.trim() || "未命名对话";
    lines.push(`# ${title}`);
    lines.push("");

    const metaParts: string[] = [];
    metaParts.push(`导出时间：${formatExportTime(Date.now())}`);
    if (chat.updatedAt) {
        metaParts.push(`更新时间：${formatExportTime(chat.updatedAt)}`);
    }
    metaParts.push(`消息数：${chat.messages.length}`);
    if (chat.tokenStats && chat.tokenStats.total.totalTokens > 0) {
        const t = chat.tokenStats.total;
        metaParts.push(`累计 Token：${t.totalTokens.toLocaleString("en-US")}（输入 ${t.inputTokens.toLocaleString("en-US")} / 输出 ${t.outputTokens.toLocaleString("en-US")}）`);
    }
    lines.push(`> ${metaParts.join(" · ")}`);

    for (const message of chat.messages) {
        const section = formatMessageMarkdown(message);
        if (section) {
            lines.push("");
            lines.push(section);
        }
    }

    lines.push("");
    return lines.join("\n");
}

/** Formats a chat record cleanly as structured JSON. */
export function formatChatAsJson(chat: ChatRecord): string {
    return `${JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        chat: {
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            imported: Boolean(chat.imported),
            tokenStats: chat.tokenStats,
            messages: chat.messages,
        },
    }, null, 2)}\n`;
}

function formatMessageMarkdown(message: StoredMessage): string {
    if (message.role === "user") {
        const parts: string[] = ["## 用户"];
        if (message.attachments?.length) {
            for (const att of message.attachments) {
                parts.push(formatAttachmentMarkdown(att));
            }
        }
        if (message.text.trim()) {
            parts.push(message.text.trim());
        }
        return parts.join("\n\n");
    }

    if (message.role === "assistant") {
        const text = message.text.trim();
        return text ? `## 助手\n\n${text}` : "";
    }

    if (message.role === "thought") {
        const text = message.text.trim();
        if (!text) {
            return "";
        }
        const label = message.title?.trim() || "思考过程";
        return `<details>\n<summary>${escapeSummary(label)}</summary>\n\n${text}\n\n</details>`;
    }

    if (message.role === "tool") {
        const parts: string[] = [];
        const heading = message.title?.trim() || "工具调用";
        const meta = [message.status?.trim(), message.detail?.trim()].filter(Boolean).join(" · ");
        parts.push(meta ? `### 工具：${heading}（${meta}）` : `### 工具：${heading}`);
        if (message.diffs?.length) {
            for (const diff of message.diffs) {
                const header = diff.path ? `文件：\`${diff.path}\`` : "代码变更";
                const patchLines: string[] = [];
                if (diff.oldText) {
                    for (const line of diff.oldText.split(/\r?\n/)) {
                        patchLines.push(`- ${line}`);
                    }
                }
                if (diff.newText) {
                    for (const line of diff.newText.split(/\r?\n/)) {
                        patchLines.push(`+ ${line}`);
                    }
                }
                parts.push(`${header}\n\n${fencedBlock(patchLines.join("\n"), "diff")}`);
            }
        }
        if (message.text.trim()) {
            parts.push(fencedBlock(message.text.trim(), ""));
        }
        return parts.join("\n\n");
    }

    const sysText = message.text.trim();
    if (!sysText) {
        return "";
    }
    return sysText.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function formatAttachmentMarkdown(att: CodeAttachment): string {
    if (att.kind === "directory") {
        return `> 目录：\`${att.relativePath}\``;
    }
    if (att.kind === "file" || !att.text) {
        return `> 文件：\`${att.relativePath || att.fileName}\``;
    }
    const range = att.startLine && att.endLine
        ? (att.startLine === att.endLine ? `第 ${att.startLine} 行` : `第 ${att.startLine}–${att.endLine} 行`)
        : "";
    const lang = att.languageId && att.languageId !== "plaintext" ? att.languageId : "";
    const label = [att.relativePath || att.fileName, range].filter(Boolean).join(" ");
    return `> 引用 \`${label}\`\n\n${fencedBlock(att.text.replace(/\s+$/, ""), lang)}`;
}

function fencedBlock(content: string, lang: string): string {
    let longest = 2;
    const matches = content.match(/`+/g);
    if (matches) {
        for (const run of matches) {
            if (run.length > longest) {
                longest = run.length;
            }
        }
    }
    const fence = "`".repeat(longest + 1);
    return `${fence}${lang}\n${content}\n${fence}`;
}

function escapeSummary(text: string): string {
    return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatExportTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
