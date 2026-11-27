import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { FrameDecoder } from "./framer";
import { asRecord } from "../util";

export class RpcError extends Error {
    constructor(readonly code: number, message: string, readonly data?: unknown) {
        super(message);
    }
}

const AUTH_MESSAGE_RE = /authentication required|auth_required|unauthenticated|not logged in|login required|sign in required|需要登录|请登录/i;
const NON_AUTH_MESSAGE_RE = /timeout|timed out|deadline exceeded|econn|enotfound|eai_again|etimedout|proxy|connectex|connection refused|network|tls|certificate|socket|eof|closed|rate limit|quota|resource exhausted|not found|invalid params/i;

export function isAuthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_MESSAGE_RE.test(message)) {
        return true;
    }
    if (error instanceof RpcError && (error.code === -32000 || error.code === -32001)) {
        return !NON_AUTH_MESSAGE_RE.test(message);
    }
    return false;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

export interface ConnectionOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onStderr?: (text: string) => void;
    onProtocolError?: (text: string) => void;
}

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;
type ExitHandler = (code: number | null) => void;

export class AcpConnection {
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, Pending>();
    private readonly decoder: FrameDecoder;
    private nextId = 1;
    private closed = false;
    private reportedExit = false;
    private requestHandler: RequestHandler = async (method) => {
        throw new RpcError(-32601, `未实现的客户端方法 ${method}`);
    };
    private notificationHandler: NotificationHandler = () => undefined;
    private exitHandler: ExitHandler = () => undefined;

    constructor(binary: string, args: string[], options: ConnectionOptions) {
        this.decoder = new FrameDecoder(options.onProtocolError);
        this.proc = spawn(binary, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        this.proc.stdout.on("data", (chunk: Buffer) => {
            for (const message of this.decoder.push(chunk)) {
                this.dispatch(message);
            }
        });
        this.proc.stderr.on("data", (chunk: Buffer) => {
            options.onStderr?.(chunk.toString("utf8"));
        });
        this.proc.stdin.on("error", () => undefined);
        this.proc.on("error", (error) => {
            this.reportExit(null, error);
        });
        this.proc.on("exit", (code) => {
            this.reportExit(code, new Error(`反重力进程已退出 (${code ?? "未知"})`));
        });
    }

    setRequestHandler(handler: RequestHandler): void {
        this.requestHandler = handler;
    }

    setNotificationHandler(handler: NotificationHandler): void {
        this.notificationHandler = handler;
    }

    setExitHandler(handler: ExitHandler): void {
        this.exitHandler = handler;
    }

    request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
        const id = this.nextId;
        this.nextId += 1;
        return new Promise<T>((resolve, reject) => {
            const timer = timeoutMs
                ? setTimeout(() => {
                    if (this.pending.delete(id)) {
                        reject(new Error(`${method} 超时`));
                    }
                }, timeoutMs)
                : undefined;
            this.pending.set(id, {
                resolve: (value) => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    resolve(value as T);
                },
                reject: (error) => {
                    if (timer) {
                        clearTimeout(timer);
                    }
                    reject(error);
                },
            });
            try {
                this.send({ jsonrpc: "2.0", id, method, params });
            } catch (error) {
                this.pending.delete(id);
                if (timer) {
                    clearTimeout(timer);
                }
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    notify(method: string, params: unknown): void {
        this.send({ jsonrpc: "2.0", method, params });
    }

    dispose(): void {
        const pid = this.proc.pid;
        this.fail(new Error("连接已关闭"));
        if (process.platform === "win32" && pid) {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", detached: false });
            return;
        }
        if (pid && process.platform !== "win32") {
            try {
                process.kill(-pid, "SIGTERM");
                return;
            } catch {
                this.proc.kill("SIGTERM");
                return;
            }
        }
        this.proc.kill();
    }

    private dispatch(message: unknown): void {
        const record = asRecord(message);
        if (record.method && record.id !== undefined && record.id !== null) {
            void this.answer(record.id, String(record.method), record.params);
            return;
        }
        if (record.method) {
            this.notificationHandler(String(record.method), record.params);
            return;
        }
        if (record.id === undefined || record.id === null) {
            return;
        }
        const pending = this.pending.get(Number(record.id));
        if (!pending) {
            return;
        }
        this.pending.delete(Number(record.id));
        if (record.error) {
            const error = asRecord(record.error);
            const rawCode = error.code;
            const code = typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : -32603;
            pending.reject(new RpcError(code, String(error.message ?? "ACP 请求失败"), error.data));
            return;
        }
        pending.resolve(record.result);
    }

    private async answer(id: unknown, method: string, params: unknown): Promise<void> {
        try {
            const result = await this.requestHandler(method, params);
            this.send({ jsonrpc: "2.0", id, result: result ?? {} });
        } catch (error) {
            const rpc = error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error));
            this.send({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message, data: rpc.data } });
        }
    }

    private send(payload: unknown): void {
        if (this.closed || !this.proc.stdin.writable) {
            throw new Error("反重力进程已关闭");
        }
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    private reportExit(code: number | null, error: Error): void {
        this.fail(error);
        if (this.reportedExit) {
            return;
        }
        this.reportedExit = true;
        this.exitHandler(code);
    }

    private fail(error: Error): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}
