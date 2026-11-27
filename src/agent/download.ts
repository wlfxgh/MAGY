import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { Duplex, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tls from "node:tls";
import { bypassesProxy, errorMessage } from "../util";

export interface DownloadOptions {
    proxy?: string;
    noProxy?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (received: number, total?: number) => void;
}

export function createAbortError(message = "操作已取消"): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

const MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const USER_AGENT = "magy";

export interface AgypManifest {
    version: string;
    url: string;
    sha512: string;
}

export function agyPlatform(): string {
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
    if (!arch) {
        throw new Error(`当前架构 ${process.arch} 没有对应的反重力构建`);
    }
    if (process.platform === "win32") {
        return `windows_${arch}`;
    }
    if (process.platform === "darwin") {
        return `darwin_${arch}`;
    }
    if (process.platform === "linux") {
        const musl = fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1");
        return musl ? `linux_${arch}_musl` : `linux_${arch}`;
    }
    throw new Error(`当前系统 ${process.platform} 不受支持`);
}

export function manifestUrl(platform = agyPlatform()): string {
    return `${MANIFEST_BASE}/${platform}.json`;
}

export async function fetchManifest(options: DownloadOptions = {}): Promise<AgypManifest> {
    const body = await fetchText(manifestUrl(), {
        ...options,
        timeoutMs: options.timeoutMs ?? 20_000,
    });
    const parsed = JSON.parse(body) as Partial<AgypManifest>;
    if (!parsed.url || !parsed.sha512 || !parsed.version) {
        throw new Error("反重力发布清单缺少版本、地址或校验值");
    }
    return { version: parsed.version, url: parsed.url, sha512: parsed.sha512 };
}

export async function downloadVerified(url: string, dest: string, sha512: string, options: DownloadOptions): Promise<void> {
    if (options.signal?.aborted) {
        throw createAbortError();
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const partial = `${dest}.partial`;
    let lastError = "";
    for (const attempt of downloadAttempts(options)) {
        if (options.signal?.aborted) {
            throw createAbortError();
        }
        try {
            await fsp.rm(partial, { force: true });
            await attempt(url, partial, options);
            if (options.signal?.aborted) {
                throw createAbortError();
            }
            const actual = await sha512File(partial);
            if (actual.toLowerCase() !== sha512.toLowerCase()) {
                throw new Error("反重力安装包校验失败");
            }
            await moveFile(partial, dest);
            return;
        } catch (error) {
            await fsp.rm(partial, { force: true });
            if (isAbortError(error) || options.signal?.aborted) {
                throw createAbortError();
            }
            lastError = errorMessage(error);
        }
    }
    throw new Error(lastError || "反重力下载失败");
}

export async function sha512File(file: string): Promise<string> {
    const hash = createHash("sha512");
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

function downloadAttempts(options: DownloadOptions): Array<(url: string, dest: string, options: DownloadOptions) => Promise<void>> {
    const attempts: Array<(url: string, dest: string, options: DownloadOptions) => Promise<void>> = [
        downloadWithNode,
        downloadWithCurl,
    ];
    if (options.proxy && !/^https?:\/\//i.test(options.proxy)) {
        attempts.shift();
    }
    return attempts;
}

async function fetchText(url: string, options: DownloadOptions): Promise<string> {
    if (options.signal?.aborted) {
        throw createAbortError();
    }
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "magy-manifest-")), "manifest.json");
    try {
        let lastError = "";
        for (const attempt of downloadAttempts(options)) {
            if (options.signal?.aborted) {
                throw createAbortError();
            }
            try {
                await fsp.rm(file, { force: true });
                await attempt(url, file, options);
                return await fsp.readFile(file, "utf8");
            } catch (error) {
                if (isAbortError(error) || options.signal?.aborted) {
                    throw createAbortError();
                }
                lastError = errorMessage(error);
            }
        }
        throw new Error(lastError || "反重力发布清单下载失败");
    } finally {
        await fsp.rm(path.dirname(file), { recursive: true, force: true });
    }
}

async function downloadWithNode(url: string, dest: string, options: DownloadOptions, redirects = 5): Promise<void> {
    if (options.signal?.aborted) {
        throw createAbortError();
    }
    const target = new URL(url);
    const response = await request(target, options);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects <= 0) {
            throw new Error("下载重定向失败");
        }
        await downloadWithNode(new URL(location, target).href, dest, options, redirects - 1);
        return;
    }
    if (status !== 200) {
        response.resume();
        throw new Error(`下载失败 (${status || "未知"})`);
    }
    const total = Number(response.headers["content-length"] ?? 0) || undefined;
    if (total && total > 300 * 1024 * 1024) {
        response.resume();
        throw new Error("反重力安装包过大");
    }
    let received = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            options.onProgress?.(received, total);
            callback(null, chunk);
        },
    });
    try {
        await pipeline(response, counter, fs.createWriteStream(dest), options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) {
            throw createAbortError();
        }
        throw error;
    }
}

function wireRequestAbort(
    signal: AbortSignal | undefined,
    cancel: () => void,
    reject: (error: Error) => void,
): () => void {
    if (!signal) {
        return () => undefined;
    }
    const onAbort = (): void => {
        cancel();
        reject(createAbortError());
    };
    if (signal.aborted) {
        queueMicrotask(onAbort);
        return () => undefined;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}

function request(target: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
    const proxy = options.proxy && !bypassesProxy(target.hostname, options.noProxy ?? "") ? options.proxy : "";
    if (!proxy) {
        return direct(target, options);
    }
    const proxyUrl = new URL(proxy);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
        return Promise.reject(new Error("该代理协议由 curl 处理"));
    }
    if (target.protocol === "https:") {
        return tunnel(target, proxyUrl, options);
    }
    if (target.protocol === "http:") {
        return forwardHttp(target, proxyUrl, options);
    }
    return Promise.reject(new Error(`不支持的下载协议 ${target.protocol}`));
}

function direct(target: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
    const lib = target.protocol === "http:" ? http : https;
    const timeoutMs = options.timeoutMs ?? 300_000;
    return new Promise((resolve, reject) => {
        let settled = false;
        let cleanup = (): void => undefined;
        const finishResolve = (res: http.IncomingMessage): void => {
            if (settled) {
                res.resume();
                return;
            }
            settled = true;
            cleanup();
            resolve(res);
        };
        const finishReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const req = lib.get(target, {
            headers: { "User-Agent": USER_AGENT },
        }, finishResolve);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("下载超时")));
        req.on("error", finishReject);
        cleanup = wireRequestAbort(options.signal, () => req.destroy(), finishReject);
    });
}

function tunnel(target: URL, proxyUrl: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const agent = new ProxyTunnelAgent(proxyUrl, options.signal, Math.min(timeoutMs, 30_000));
    return new Promise((resolve, reject) => {
        let settled = false;
        let cleanup = (): void => undefined;
        const finishResolve = (res: http.IncomingMessage): void => {
            if (settled) {
                res.resume();
                return;
            }
            settled = true;
            cleanup();
            resolve(res);
        };
        const finishReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const req = https.get(target, {
            agent,
            headers: { "User-Agent": USER_AGENT },
        }, finishResolve);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("下载超时")));
        req.on("error", finishReject);
        cleanup = wireRequestAbort(options.signal, () => {
            agent.destroy();
            req.destroy();
        }, finishReject);
    });
}

function forwardHttp(target: URL, proxyUrl: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
    const lib = proxyUrl.protocol === "https:" ? https : http;
    const timeoutMs = options.timeoutMs ?? 300_000;
    return new Promise((resolve, reject) => {
        let settled = false;
        let cleanup = (): void => undefined;
        const finishResolve = (res: http.IncomingMessage): void => {
            if (settled) {
                res.resume();
                return;
            }
            settled = true;
            cleanup();
            resolve(res);
        };
        const finishReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const req = lib.request({
            protocol: proxyUrl.protocol,
            hostname: proxyUrl.hostname,
            port: proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
            method: "GET",
            path: target.href,
            headers: {
                Host: target.host,
                "User-Agent": USER_AGENT,
                ...proxyAuthorization(proxyUrl),
            },
        }, finishResolve);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("下载超时")));
        req.on("error", finishReject);
        cleanup = wireRequestAbort(options.signal, () => req.destroy(), finishReject);
        req.end();
    });
}

class ProxyTunnelAgent extends https.Agent {
    constructor(
        private readonly proxyUrl: URL,
        private readonly signal?: AbortSignal,
        private readonly connectTimeoutMs = 30_000,
    ) {
        super({ keepAlive: false, maxSockets: 1 });
    }

    override createConnection(
        options: http.ClientRequestArgs,
        callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex | null | undefined {
        const hostname = String(options.hostname || options.host || "").replace(/:\d+$/, "");
        const port = Number(options.port || 443);
        const lib = this.proxyUrl.protocol === "https:" ? https : http;
        let settled = false;
        let cleanup = (): void => undefined;
        let activeSocket: Duplex | undefined;
        const finish = (error: Error | null, socket?: tls.TLSSocket) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback?.(error, (socket ?? undefined) as Duplex);
        };
        const connectReq = lib.request({
            host: this.proxyUrl.hostname,
            port: this.proxyUrl.port || (this.proxyUrl.protocol === "https:" ? 443 : 80),
            method: "CONNECT",
            path: `${hostname}:${port}`,
            headers: {
                Host: `${hostname}:${port}`,
                ...proxyAuthorization(this.proxyUrl),
            },
        });
        cleanup = wireRequestAbort(this.signal, () => {
            connectReq.destroy();
            activeSocket?.destroy();
        }, (error) => finish(error));
        connectReq.setTimeout(this.connectTimeoutMs, () => connectReq.destroy(new Error("代理连接超时")));
        connectReq.once("connect", (response, socket) => {
            activeSocket = socket;
            if (response.statusCode !== 200) {
                socket.destroy();
                finish(new Error(`代理连接失败 (${response.statusCode ?? "未知"})`));
                return;
            }
            const secure = tls.connect({ socket, servername: hostname });
            activeSocket = secure;
            secure.once("secureConnect", () => finish(null, secure));
            secure.once("error", (error) => finish(error));
        });
        connectReq.once("error", (error) => finish(error));
        connectReq.end();
        return undefined;
    }
}

function proxyAuthorization(proxyUrl: URL): Record<string, string> {
    if (!proxyUrl.username) {
        return {};
    }
    const token = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
    return { "Proxy-Authorization": `Basic ${token}` };
}

function downloadWithCurl(url: string, dest: string, options: DownloadOptions): Promise<void> {
    if (options.signal?.aborted) {
        return Promise.reject(createAbortError());
    }
    const maxTimeSec = Math.max(5, Math.ceil((options.timeoutMs ?? 300_000) / 1000));
    const args = ["--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", String(maxTimeSec), "--output", dest];
    if (options.proxy) {
        args.push("--proxy", options.proxy);
    }
    if (options.noProxy) {
        args.push("--noproxy", options.noProxy);
    }
    args.push(url);
    return new Promise((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, { windowsHide: true, detached: false });
        let settled = false;
        let cleanup = (): void => undefined;
        let stderr = "";
        const finishResolve = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };
        const finishReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", finishReject);
        child.on("close", (code) => {
            if (code === 0) {
                finishResolve();
                return;
            }
            finishReject(new Error(stderr.trim() || `curl 退出码 ${code ?? "未知"}`));
        });
        cleanup = wireRequestAbort(options.signal, () => child.kill(), finishReject);
    });
}

async function moveFile(from: string, to: string): Promise<void> {
    await fsp.rm(to, { force: true });
    try {
        await fsp.rename(from, to);
    } catch {
        await fsp.copyFile(from, to);
        await fsp.rm(from, { force: true });
    }
    if (process.platform !== "win32") {
        await fsp.chmod(to, 0o755);
    }
}
