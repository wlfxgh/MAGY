import { asRecord, clip } from "../util";

export interface TranscriptMessage {
    role: "user" | "assistant" | "tool" | "thought" | "system";
    text: string;
    title?: string;
}

export function titleFrom(text: string): string {
    const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "";
    const clean = line.replace(/^#+\s*/, "");
    if (!clean) {
        return "未命名对话";
    }
    return clean.length > 32 ? `${clean.slice(0, 32)}…` : clean;
}

export function cleanUserText(text: string): string {
    const matched = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);
    const body = matched ? matched[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "");
    return body.trim();
}

export function lexicalText(value: unknown): string {
    let current = value;
    if (typeof current === "string") {
        const trimmed = current.trim();
        if (!trimmed) {
            return "";
        }
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                current = JSON.parse(trimmed) as unknown;
            } catch {
                return trimmed;
            }
        } else {
            return trimmed;
        }
    }
    const parts: string[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") {
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item);
            }
            return;
        }
        const record = node as Record<string, unknown>;
        if (typeof record.text === "string") {
            parts.push(record.text);
        }
        if (Array.isArray(record.children)) {
            walk(record.children);
        } else if (record.root) {
            walk(record.root);
        }
    };
    walk(current);
    return parts.join("");
}

export function parseTranscript(raw: string): TranscriptMessage[] {
    const messages: TranscriptMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        let value: unknown;
        try {
            value = JSON.parse(trimmed) as unknown;
        } catch {
            continue;
        }
        messages.push(...messagesFromTranscriptRecord(value));
    }
    return messages.filter((message) => message.text.trim());
}

export function messagesFromComposer(data: unknown, bubbles: ReadonlyMap<string, unknown>): TranscriptMessage[] {
    const record = asRecord(data);
    const headers = Array.isArray(record.fullConversationHeadersOnly) ? record.fullConversationHeadersOnly : [];
    const stored = asRecord(record.conversationMap);
    const messages: TranscriptMessage[] = [];
    const seen = new Set<string>();
    const consume = (id: string): void => {
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        const bubble = bubbles.get(id) ?? stored[id];
        if (bubble) {
            messages.push(...messagesFromBubble(bubble));
        }
    };
    if (headers.length) {
        for (const header of headers) {
            consume(String(asRecord(header).bubbleId ?? ""));
        }
        return messages;
    }
    for (const id of Object.keys(stored)) {
        consume(id);
    }
    for (const id of bubbles.keys()) {
        consume(id);
    }
    return messages;
}

export function buildContinuation(title: string, messages: readonly TranscriptMessage[], budget = 60000): string {
    const blocks: string[] = [];
    let used = 0;
    let included = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message.text.trim()) {
            continue;
        }
        const heading = message.role === "tool" && message.title ? `工具 ${message.title}` : roleLabel(message.role);
        const limit = message.role === "tool" || message.role === "thought" ? 1500 : 8000;
        const block = `## ${heading}\n${clip(message.text.trim(), limit)}`;
        if (blocks.length && used + block.length > budget) {
            break;
        }
        blocks.push(block);
        used += block.length;
        included += 1;
    }
    blocks.reverse();
    const omitted = Math.max(messages.length - included, 0);
    const head = [
        `以下是从 Cursor 导入的既有对话，标题为「${title || "未命名对话"}」。请把这些内容当作已经发生的上下文，在此基础上继续，不要重复已经完成的工作。`,
    ];
    if (omitted > 0) {
        head.push(`（较早的 ${omitted} 条消息已省略）`);
    }
    return `${head.join("\n")}\n\n${blocks.join("\n\n")}`;
}

function messagesFromTranscriptRecord(value: unknown): TranscriptMessage[] {
    const record = asRecord(value);
    if (record.type === "turn_ended") {
        return [];
    }
    const role = record.role === "user" || record.role === "assistant" ? record.role : "";
    if (!role) {
        return [];
    }
    const message = asRecord(record.message);
    const content = message.content ?? record.content;
    const blocks = Array.isArray(content)
        ? content
        : typeof content === "string"
            ? [{ type: "text", text: content }]
            : typeof record.text === "string"
                ? [{ type: "text", text: record.text }]
                : [];
    const messages: TranscriptMessage[] = [];
    let text = "";
    const flush = (): void => {
        if (!text.trim()) {
            text = "";
            return;
        }
        messages.push(role === "user"
            ? { role: "user", text: cleanUserText(text) }
            : { role: "assistant", text: text.trim() });
        text = "";
    };
    for (const block of blocks) {
        const item = asRecord(block);
        const blockType = String(item.type ?? "text");
        if (blockType === "text" || blockType === "") {
            const piece = typeof item.text === "string" ? item.text : "";
            text = text ? `${text}\n${piece}` : piece;
            continue;
        }
        flush();
        if (blockType === "tool_use" || blockType === "tool_call") {
            const name = String(item.name ?? "工具");
            messages.push({ role: "tool", title: name, text: summarizeUnknown(item.input ?? item.arguments ?? item.parameters) || name });
        } else if (blockType === "thinking") {
            const thought = typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
            if (thought.trim()) {
                messages.push({ role: "thought", title: "思考", text: thought.trim() });
            }
        }
    }
    flush();
    return messages;
}

function messagesFromBubble(value: unknown): TranscriptMessage[] {
    const bubble = asRecord(value);
    const type = Number(bubble.type);
    if (type === 1) {
        const text = cleanUserText(firstText(bubble.text, bubble.rawText) || lexicalText(bubble.richText));
        return text ? [{ role: "user", text }] : [];
    }
    const messages: TranscriptMessage[] = [];
    const thought = thinkingText(bubble);
    if (thought.trim()) {
        messages.push({ role: "thought", title: "思考", text: thought.trim() });
    }
    const text = assistantText(bubble);
    if (text.trim()) {
        messages.push({ role: "assistant", text: text.trim() });
    }
    const tool = asRecord(bubble.toolFormerData);
    if (Object.keys(tool).length) {
        const name = String(tool.name ?? tool.tool ?? "工具");
        messages.push({ role: "tool", title: name, text: summarizeTool(tool) || name });
    }
    return messages;
}

function assistantText(bubble: Record<string, unknown>): string {
    const direct = firstText(bubble.text, bubble.rawText);
    if (direct.trim()) {
        return direct;
    }
    if (!Array.isArray(bubble.codeBlocks)) {
        return "";
    }
    return bubble.codeBlocks.map((block) => {
        const record = asRecord(block);
        return firstText(record.code, record.content, record.text);
    }).filter(Boolean).join("\n\n");
}

function thinkingText(bubble: Record<string, unknown>): string {
    const thinking = bubble.thinking;
    if (typeof thinking === "string") {
        return thinking;
    }
    const record = asRecord(thinking);
    if (typeof record.text === "string") {
        return record.text;
    }
    if (!Array.isArray(bubble.allThinkingBlocks)) {
        return "";
    }
    return bubble.allThinkingBlocks.map((block) => {
        if (typeof block === "string") {
            return block;
        }
        return typeof asRecord(block).text === "string" ? String(asRecord(block).text) : "";
    }).filter(Boolean).join("\n");
}

function summarizeTool(tool: Record<string, unknown>): string {
    const input = summarizeUnknown(tool.params ?? tool.rawArgs ?? tool.arguments ?? tool.args);
    const result = summarizeUnknown(tool.result ?? tool.output);
    if (input && result) {
        return `${input}\n${clip(result, 500)}`;
    }
    return input || result;
}

function summarizeUnknown(value: unknown): string {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return "";
        }
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                return summarizeUnknown(JSON.parse(trimmed) as unknown);
            } catch {
                return clip(trimmed, 500);
            }
        }
        return clip(trimmed, 500);
    }
    const record = asRecord(value);
    const command = record.command ?? record.cmd;
    if (typeof command === "string") {
        return command;
    }
    const file = record.path ?? record.file_path ?? record.target_file ?? record.relativeWorkspacePath ?? record.file;
    if (typeof file === "string") {
        return file;
    }
    const query = record.query ?? record.pattern ?? record.glob_pattern ?? record.prompt;
    if (typeof query === "string") {
        return clip(query, 500);
    }
    const keys = Object.keys(record);
    return keys.length ? clip(JSON.stringify(record), 500) : "";
}

function firstText(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value;
        }
    }
    return "";
}

function roleLabel(role: TranscriptMessage["role"]): string {
    switch (role) {
        case "user":
            return "用户";
        case "assistant":
            return "助手";
        case "tool":
            return "工具";
        case "thought":
            return "思考";
        default:
            return "说明";
    }
}
