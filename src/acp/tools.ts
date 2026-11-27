import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { asRecord } from "../util";

interface ManagedTerminal {
    proc: ChildProcess;
    output: string;
    truncated: boolean;
    limit: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    done: Promise<void>;
}

export class ClientTools {
    private readonly terminals = new Map<string, ManagedTerminal>();

    constructor(private readonly roots: () => string[]) {}

    async handle(method: string, params: unknown): Promise<unknown> {
        const record = asRecord(params);
        switch (method) {
            case "fs/read_text_file":
                return this.readFile(record);
            case "fs/write_text_file":
                return this.writeFile(record);
            case "terminal/create":
                return this.createTerminal(record);
            case "terminal/output":
                return this.terminalOutput(record);
            case "terminal/wait_for_exit":
                return this.waitForExit(record);
            case "terminal/kill":
                return this.killTerminal(record, false);
            case "terminal/release":
                return this.killTerminal(record, true);
            default:
                throw new Error(`未实现的客户端方法 ${method}`);
        }
    }

    dispose(): void {
        for (const terminal of this.terminals.values()) {
            killProcessTree(terminal.proc);
        }
        this.terminals.clear();
    }

    private async readFile(params: Record<string, unknown>): Promise<{ content: string }> {
        const filePath = requiredPath(params.path);
        const raw = await fs.readFile(filePath);
        let text = raw.toString("utf8");
        const hasLine = params.line !== undefined && params.line !== null;
        const hasLimit = params.limit !== undefined && params.limit !== null;
        if (hasLine || hasLimit) {
            const lines = text.split(/\r?\n/);
            const start = Math.max(Number(hasLine ? params.line : 1) - 1, 0);
            const limit = hasLimit ? Number(params.limit) : lines.length;
            text = lines.slice(start, start + Math.max(limit, 0)).join("\n");
        }
        if (text.length > 1_000_000) {
            text = text.slice(0, 1_000_000);
        }
        return { content: text };
    }

    private async writeFile(params: Record<string, unknown>): Promise<Record<string, never>> {
        this.assertTrusted();
        const filePath = requiredPath(params.path);
        this.assertAllowed(filePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, String(params.content ?? ""), "utf8");
        return {};
    }

    private createTerminal(params: Record<string, unknown>): { terminalId: string } {
        this.assertTrusted();
        const command = String(params.command ?? "");
        if (!command) {
            throw new Error("缺少要执行的命令");
        }
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : this.roots()[0];
        if (!cwd) {
            throw new Error("没有可执行命令的工作目录");
        }
        this.assertAllowed(cwd);
        const args = Array.isArray(params.args) ? params.args.map((item) => String(item)) : [];
        const env = { ...process.env };
        if (Array.isArray(params.env)) {
            for (const item of params.env) {
                const record = asRecord(item);
                if (typeof record.name === "string") {
                    env[record.name] = String(record.value ?? "");
                }
            }
        }
        const proc = spawn(command, args, {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const terminal: ManagedTerminal = {
            proc,
            output: "",
            truncated: false,
            limit: Math.max(Number(params.outputByteLimit ?? 1024 * 1024) || 1024 * 1024, 1024),
            exitCode: null,
            signal: null,
            done: Promise.resolve(),
        };
        terminal.done = new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            const append = (chunk: Buffer) => this.appendOutput(terminal, chunk.toString("utf8"));
            proc.stdout?.on("data", append);
            proc.stderr?.on("data", append);
            proc.on("error", (error) => {
                this.appendOutput(terminal, `${error.message}\n`);
                if (terminal.exitCode === null) {
                    terminal.exitCode = -1;
                }
                finish();
            });
            proc.on("exit", (code, signal) => {
                terminal.exitCode = code;
                terminal.signal = signal;
                finish();
            });
        });
        const terminalId = randomUUID();
        this.terminals.set(terminalId, terminal);
        return { terminalId };
    }

    private terminalOutput(params: Record<string, unknown>): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } {
        const terminal = this.requireTerminal(params.terminalId);
        return {
            output: terminal.output,
            truncated: terminal.truncated,
            exitStatus: terminal.exitCode === null && terminal.signal === null && terminal.proc.exitCode === null
                ? null
                : { exitCode: terminal.exitCode, signal: terminal.signal },
        };
    }

    private async waitForExit(params: Record<string, unknown>): Promise<{ exitCode: number | null; signal: string | null }> {
        const terminal = this.requireTerminal(params.terminalId);
        await terminal.done;
        return { exitCode: terminal.exitCode, signal: terminal.signal };
    }

    private async killTerminal(params: Record<string, unknown>, release: boolean): Promise<Record<string, never>> {
        const id = String(params.terminalId ?? "");
        const terminal = this.requireTerminal(id);
        if (terminal.proc.exitCode === null) {
            killProcessTree(terminal.proc);
        }
        if (release) {
            await terminal.done.catch(() => undefined);
            this.terminals.delete(id);
        }
        return {};
    }

    private appendOutput(terminal: ManagedTerminal, chunk: string): void {
        terminal.output += chunk;
        const bytes = Buffer.byteLength(terminal.output);
        if (bytes <= terminal.limit) {
            return;
        }
        const buf = Buffer.from(terminal.output);
        let start = buf.length - terminal.limit;
        while (start < buf.length && (buf[start] & 0b11000000) === 0b10000000) {
            start += 1;
        }
        terminal.output = buf.subarray(start).toString("utf8");
        terminal.truncated = true;
    }

    private requireTerminal(id: unknown): ManagedTerminal {
        const terminal = this.terminals.get(String(id ?? ""));
        if (!terminal) {
            throw new Error("终端不存在或已释放");
        }
        return terminal;
    }

    private assertTrusted(): void {
        if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0 && vscode.workspace.isTrusted === false) {
            throw new Error("工作区未受信任，已拒绝执行");
        }
    }

    private assertAllowed(target: string): void {
        const roots = this.roots();
        const full = path.resolve(target);
        const allowed = roots.some((root) => {
            const base = path.resolve(root);
            const relative = path.relative(base, full);
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        });
        if (!allowed) {
            throw new Error("路径超出当前工作区");
        }
    }
}

function requiredPath(value: unknown): string {
    const filePath = String(value ?? "");
    if (!filePath) {
        throw new Error("缺少文件路径");
    }
    return filePath;
}

function killProcessTree(proc: ChildProcess): void {
    const pid = proc.pid;
    if (process.platform === "win32" && pid) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", detached: false });
        return;
    }
    proc.kill();
}
