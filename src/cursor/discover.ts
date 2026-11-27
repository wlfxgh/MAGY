import * as fs from "node:fs/promises";
import * as path from "node:path";
import { messagesFromComposer, parseTranscript, titleFrom, type TranscriptMessage } from "./parse";
import { cursorProjectKeys, defaultCursorProjectsDir, defaultCursorUserDir, pathsEqual } from "./paths";
import { asRecord, errorMessage } from "../util";

export interface CursorConversationSummary {
    id: string;
    title: string;
    updatedAt: number;
    source: "composer" | "transcript";
    project?: string;
    mode?: string;
    inWorkspace: boolean;
    transcriptPath?: string;
}

export interface DiscoverResult {
    conversations: CursorConversationSummary[];
    warnings: string[];
}

export interface DiscoverOptions {
    userDir?: string;
    projectsDir?: string;
    workspacePaths: string[];
    all: boolean;
}

export async function discoverCursorConversations(options: DiscoverOptions): Promise<DiscoverResult> {
    const userDir = options.userDir || defaultCursorUserDir();
    const projectsDir = options.projectsDir || defaultCursorProjectsDir();
    const warnings: string[] = [];
    const found = new Map<string, CursorConversationSummary>();
    const workspaceMap = await readWorkspaceMap(userDir);
    const workspaceIds = matchedWorkspaceIds(workspaceMap, options.workspacePaths);
    const globalDb = path.join(userDir, "globalStorage", "state.vscdb");
    if (await exists(globalDb)) {
        try {
            await withDb(globalDb, (db) => {
                try {
                    readHeadersFromDb(db, options, found);
                } catch (error) {
                    warnings.push(`未能读取 Cursor 全局索引：${errorMessage(error)}`);
                }
                try {
                    readComposerHeadersTable(db, options, workspaceMap, workspaceIds, found);
                } catch {
                    // Older Cursor databases or test fixtures may not contain composerHeaders.
                }
                try {
                    scanComposersFromDb(db, options, workspaceMap, workspaceIds, found);
                } catch (error) {
                    warnings.push(`未能扫描历史对话：${errorMessage(error)}`);
                }
            });
        } catch (error) {
            warnings.push(`未能打开 Cursor 全局数据库：${errorMessage(error)}`);
        }
    } else {
        warnings.push("未找到 Cursor 全局数据库");
    }
    try {
        await readWorkspaceStores(userDir, options, workspaceMap, workspaceIds, found);
    } catch (error) {
        warnings.push(`未能读取工作区对话索引：${errorMessage(error)}`);
    }
    try {
        await readTranscripts(projectsDir, options, found);
    } catch (error) {
        warnings.push(`未能读取 agent transcript：${errorMessage(error)}`);
    }
    const conversations = [...found.values()].sort((left, right) => {
        if (left.inWorkspace !== right.inWorkspace) {
            return left.inWorkspace ? -1 : 1;
        }
        return right.updatedAt - left.updatedAt;
    });
    return { conversations, warnings };
}

export async function loadCursorConversation(summary: CursorConversationSummary, userDir?: string): Promise<{ title: string; messages: TranscriptMessage[] }> {
    if (summary.source === "composer") {
        try {
            const loaded = await loadComposer(path.join(userDir || defaultCursorUserDir(), "globalStorage", "state.vscdb"), summary.id);
            if (loaded.messages.length || !summary.transcriptPath) {
                return { title: loaded.title || summary.title, messages: loaded.messages };
            }
        } catch (error) {
            if (!summary.transcriptPath) {
                throw error;
            }
        }
    }
    if (!summary.transcriptPath) {
        return { title: summary.title, messages: [] };
    }
    return loadTranscript(summary.transcriptPath, summary.title);
}

function readHeadersFromDb(db: SqliteDatabase, options: DiscoverOptions, found: Map<string, CursorConversationSummary>): boolean {
    const value = readItem(db, "ItemTable", "composer.composerHeaders");
    const composers = Array.isArray(asRecord(value).allComposers) ? asRecord(value).allComposers as unknown[] : [];
    if (!composers.length) {
        return false;
    }
    for (const entry of composers) {
        const summary = summaryFromHeader(entry, options.workspacePaths);
        if (!summary || summary.id.startsWith("task-")) {
            continue;
        }
        if (!options.all && !summary.inWorkspace) {
            continue;
        }
        addSummary(found, summary);
    }
    return true;
}

function readComposerHeadersTable(
    db: SqliteDatabase,
    options: DiscoverOptions,
    workspaceMap: ReadonlyMap<string, string>,
    workspaceIds: ReadonlySet<string>,
    found: Map<string, CursorConversationSummary>,
): void {
    const rows = db.prepare(`
        SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
        FROM composerHeaders
        WHERE COALESCE(isSubagent, 0) = 0
    `).all() as Record<string, unknown>[];
    for (const row of rows) {
        const id = textValue(row.composerId);
        if (!id || id.startsWith("task-")) {
            continue;
        }
        const parsed = asRecord(decodeJson(row.value));
        const workspaceId = textValue(row.workspaceId) || textValue(asRecord(parsed.workspaceIdentifier).id);
        const project = workspacePathOf(parsed) || (workspaceId ? workspaceMap.get(workspaceId) || "" : "");
        const inWorkspace = (workspaceId !== "" && workspaceIds.has(workspaceId))
            || options.workspacePaths.some((item) => project !== "" && pathsEqual(item, project));
        if (!options.all && !inWorkspace) {
            continue;
        }
        addSummary(found, {
            id,
            title: textValue(parsed.name) || textValue(parsed.title) || "未命名对话",
            updatedAt: Number(row.lastUpdatedAt ?? parsed.lastUpdatedAt ?? row.createdAt ?? parsed.createdAt ?? 0),
            source: "composer",
            project: project || undefined,
            mode: typeof parsed.unifiedMode === "string" ? parsed.unifiedMode : undefined,
            inWorkspace,
        });
    }
}

async function readWorkspaceStores(
    userDir: string,
    options: DiscoverOptions,
    workspaceMap: ReadonlyMap<string, string>,
    workspaceIds: ReadonlySet<string>,
    found: Map<string, CursorConversationSummary>,
): Promise<void> {
    if (!workspaceIds.size) {
        return;
    }
    const root = path.join(userDir, "workspaceStorage");
    for (const dirName of workspaceIds) {
        const workspacePath = workspaceMap.get(dirName);
        if (!workspacePath) {
            continue;
        }
        const dbPath = path.join(root, dirName, "state.vscdb");
        if (!await exists(dbPath)) {
            continue;
        }
        await withDb(dbPath, (db) => {
            const data = asRecord(readItem(db, "ItemTable", "composer.composerData"));
            const composers = Array.isArray(data.allComposers) ? data.allComposers : [];
            for (const entry of composers) {
                const summary = summaryFromHeader(entry, options.workspacePaths, workspacePath);
                if (summary && !summary.id.startsWith("task-")) {
                    addSummary(found, summary);
                }
            }
        });
    }
}

async function readTranscripts(projectsDir: string, options: DiscoverOptions, found: Map<string, CursorConversationSummary>): Promise<void> {
    if (!await exists(projectsDir)) {
        return;
    }
    const keys = new Set(options.workspacePaths.flatMap((item) => cursorProjectKeys(item)));
    const directories = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const directory of directories) {
        if (!directory.isDirectory()) {
            continue;
        }
        const inWorkspace = keys.has(directory.name);
        if (!options.all && !inWorkspace) {
            continue;
        }
        const project = options.workspacePaths.find((item) => cursorProjectKeys(item).includes(directory.name));
        const transcripts = path.join(projectsDir, directory.name, "agent-transcripts");
        if (!await exists(transcripts)) {
            continue;
        }
        const entries = await fs.readdir(transcripts, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === "subagents") {
                continue;
            }
            const full = path.join(transcripts, entry.name);
            const file = entry.isFile() && entry.name.endsWith(".jsonl")
                ? full
                : entry.isDirectory()
                    ? await transcriptFile(full, entry.name)
                    : undefined;
            if (!file) {
                continue;
            }
            const id = entry.name.replace(/\.jsonl$/, "");
            const existing = found.get(id);
            if (existing && existing.title !== "未命名对话") {
                addSummary(found, {
                    id,
                    title: existing.title,
                    updatedAt: existing.updatedAt,
                    source: "transcript",
                    project: existing.project || project,
                    inWorkspace,
                    transcriptPath: file,
                });
                continue;
            }
            const preview = await previewTranscript(file);
            addSummary(found, {
                id,
                title: preview.title,
                updatedAt: preview.updatedAt,
                source: "transcript",
                project,
                inWorkspace,
                transcriptPath: file,
            });
        }
    }
}

function scanComposersFromDb(
    db: SqliteDatabase,
    options: DiscoverOptions,
    workspaceMap: ReadonlyMap<string, string>,
    workspaceIds: ReadonlySet<string>,
    found: Map<string, CursorConversationSummary>,
): void {
    const rows = db.prepare(`
        SELECT substr(key, 14) AS id,
               json_extract(value, '$.name') AS name,
               json_extract(value, '$.lastUpdatedAt') AS updatedAt,
               json_extract(value, '$.createdAt') AS createdAt,
               json_extract(value, '$.unifiedMode') AS mode,
               json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS fsPath,
               json_extract(value, '$.workspaceIdentifier.id') AS workspaceId,
               json_extract(value, '$.workspaceIdentifier.configPath') AS configPath
        FROM cursorDiskKV
        WHERE key >= ?
          AND key < ?
    `).all("composerData:", "composerData;") as Record<string, unknown>[];
    for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id || id.startsWith("task-")) {
            continue;
        }
        const workspaceId = textValue(row.workspaceId);
        const project = projectFromComposer(row) || (workspaceId ? workspaceMap.get(workspaceId) || "" : "");
        const inWorkspace = (workspaceId !== "" && workspaceIds.has(workspaceId))
            || options.workspacePaths.some((item) => project !== "" && pathsEqual(item, project));
        if (!options.all && !inWorkspace) {
            continue;
        }
        addSummary(found, {
            id,
            title: textValue(row.name) || "未命名对话",
            updatedAt: Number(row.updatedAt ?? row.createdAt ?? 0),
            source: "composer",
            project: project || undefined,
            mode: typeof row.mode === "string" ? row.mode : undefined,
            inWorkspace,
        });
    }
}

function projectFromComposer(row: Record<string, unknown>): string {
    const fsPath = textValue(row.fsPath);
    if (fsPath) {
        return fsPath;
    }
    const configPath = textValue(row.configPath);
    return fileUriToPath(configPath) || configPath;
}

async function loadComposer(dbPath: string, composerId: string): Promise<{ title: string; messages: TranscriptMessage[] }> {
    return withDb(dbPath, (db) => {
        const data = readItem(db, "cursorDiskKV", `composerData:${composerId}`);
        const bubbles = new Map<string, unknown>();
        const bubbleStart = `bubbleId:${composerId}:`;
        const bubbleEnd = `bubbleId:${composerId};`;
        const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?").all(bubbleStart, bubbleEnd) as { key?: unknown; value?: unknown }[];
        for (const row of rows) {
            const key = decodeText(row.key);
            const id = key.slice(bubbleStart.length);
            const value = decodeJson(row.value);
            if (id && value) {
                bubbles.set(id, value);
            }
        }
        const record = asRecord(data);
        let headers = Array.isArray(record.fullConversationHeadersOnly) ? record.fullConversationHeadersOnly : [];
        if (!headers.length) {
            const headerStart = `composerConvHeaders:${composerId}:`;
            const headerEnd = `composerConvHeaders:${composerId};`;
            const headerRows = db.prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key").all(headerStart, headerEnd) as { value?: unknown }[];
            const last = headerRows.at(-1);
            const parsed = decodeJson(last?.value);
            if (Array.isArray(parsed)) {
                headers = parsed;
            }
        }
        const messages = messagesFromComposer({ ...record, fullConversationHeadersOnly: headers }, bubbles);
        const title = String(record.name || "") || titleFrom(messages.find((message) => message.role === "user")?.text ?? "");
        return { title, messages };
    });
}

async function loadTranscript(file: string, fallbackTitle: string): Promise<{ title: string; messages: TranscriptMessage[] }> {
    const stat = await fs.stat(file);
    let raw: string;
    if (stat.size > 32 * 1024 * 1024) {
        const handle = await fs.open(file, "r");
        try {
            const length = 8 * 1024 * 1024;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, Math.max(stat.size - length, 0));
            raw = buffer.toString("utf8");
        } finally {
            await handle.close();
        }
    } else {
        raw = await fs.readFile(file, "utf8");
    }
    const messages = parseTranscript(raw);
    if (stat.size > 32 * 1024 * 1024) {
        messages.unshift({ role: "system", text: "记录较大，只保留了末尾部分。" });
    }
    const title = titleFrom(messages.find((message) => message.role === "user")?.text ?? "") || fallbackTitle;
    return { title: title === "未命名对话" ? fallbackTitle : title, messages };
}

async function previewTranscript(file: string): Promise<{ title: string; updatedAt: number }> {
    const stat = await fs.stat(file);
    const handle = await fs.open(file, "r");
    try {
        const length = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        const messages = parseTranscript(buffer.toString("utf8"));
        const text = messages.find((message) => message.role === "user")?.text ?? "";
        return { title: titleFrom(text), updatedAt: stat.mtimeMs };
    } finally {
        await handle.close();
    }
}

async function transcriptFile(directory: string, name: string): Promise<string | undefined> {
    const preferred = path.join(directory, `${name}.jsonl`);
    if (await exists(preferred)) {
        return preferred;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const file = entries.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
    return file ? path.join(directory, file.name) : undefined;
}

async function readWorkspaceMap(userDir: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const root = path.join(userDir, "workspaceStorage");
    if (!await exists(root)) {
        return map;
    }
    const directories = await fs.readdir(root, { withFileTypes: true });
    for (const directory of directories) {
        if (!directory.isDirectory()) {
            continue;
        }
        const target = await workspacePathFrom(path.join(root, directory.name, "workspace.json"));
        if (target) {
            map.set(directory.name, target);
        }
    }
    return map;
}

function matchedWorkspaceIds(workspaceMap: ReadonlyMap<string, string>, workspacePaths: string[]): Set<string> {
    const ids = new Set<string>();
    for (const [id, target] of workspaceMap) {
        if (target && workspacePaths.some((item) => pathsEqual(item, target))) {
            ids.add(id);
        }
    }
    return ids;
}

async function workspacePathFrom(file: string): Promise<string> {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { folder?: string; workspace?: string };
        return fileUriToPath(parsed.folder || parsed.workspace || "");
    } catch {
        return "";
    }
}

function textValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function summaryFromHeader(entry: unknown, workspacePaths: string[], fallbackProject?: string): CursorConversationSummary | undefined {
    const record = asRecord(entry);
    const id = String(record.composerId ?? record.id ?? "");
    if (!id) {
        return undefined;
    }
    const project = workspacePathOf(record) || fallbackProject;
    const inWorkspace = project ? workspacePaths.some((item) => pathsEqual(item, project)) : Boolean(fallbackProject);
    return {
        id,
        title: String(record.name || record.title || "") || "未命名对话",
        updatedAt: Number(record.lastUpdatedAt ?? record.createdAt ?? 0),
        source: "composer",
        project,
        mode: typeof record.unifiedMode === "string" ? record.unifiedMode : undefined,
        inWorkspace,
    };
}

function workspacePathOf(entry: Record<string, unknown>): string {
    const identifier = asRecord(entry.workspaceIdentifier);
    const uri = asRecord(identifier.uri ?? entry.workspaceUri);
    if (typeof uri.fsPath === "string") {
        return uri.fsPath;
    }
    if (typeof uri.external === "string") {
        return fileUriToPath(uri.external);
    }
    if (typeof entry.workspacePath === "string") {
        return entry.workspacePath;
    }
    return "";
}

function fileUriToPath(uri: string): string {
    if (!uri.startsWith("file:")) {
        return "";
    }
    try {
        const parsed = new URL(uri);
        let pathname = decodeURIComponent(parsed.pathname);
        if (/^\/[A-Za-z]:/.test(pathname)) {
            pathname = pathname.slice(1);
        }
        return pathname;
    } catch {
        return "";
    }
}

function addSummary(found: Map<string, CursorConversationSummary>, summary: CursorConversationSummary): void {
    const existing = found.get(summary.id);
    if (!existing) {
        found.set(summary.id, summary);
        return;
    }
    if (existing.source === "transcript" && summary.source === "composer") {
        found.set(summary.id, { ...summary, transcriptPath: existing.transcriptPath, inWorkspace: existing.inWorkspace || summary.inWorkspace });
        return;
    }
    if (summary.transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = summary.transcriptPath;
    }
    existing.inWorkspace = existing.inWorkspace || summary.inWorkspace;
    if (summary.updatedAt > existing.updatedAt) {
        existing.updatedAt = summary.updatedAt;
    }
    if (existing.title === "未命名对话" && summary.title !== "未命名对话") {
        existing.title = summary.title;
    }
}

async function withDb<T>(file: string, run: (db: SqliteDatabase) => T | Promise<T>): Promise<T> {
    const sqlite = await import("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 5000 });
    try {
        try {
            db.exec("PRAGMA query_only = ON");
        } catch {
            // Read-only connection already blocks writes on older SQLite builds.
        }
        return await run(readOnlyDb(db));
    } finally {
        db.close();
    }
}

function readOnlyDb(db: import("node:sqlite").DatabaseSync): SqliteDatabase {
    return {
        prepare(sql: string) {
            assertReadOnlySql(sql);
            const statement = db.prepare(sql) as {
                get(...params: unknown[]): unknown;
                all(...params: unknown[]): unknown[];
            };
            return {
                get: (...params: unknown[]) => statement.get(...params),
                all: (...params: unknown[]) => statement.all(...params),
            };
        },
        close() {
            db.close();
        },
    };
}

export function assertReadOnlySql(sql: string): void {
    const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ").trim();
    if (!/^(select|pragma|with)\b/i.test(normalized)) {
        throw new Error("引入对话只读取 Cursor 数据");
    }
    if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|truncate)\b/i.test(normalized)) {
        throw new Error("引入对话只读取 Cursor 数据");
    }
    const parts = normalized.split(";").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
        throw new Error("引入对话只读取 Cursor 数据");
    }
}

interface SqliteDatabase {
    prepare(sql: string): {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
    close(): void;
}

function readItem(db: SqliteDatabase, table: "ItemTable" | "cursorDiskKV", key: string): unknown {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value?: unknown } | undefined;
    return decodeJson(row?.value);
}

function decodeJson(value: unknown): unknown {
    let current = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value;
    for (let attempt = 0; attempt < 2 && typeof current === "string"; attempt += 1) {
        const trimmed = current.trim();
        if (!trimmed) {
            return undefined;
        }
        try {
            current = JSON.parse(trimmed) as unknown;
        } catch {
            return attempt === 0 ? undefined : current;
        }
    }
    return current;
}

function decodeText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("utf8");
    }
    return String(value ?? "");
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}
