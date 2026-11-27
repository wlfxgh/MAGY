import * as os from "node:os";
import * as vscode from "vscode";
import { normalizeProxy, resolveProxy } from "./util";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 22;

export function normalizeFontSize(value: unknown): number {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) {
        return DEFAULT_FONT_SIZE;
    }
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(num)));
}

export interface AgySettings {
    proxy: string;
    noProxy: string;
    binaryPath: string;
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    extraArgs: string[];
    cursorDataDir: string;
    fontSize: number;
}

export function readSettings(): AgySettings {
    const configured = normalizeProxy(readString("proxy"));
    const editor = editorProxy();
    return {
        proxy: configured || editor.proxy,
        noProxy: readString("noProxy").trim() || editor.noProxy || "localhost,127.0.0.1,::1",
        binaryPath: readString("binaryPath").trim(),
        sandbox: readBoolean("sandbox", false),
        dangerouslySkipPermissions: readBoolean("dangerouslySkipPermissions", false),
        extraArgs: readStrings("extraArgs").map((item) => item.trim()).filter(Boolean),
        cursorDataDir: readString("cursorDataDir").trim(),
        fontSize: normalizeFontSize(readConfigured("fontSize", DEFAULT_FONT_SIZE)),
    };
}

export function agentEnv(settings: AgySettings, apiKey?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const network = resolveProxy(settings.proxy, process.env, settings.noProxy);
    if (network.proxy) {
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
            env[key] = network.proxy;
        }
        env.NO_PROXY = network.noProxy;
        env.no_proxy = network.noProxy;
    }
    if (apiKey) {
        env.GEMINI_API_KEY = apiKey;
    }
    return env;
}

export function workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

export function workspacePaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function readString(key: string): string {
    const value = readConfigured(key, "");
    return typeof value === "string" ? value : "";
}

function readBoolean(key: string, fallback: boolean): boolean {
    const value = readConfigured(key, fallback);
    return typeof value === "boolean" ? value : fallback;
}

function readStrings(key: string): string[] {
    const value = readConfigured(key, [] as string[]);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function editorProxy(): { proxy: string; noProxy: string } {
    const http = vscode.workspace.getConfiguration("http");
    if (String(http.get("proxySupport", "override")) === "off") {
        return { proxy: "", noProxy: "" };
    }
    const proxy = http.get("proxy", "");
    const noProxy = http.get("noProxy", "");
    return {
        proxy: normalizeProxy(typeof proxy === "string" ? proxy : ""),
        noProxy: typeof noProxy === "string" ? noProxy.trim() : "",
    };
}

function readConfigured<T>(key: string, fallback: T): T {
    const sections = ["magy", "agy"];
    for (const section of sections) {
        const config = vscode.workspace.getConfiguration(section);
        if (isConfigured(config, key)) {
            return config.get(key, fallback);
        }
    }
    return vscode.workspace.getConfiguration("magy").get(key, fallback);
}

function isConfigured(config: vscode.WorkspaceConfiguration, key: string): boolean {
    const inspected = config.inspect(key);
    if (!inspected) {
        return false;
    }
    return inspected.globalValue !== undefined
        || inspected.workspaceValue !== undefined
        || inspected.workspaceFolderValue !== undefined
        || inspected.globalLanguageValue !== undefined
        || inspected.workspaceLanguageValue !== undefined
        || inspected.workspaceFolderLanguageValue !== undefined;
}
