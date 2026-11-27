import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMeta, ChatRecord, StoredMessage } from "./types";

interface IndexFile {
    activeId: string;
    chats: ChatMeta[];
}

export class ChatStore {
    private index: IndexFile = { activeId: "", chats: [] };
    private readonly cache = new Map<string, ChatRecord>();

    constructor(private readonly root: string) {}

    async load(): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        try {
            const parsed = JSON.parse(await fs.readFile(this.indexFile(), "utf8")) as IndexFile;
            const rawChats = Array.isArray(parsed.chats) ? parsed.chats : [];
            let backfilled = false;
            const chats: ChatMeta[] = [];
            for (const item of rawChats) {
                if (item && typeof item.id === "string" && (item.count === undefined || item.preview === undefined)) {
                    try {
                        const record = JSON.parse(await fs.readFile(this.chatFile(safeId(item.id)), "utf8")) as ChatRecord;
                        chats.push(metaFromRecord(record));
                        backfilled = true;
                        continue;
                    } catch {
                        // Fall through to keep existing entry
                    }
                }
                chats.push(item);
            }
            this.index = {
                activeId: typeof parsed.activeId === "string" ? parsed.activeId : "",
                chats,
            };
            if (backfilled) {
                await this.writeIndex();
            }
        } catch {
            this.index = { activeId: "", chats: [] };
        }
    }

    list(): ChatMeta[] {
        return [...this.index.chats].sort((left, right) => right.updatedAt - left.updatedAt);
    }

    activeId(): string {
        return this.index.activeId;
    }

    peek(id: string): ChatRecord | undefined {
        return this.cache.get(id);
    }

    async get(id: string): Promise<ChatRecord | undefined> {
        const safe = safeId(id);
        const cached = this.cache.get(safe);
        if (cached) {
            return cached;
        }
        try {
            const record = JSON.parse(await fs.readFile(this.chatFile(safe), "utf8")) as ChatRecord;
            this.cache.set(safe, record);
            return record;
        } catch {
            return undefined;
        }
    }

    create(partial: Partial<ChatRecord> = {}): ChatRecord {
        const now = Date.now();
        const record: ChatRecord = {
            id: randomUUID(),
            title: partial.title || "新对话",
            createdAt: now,
            updatedAt: now,
            imported: partial.imported,
            acpSessionId: partial.acpSessionId,
            needsContext: partial.needsContext ?? false,
            contextText: partial.contextText,
            tokenStats: partial.tokenStats,
            messages: partial.messages ?? [],
        };
        this.cache.set(record.id, record);
        this.upsertMeta(record);
        this.index.activeId = record.id;
        return record;
    }

    async save(record: ChatRecord): Promise<void> {
        record.updatedAt = Date.now();
        this.cache.set(record.id, record);
        this.upsertMeta(record);
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(this.chatFile(record.id), JSON.stringify(record), "utf8");
        await this.writeIndex();
    }

    setActive(id: string): void {
        this.index.activeId = id;
    }

    async rememberActive(): Promise<void> {
        await this.writeIndex();
    }

    async remove(id: string): Promise<void> {
        const safe = safeId(id);
        this.cache.delete(safe);
        this.index.chats = this.index.chats.filter((item) => item.id !== safe);
        if (this.index.activeId === safe) {
            this.index.activeId = this.index.chats[0]?.id ?? "";
        }
        await fs.rm(this.chatFile(safe), { force: true });
        await this.writeIndex();
    }

    private upsertMeta(record: ChatRecord): void {
        const meta = metaFromRecord(record);
        const index = this.index.chats.findIndex((item) => item.id === record.id);
        if (index >= 0) {
            this.index.chats[index] = meta;
        } else {
            this.index.chats.unshift(meta);
        }
    }

    private async writeIndex(): Promise<void> {
        await fs.writeFile(this.indexFile(), JSON.stringify(this.index), "utf8");
    }

    private indexFile(): string {
        return path.join(this.root, "index.json");
    }

    private chatFile(id: string): string {
        return path.join(this.root, `${safeId(id)}.json`);
    }
}

function metaFromRecord(record: ChatRecord): ChatMeta {
    const msgs = Array.isArray(record.messages) ? record.messages : [];
    const dialogue = msgs.filter((m) => m.role === "user" || m.role === "assistant");
    const lastUser = [...msgs].reverse().find((m) => m.role === "user" && m.text.trim());
    const fallback = msgs.find((m) => (m.role === "user" || m.role === "assistant") && m.text.trim());
    const rawPreview = (lastUser?.text || fallback?.text || "").replace(/\s+/g, " ").trim();
    const preview = rawPreview.length > 72 ? `${rawPreview.slice(0, 72)}...` : rawPreview;
    const tokenTotal = record.tokenStats?.total?.totalTokens || record.tokenStats?.contextUsed || 0;
    return {
        id: record.id,
        title: record.title,
        updatedAt: record.updatedAt,
        imported: record.imported,
        acpSessionId: record.acpSessionId,
        count: dialogue.length,
        preview,
        totalTokens: tokenTotal > 0 ? tokenTotal : undefined,
    };
}

function safeId(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new Error("无效的对话编号");
    }
    return id;
}

export function blankMessage(role: StoredMessage["role"], text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
    return { id: randomUUID(), role, text, ...extra };
}
