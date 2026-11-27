export class FrameDecoder {
    private buffer = Buffer.alloc(0);

    constructor(private readonly onError?: (message: string) => void) {}

    push(chunk: Buffer): unknown[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: unknown[] = [];
        while (this.buffer.length > 0) {
            if (this.buffer.length > 32 * 1024 * 1024) {
                this.buffer = Buffer.alloc(0);
                this.onError?.("ACP 消息超过 32MB，已丢弃");
                break;
            }
            const skipped = skipSpace(this.buffer);
            if (skipped > 0) {
                this.buffer = this.buffer.subarray(skipped);
                continue;
            }
            if (this.buffer[0] === 0x7b) {
                const newline = this.buffer.indexOf(0x0a);
                if (newline < 0) {
                    break;
                }
                const line = this.buffer.subarray(0, newline).toString("utf8").trim();
                this.buffer = this.buffer.subarray(newline + 1);
                if (!line) {
                    continue;
                }
                try {
                    messages.push(JSON.parse(line) as unknown);
                } catch (error) {
                    this.onError?.(`忽略无法解析的 ACP 行：${error instanceof Error ? error.message : String(error)}`);
                }
                continue;
            }
            const headerEnd = indexOf(this.buffer, "\r\n\r\n");
            const headerText = headerEnd >= 0 ? this.buffer.subarray(0, headerEnd).toString("utf8") : "";
            const length = /content-length:\s*(\d+)/i.exec(headerText);
            if (headerEnd < 0 || !length) {
                const newline = this.buffer.indexOf(0x0a);
                if (newline < 0) {
                    break;
                }
                this.buffer = this.buffer.subarray(newline + 1);
                continue;
            }
            const start = headerEnd + 4;
            const size = Number(length[1]);
            if (this.buffer.length < start + size) {
                break;
            }
            const body = this.buffer.subarray(start, start + size).toString("utf8");
            this.buffer = this.buffer.subarray(start + size);
            try {
                messages.push(JSON.parse(body) as unknown);
            } catch (error) {
                this.onError?.(`忽略无法解析的 ACP 帧：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return messages;
    }
}

function skipSpace(buffer: Buffer): number {
    let index = 0;
    while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x09 || buffer[index] === 0x0d || buffer[index] === 0x0a)) {
        index += 1;
    }
    return index;
}

function indexOf(buffer: Buffer, needle: string): number {
    return buffer.indexOf(needle);
}
