import { asRecord, clip } from "../util";
import type { AccountTierView, TokenUsage, ToolDiff } from "../chat/types";

export interface SelectChoice {
    value: string;
    name: string;
    description?: string;
}

export interface AuthChoice {
    id: string;
    name: string;
}

export function contentText(content: unknown): string {
    if (Array.isArray(content)) {
        return content.map((item) => textOfBlock(item)).join("");
    }
    return textOfBlock(content);
}

export function extractDiffs(content: unknown): ToolDiff[] {
    const items = Array.isArray(content) ? content : [content];
    const diffs: ToolDiff[] = [];
    for (const item of items) {
        const record = asRecord(item);
        if (record.type === "diff") {
            diffs.push({
                path: typeof record.path === "string" ? record.path : "文件",
                oldText: typeof record.oldText === "string" ? record.oldText : undefined,
                newText: typeof record.newText === "string" ? record.newText : undefined,
            });
        } else if (record.type === "content" && record.content) {
            diffs.push(...extractDiffs(record.content));
        }
    }
    return diffs;
}

export function flattenOptions(options: unknown): SelectChoice[] {
    if (!Array.isArray(options)) {
        return [];
    }
    const choices: SelectChoice[] = [];
    for (const item of options) {
        const record = asRecord(item);
        if (typeof record.value === "string") {
            const description = typeof record.description === "string" && record.description.trim()
                ? record.description.trim()
                : undefined;
            choices.push({ value: record.value, name: String(record.name ?? record.value), description });
            continue;
        }
        if (Array.isArray(record.options)) {
            choices.push(...flattenOptions(record.options));
        }
    }
    return choices;
}

export function readAuthMethods(value: unknown): AuthChoice[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const methods: AuthChoice[] = [];
    for (const item of value) {
        const record = asRecord(item);
        const id = String(record.id ?? record.methodId ?? "");
        if (!id) {
            continue;
        }
        methods.push({ id, name: String(record.name ?? record.description ?? id) });
    }
    return methods;
}

export function readStopReason(value: unknown): string | undefined {
    const record = asRecord(value);
    if (typeof record.stopReason === "string" && record.stopReason) {
        return record.stopReason;
    }
    const state = asRecord(record.state);
    if (typeof state.stopReason === "string" && state.stopReason) {
        return state.stopReason;
    }
    return undefined;
}

export function emptyTokenUsage(): TokenUsage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
    };
}

export function mergeTokenUsage(acc: TokenUsage, turn: TokenUsage): TokenUsage {
    return {
        inputTokens: acc.inputTokens + turn.inputTokens,
        outputTokens: acc.outputTokens + turn.outputTokens,
        cachedReadTokens: acc.cachedReadTokens + turn.cachedReadTokens,
        cachedWriteTokens: acc.cachedWriteTokens + turn.cachedWriteTokens,
        thoughtTokens: acc.thoughtTokens + turn.thoughtTokens,
        totalTokens: acc.totalTokens + turn.totalTokens,
    };
}

export function readPromptUsage(value: unknown): TokenUsage | undefined {
    const raw = asRecord(asRecord(value).usage);
    const inputTokens = readTokenField(raw, "inputTokens", "input_tokens");
    const outputTokens = readTokenField(raw, "outputTokens", "output_tokens");
    const cachedReadTokens = readTokenField(raw, "cachedReadTokens", "cached_read_tokens", "cache_read_tokens");
    const cachedWriteTokens = readTokenField(raw, "cachedWriteTokens", "cached_write_tokens", "cache_write_tokens");
    const thoughtTokens = readTokenField(raw, "thoughtTokens", "thought_tokens", "thinking_tokens");
    let totalTokens = readTokenField(raw, "totalTokens", "total_tokens");
    if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
        totalTokens = inputTokens + outputTokens;
    }
    if (
        inputTokens === 0
        && outputTokens === 0
        && cachedReadTokens === 0
        && cachedWriteTokens === 0
        && thoughtTokens === 0
        && totalTokens === 0
    ) {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        thoughtTokens,
        totalTokens,
    };
}

export function readAntigravityTier(value: unknown): AccountTierView | undefined {
    const tier = asRecord(asRecord(asRecord(value)._meta).antigravity).tier;
    const record = asRecord(tier);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!id && !name) {
        return undefined;
    }
    const upgradeUri = typeof record.upgradeUri === "string" && record.upgradeUri.trim()
        ? record.upgradeUri.trim()
        : undefined;
    return {
        id: id || name,
        name: name || id,
        upgradeUri,
    };
}

function readTokenField(record: Record<string, unknown>, ...keys: string[]): number {
    for (const key of keys) {
        const val = record[key];
        if (typeof val === "number" && Number.isFinite(val) && val > 0) {
            return Math.round(val);
        }
    }
    return 0;
}

function textOfBlock(block: unknown): string {
    const record = asRecord(block);
    if (typeof record.text === "string" && (record.type === "text" || record.type === undefined)) {
        return record.text;
    }
    if (record.type === "image") {
        return "\n[图片]\n";
    }
    if (record.type === "audio") {
        return "\n[音频]\n";
    }
    if (record.type === "resource" || record.type === "resource_link") {
        const resource = asRecord(record.resource);
        if (typeof resource.text === "string") {
            return resource.text;
        }
        const uri = resource.uri ?? record.uri;
        return typeof uri === "string" ? `\n${uri}\n` : "";
    }
    if (record.type === "content") {
        return textOfBlock(record.content);
    }
    if (record.type === "diff") {
        const file = typeof record.path === "string" ? record.path : "文件";
        const preview = typeof record.newText === "string" ? record.newText : typeof record.oldText === "string" ? record.oldText : "";
        return preview ? `\n编辑 ${file}\n${clip(preview, 1500)}` : `\n编辑 ${file}\n`;
    }
    return "";
}
