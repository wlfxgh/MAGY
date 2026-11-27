import type { CodeAttachment } from "./types";

export function displayLineRange(startLine: number, endLine: number, endCharacter: number): { startLine: number; endLine: number } {
    const start = startLine + 1;
    const end = endCharacter === 0 ? Math.max(start, endLine) : endLine + 1;
    return { startLine: start, endLine: Math.max(start, end) };
}

export function formatAttachedPrompt(text: string, attachments: readonly CodeAttachment[]): string {
    const body = text.trim();
    if (!attachments.length) {
        return body;
    }
    const blocks = attachments.map((item) => {
        if (item.kind === "directory") {
            return `目录路径 \`${item.relativePath}\``;
        }
        if (item.kind === "file" || (!item.startLine && !item.text)) {
            return `文件路径 \`${item.relativePath}\``;
        }
        const range = item.startLine === item.endLine ? `第 ${item.startLine} 行` : `第 ${item.startLine}–${item.endLine} 行`;
        const language = item.languageId && item.languageId !== "plaintext" ? item.languageId : "";
        return `文件 \`${item.relativePath}\` ${range}\n\`\`\`${language}\n${item.text.replace(/\s+$/, "")}\n\`\`\``;
    }).join("\n\n");
    return body ? `${blocks}\n\n${body}` : blocks;
}
