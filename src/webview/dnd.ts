import type { VsCodeApi } from "./types";

interface ElectronFile extends File {
    path?: string;
}

function hasFileOrResourceDrop(dt: DataTransfer | null): boolean {
    if (!dt) {
        return false;
    }
    if (dt.files && dt.files.length > 0) {
        return true;
    }
    const types = Array.from(dt.types || []).map((t) => String(t).toLowerCase());
    return types.some((t) =>
        t === "application/vnd.code.uri-list" ||
        t === "text/uri-list" ||
        t === "resourceurls" ||
        t === "codefiles" ||
        t === "codeeditors" ||
        t === "files" ||
        t === "application/x-cursor-draggable",
    );
}

function parseUriList(raw: string): string[] {
    return String(raw || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => Boolean(line) && !line.startsWith("#"));
}

function extractStringsFromJson(value: unknown, out: (v: string) => void): void {
    if (typeof value === "string") {
        out(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            extractStringsFromJson(item, out);
        }
        return;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of ["uri", "resource", "path", "fsPath", "external", "url"]) {
            if (record[key] !== undefined) {
                extractStringsFromJson(record[key], out);
            }
        }
        if (record.editor !== undefined) {
            extractStringsFromJson(record.editor, out);
        }
    }
}

function extractDroppedPaths(dt: DataTransfer | null): string[] {
    if (!dt) {
        return [];
    }
    const items: string[] = [];
    const add = (v: unknown): void => {
        const s = String(v || "").trim();
        if (s && !items.includes(s)) {
            items.push(s);
        }
    };
    const typeMap = new Map<string, string>();
    for (const t of Array.from(dt.types || [])) {
        typeMap.set(String(t).toLowerCase(), t);
    }
    for (const lower of ["application/vnd.code.uri-list", "text/uri-list"]) {
        const actual = typeMap.get(lower);
        const val = actual ? dt.getData(actual) : "";
        if (val) {
            for (const line of parseUriList(val)) {
                add(line);
            }
        }
    }
    for (const lower of ["resourceurls", "codefiles", "codeeditors"]) {
        const actual = typeMap.get(lower);
        const val = actual ? dt.getData(actual) : "";
        if (val) {
            try {
                extractStringsFromJson(JSON.parse(val), add);
            } catch {
                for (const line of parseUriList(val)) {
                    add(line);
                }
            }
        }
    }
    if (dt.files && dt.files.length) {
        for (const file of Array.from(dt.files)) {
            const filePath = (file as ElectronFile).path;
            if (filePath) {
                add(filePath);
            }
        }
    }
    if (!items.length) {
        const plainType = typeMap.get("text/plain");
        const plain = plainType ? dt.getData(plainType) : "";
        if (plain) {
            for (const line of parseUriList(plain)) {
                if (/^(?:file:\/\/\/|[A-Za-z]:[\\/]|\/|[^\s]+\/[^\s]+)/.test(line)) {
                    add(line);
                }
            }
        }
    }
    return items;
}

export function initDragAndDrop(composerEl: HTMLElement | null, vscode: VsCodeApi): void {
    let dropClearTimer = 0;

    const setDropActive = (active: boolean): void => {
        clearTimeout(dropClearTimer);
        dropClearTimer = 0;
        document.body.classList.toggle("drop-active", active);
        if (composerEl) {
            composerEl.classList.toggle("drop-target", active);
        }
    };

    const scheduleDropClear = (): void => {
        clearTimeout(dropClearTimer);
        dropClearTimer = window.setTimeout(() => {
            setDropActive(false);
        }, 140);
    };

    window.addEventListener("dragenter", (event) => {
        if (!hasFileOrResourceDrop(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        setDropActive(true);
        scheduleDropClear();
    }, true);

    window.addEventListener("dragover", (event) => {
        if (!hasFileOrResourceDrop(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
        }
        setDropActive(true);
        scheduleDropClear();
    }, true);

    window.addEventListener("dragleave", (event) => {
        if (!hasFileOrResourceDrop(event.dataTransfer)) {
            return;
        }
        scheduleDropClear();
    }, true);

    window.addEventListener("drop", (event) => {
        const resourceDrop = hasFileOrResourceDrop(event.dataTransfer);
        const items = extractDroppedPaths(event.dataTransfer);
        setDropActive(false);
        if (!resourceDrop && !items.length) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (items.length) {
            vscode.postMessage({ type: "addDroppedPaths", items });
        }
    }, true);
}
