import { spawn } from "node:child_process";
import type { QuotaBucketView, QuotaGroupView } from "../chat/types";
import { asRecord } from "../util";

export interface QuotaSnapshot {
    description?: string;
    groups: QuotaGroupView[];
    remainingCredits?: number;
    upgradeUri?: string;
}

export interface QuotaFetchOptions {
    binary: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
}

export function parseUsageCommandOutput(stdout: string): { description?: string; groups: QuotaGroupView[] } {
    const root = extractJsonObject(stdout);
    if (!root) {
        throw new Error("无法解析账号用量输出");
    }
    const status = typeof root.status === "string" ? root.status.trim() : "";
    if (status && status !== "SUCCESS") {
        const message = firstString(root.error, root.message, root.response) || `查询账号用量失败 (${status})`;
        throw new Error(message);
    }
    const command = asRecord(root.command);
    const data = asRecord(command.data);
    const description = firstString(data.description);
    const rawGroups = Array.isArray(data.groups) ? data.groups : [];
    const groups: QuotaGroupView[] = [];
    for (const entry of rawGroups) {
        const group = asRecord(entry);
        const name = firstString(group.name);
        if (!name) {
            continue;
        }
        const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
        const buckets: QuotaBucketView[] = [];
        for (const bucketItem of rawBuckets) {
            const bucket = asRecord(bucketItem);
            const bucketName = firstString(bucket.name, bucket.id, bucket.window);
            if (!bucketName) {
                continue;
            }
            const rawFraction = Number(bucket.remaining_fraction ?? bucket.remainingFraction);
            const remainingFraction = Number.isFinite(rawFraction)
                ? Math.min(1, Math.max(0, rawFraction))
                : 0;
            buckets.push({
                id: firstString(bucket.id, bucket.window, bucketName) || bucketName,
                name: bucketName,
                window: firstString(bucket.window, bucket.id) || "",
                remainingFraction,
                resetTime: normalizeResetTime(bucket.reset_time ?? bucket.resetTime),
                description: firstString(bucket.description),
            });
        }
        groups.push({
            name,
            description: firstString(group.description),
            buckets,
        });
    }
    if (!groups.length && typeof root.response === "string" && root.response.includes("\t")) {
        const tsvGroups = parseUsageTsv(root.response);
        if (tsvGroups.length) {
            return { description, groups: tsvGroups };
        }
    }
    return { description, groups };
}

export function parseCreditsCommandOutput(stdout: string): { remainingCredits?: number; upgradeUri?: string } {
    const root = extractJsonObject(stdout);
    if (!root) {
        return {};
    }
    const status = typeof root.status === "string" ? root.status.trim() : "";
    if (status && status !== "SUCCESS") {
        return {};
    }
    const data = asRecord(asRecord(root.command).data);
    const rawCredits = data.remaining_credits ?? data.remainingCredits;
    const remainingCredits = typeof rawCredits === "number" && Number.isFinite(rawCredits)
        ? rawCredits
        : undefined;
    const upgradeUri = firstString(data.upgrade_uri, data.upgradeUri);
    return { remainingCredits, upgradeUri };
}

export async function fetchUsageQuota(
    options: QuotaFetchOptions,
): Promise<{ description?: string; groups: QuotaGroupView[] }> {
    const timeoutMs = options.timeoutMs ?? 25_000;
    const stdout = await runCliCommand(
        options.binary,
        ["-p", "/usage", "--output-format", "json"],
        options.cwd,
        options.env,
        timeoutMs,
    );
    return parseUsageCommandOutput(stdout);
}

export async function fetchCreditsQuota(
    options: QuotaFetchOptions,
): Promise<{ remainingCredits?: number; upgradeUri?: string }> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const stdout = await runCliCommand(
        options.binary,
        ["-p", "/credits", "--output-format", "json"],
        options.cwd,
        options.env,
        timeoutMs,
    );
    return parseCreditsCommandOutput(stdout);
}

export async function fetchQuotaSnapshot(options: QuotaFetchOptions): Promise<QuotaSnapshot> {
    const usage = await fetchUsageQuota(options);
    const credits = await fetchCreditsQuota({
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 25_000, 15_000),
    }).catch((): { remainingCredits?: number; upgradeUri?: string } => ({}));
    return {
        description: usage.description,
        groups: usage.groups,
        remainingCredits: credits.remainingCredits,
        upgradeUri: credits.upgradeUri,
    };
}

function runCliCommand(
    binary: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: false,
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        let settled = false;
        const killChild = () => {
            if (process.platform === "win32" && child.pid) {
                spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", detached: false });
            } else {
                child.kill("SIGTERM");
            }
        };
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            killChild();
            reject(new Error(`查询账号用量超时 (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
                return;
            }
            const parsed = extractJsonObject(stdout);
            const detail = parsed
                ? firstString(parsed.error, parsed.message, parsed.response)
                : "";
            reject(new Error(detail || stderr.trim() || stdout.trim() || `查询账号用量失败 (退出码 ${code ?? "未知"})`));
        });
    });
}

function extractJsonObject(raw: string): Record<string, unknown> | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        const direct = JSON.parse(trimmed);
        if (direct && typeof direct === "object" && !Array.isArray(direct)) {
            return direct as Record<string, unknown>;
        }
    } catch {
        // Fallback to line-based extraction below
    }
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.startsWith("{") || !line.endsWith("}")) {
            continue;
        }
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Continue searching preceding lines
        }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
            const sliced = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            if (sliced && typeof sliced === "object" && !Array.isArray(sliced)) {
                return sliced as Record<string, unknown>;
            }
        } catch {
            // Ignore unparseable slice
        }
    }
    return undefined;
}

function parseUsageTsv(response: string): QuotaGroupView[] {
    const map = new Map<string, QuotaBucketView[]>();
    for (const rawLine of response.split(/\r?\n/)) {
        const cols = rawLine.split("\t").map((item) => item.trim());
        if (cols.length < 3 || !cols[0] || !cols[1]) {
            continue;
        }
        const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(cols[2]);
        if (!pctMatch) {
            continue;
        }
        const remainingFraction = Math.min(1, Math.max(0, Number(pctMatch[1]) / 100));
        const bucketName = cols[1];
        const window = /5\s*h|five\s*hour/i.test(bucketName)
            ? "5h"
            : /week/i.test(bucketName)
                ? "weekly"
                : "";
        let list = map.get(cols[0]);
        if (!list) {
            list = [];
            map.set(cols[0], list);
        }
        list.push({
            id: `${cols[0].toLowerCase().replace(/\s+/g, "-")}-${window || list.length}`,
            name: bucketName,
            window,
            remainingFraction,
            resetTime: normalizeResetTime(cols[3]),
        });
    }
    return Array.from(map.entries()).map(([name, buckets]) => ({ name, buckets }));
}

function normalizeResetTime(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms) || ms <= 86_400_000) {
        return undefined;
    }
    return trimmed;
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}
