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
    onProgress?: (received: number, total?: number) => void;
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
    const body = await fetchText(manifestUrl(), options);
    const parsed = JSON.parse(body) as Partial<AgypManifest>;
    if (!parsed.url || !parsed.sha512 || !parsed.version) {
        throw new Error("反重力发布清单缺少版本、地址或校验值");
    }
    return { version: parsed.version, url: parsed.url, sha512: parsed.sha512 };
}

export async function downloadVerified(url: string, dest: string, sha512: string, options: DownloadOptions): Promise<void> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const partial = `${dest}.partial`;
    let lastError = "";
    for (const attempt of downloadAttempts(options)) {
        try {
            await fsp.rm(partial, { force: true });
            await attempt(url, partial, options);
            const actual = await sha512File(partial);
            if (actual.toLowerCase() !== sha512.toLowerCase()) {
                throw new Error("反重力安装包校验失败");
            }
            await moveFile(partial, dest);
            return;
        } catch (error) {
            lastError = errorMessage(error);
            await fsp.rm(partial, { force: true });
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
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "magy-manifest-")), "manifest.json");
    try {
        let lastError = "";
        for (const attempt of downloadAttempts(options)) {
            try {
                await fsp.rm(file, { force: true });
                await attempt(url, file, options);
                return await fsp.readFile(file, "utf8");
            } catch (error) {
                lastError = errorMessage(error);
            }
        }
        throw new Error(lastError || "反重力发布清单下载失败");
    } finally {
        await fsp.rm(path.dirname(file), { recursive: true, force: true });
    }
}

async function downloadWithNode(url: string, dest: string, options: DownloadOptions, redirects = 5): Promise<void> {
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
    await pipeline(response, counter, fs.createWriteStream(dest));
}

function request(target: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
    const proxy = options.proxy && !bypassesProxy(target.hostname, options.noProxy ?? "") ? options.proxy : "";
    if (!proxy) {
        return direct(target);
    }
    const proxyUrl = new URL(proxy);
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
        return Promise.reject(new Error("该代理协议由 curl 处理"));
    }
    if (target.protocol === "https:") {
        return tunnel(target, proxyUrl);
    }
    if (target.protocol === "http:") {
        return forwardHttp(target, proxyUrl);
    }
    return Promise.reject(new Error(`不支持的下载协议 ${target.protocol}`));
}

function direct(target: URL): Promise<http.IncomingMessage> {
    const lib = target.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
        const req = lib.get(target, {
            headers: { "User-Agent": USER_AGENT },
        }, resolve);
        req.setTimeout(300000, () => req.destroy(new Error("下载超时")));
        req.on("error", reject);
    });
}

function tunnel(target: URL, proxyUrl: URL): Promise<http.IncomingMessage> {
    const agent = new ProxyTunnelAgent(proxyUrl);
    return new Promise((resolve, reject) => {
        const req = https.get(target, {
            agent,
            headers: { "User-Agent": USER_AGENT },
        }, resolve);
        req.setTimeout(300000, () => req.destroy(new Error("下载超时")));
        req.on("error", reject);
    });
}

function forwardHttp(target: URL, proxyUrl: URL): Promise<http.IncomingMessage> {
    const lib = proxyUrl.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
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
        }, resolve);
        req.setTimeout(300000, () => req.destroy(new Error("下载超时")));
        req.on("error", reject);
        req.end();
    });
}

class ProxyTunnelAgent extends https.Agent {
    constructor(private readonly proxyUrl: URL) {
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
        const finish = (error: Error | null, socket?: tls.TLSSocket) => {
            if (settled) {
                return;
            }
            settled = true;
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
        connectReq.setTimeout(30000, () => connectReq.destroy(new Error("代理连接超时")));
        connectReq.once("connect", (response, socket) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                finish(new Error(`代理连接失败 (${response.statusCode ?? "未知"})`));
                return;
            }
            const secure = tls.connect({ socket, servername: hostname });
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
    const args = ["--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", "300", "--output", dest];
    if (options.proxy) {
        args.push("--proxy", options.proxy);
    }
    if (options.noProxy) {
        args.push("--noproxy", options.noProxy);
    }
    args.push(url);
    return new Promise((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, { windowsHide: true, detached: false });
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
            reject(new Error(stderr.trim() || `curl 退出码 ${code ?? "未知"}`));
        });
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
