import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createAbortError, downloadVerified, fetchManifest, isAbortError } from "./download";
import { errorMessage, redactProxy } from "../util";

export interface RuntimeInfo {
    binary: string;
    version: string;
    managed: boolean;
}

export interface EnsureOptions {
    proxy?: string;
    noProxy?: string;
    binaryPath?: string;
    force?: boolean;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
}

export class AgyRuntime {
    private tail: Promise<unknown> = Promise.resolve();

    constructor(private readonly root: string, private readonly log: (line: string) => void) {}

    ensure(options: EnsureOptions): Promise<RuntimeInfo> {
        const run = this.tail.then(() => this.ensureInner(options));
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }

    async inspectInstalled(binaryPath?: string): Promise<RuntimeInfo | undefined> {
        if (binaryPath) {
            return (await exists(binaryPath))
                ? { binary: binaryPath, version: "自定义", managed: false }
                : undefined;
        }
        const binary = this.binaryPath();
        if (!(await exists(binary))) {
            return undefined;
        }
        const version = (await readText(path.join(this.root, "VERSION"))) || "未知";
        return { binary, version, managed: true };
    }

    private async ensureInner(options: EnsureOptions): Promise<RuntimeInfo> {
        if (options.signal?.aborted) {
            throw createAbortError();
        }
        const lead = options.proxy ? "正在通过代理" : "正在";
        if (options.proxy) {
            this.log(`网络代理：${redactProxy(options.proxy)}`);
        }
        if (options.binaryPath) {
            await fs.access(options.binaryPath);
            this.log(`使用指定的反重力：${options.binaryPath}`);
            return { binary: options.binaryPath, version: "自定义", managed: false };
        }
        const binary = this.binaryPath();
        const versionFile = path.join(this.root, "VERSION");
        if (!options.force && await exists(binary)) {
            const version = (await readText(versionFile)) || "未知";
            this.log(`使用插件目录中的反重力 ${version}：${binary}`);
            return { binary, version, managed: true };
        }
        options.onProgress?.(`${lead}获取反重力版本`);
        const manifest = await fetchManifest({ proxy: options.proxy, noProxy: options.noProxy, signal: options.signal });
        if (options.signal?.aborted) {
            throw createAbortError();
        }
        options.onProgress?.(`${lead}下载反重力 ${manifest.version}`);
        await fs.mkdir(path.dirname(binary), { recursive: true });
        const staging = `${binary}.download`;
        await downloadVerified(manifest.url, staging, manifest.sha512, {
            proxy: options.proxy,
            noProxy: options.noProxy,
            signal: options.signal,
            onProgress: (received, total) => {
                const percent = total ? ` ${Math.min(100, Math.round((received / total) * 100))}%` : "";
                options.onProgress?.(`${lead}下载反重力 ${manifest.version}${percent}`);
            },
        });
        try {
            if (options.signal?.aborted) {
                throw createAbortError();
            }
            if (await isGzip(staging)) {
                const extracted = await extractBinary(staging, path.dirname(binary));
                await replaceFile(extracted, binary);
                await fs.rm(staging, { force: true });
            } else {
                await replaceFile(staging, binary);
            }
            if (process.platform !== "win32") {
                await fs.chmod(binary, 0o755);
            }
            await fs.writeFile(versionFile, manifest.version, "utf8");
        } catch (error) {
            await fs.rm(staging, { force: true });
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(errorMessage(error));
        }
        this.log(`已安装反重力 ${manifest.version}：${binary}`);
        return { binary, version: manifest.version, managed: true };
    }

    private binaryPath(): string {
        return path.join(this.root, "bin", process.platform === "win32" ? "agy.exe" : "agy");
    }
}

async function extractBinary(archive: string, directory: string): Promise<string> {
    const extractDir = path.join(directory, ".extract");
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
    try {
        await run(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", archive, "-C", extractDir]);
        const names = await fs.readdir(extractDir);
        const found = names.find((name) => name === "agy" || name === "agy.exe" || name === "antigravity");
        if (!found) {
            throw new Error("安装包中没有找到反重力可执行文件");
        }
        const stagedOut = path.join(directory, `${found}.new`);
        await replaceFile(path.join(extractDir, found), stagedOut);
        return stagedOut;
    } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
    }
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, detached: false });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `${command} 退出码 ${code ?? "未知"}`));
        });
    });
}

async function isGzip(file: string): Promise<boolean> {
    const handle = await fs.open(file, "r");
    try {
        const buffer = Buffer.alloc(2);
        await handle.read(buffer, 0, 2, 0);
        return buffer[0] === 0x1f && buffer[1] === 0x8b;
    } finally {
        await handle.close();
    }
}

async function replaceFile(from: string, to: string): Promise<void> {
    if (path.resolve(from) === path.resolve(to)) {
        return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            await fs.rm(to, { force: true });
            try {
                await fs.rename(from, to);
            } catch {
                await fs.copyFile(from, to);
                await fs.rm(from, { force: true });
            }
            return;
        } catch (error) {
            lastError = error;
            const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
            if (attempt === 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    if (lastError) {
        throw lastError;
    }
}

async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

async function readText(file: string): Promise<string> {
    try {
        return (await fs.readFile(file, "utf8")).trim();
    } catch {
        return "";
    }
}
