export function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

export function clip(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max)}\n…（已截断）`;
}

export function normalizeProxy(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        return trimmed;
    }
    return `http://${trimmed}`;
}

export function resolveProxy(configured: string, env: NodeJS.ProcessEnv, configuredNoProxy: string): { proxy: string; noProxy: string } {
    const explicit = normalizeProxy(configured);
    const inherited = normalizeProxy(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || "");
    const proxy = explicit || inherited;
    const noProxy = explicit
        ? (configuredNoProxy.trim() || "localhost,127.0.0.1,::1")
        : (env.NO_PROXY || env.no_proxy || configuredNoProxy || "localhost,127.0.0.1,::1");
    return { proxy, noProxy };
}

export function bypassesProxy(hostname: string, noProxy: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || !noProxy.trim()) {
        return false;
    }
    for (const raw of noProxy.split(/[,\s]+/)) {
        const rule = raw.trim().toLowerCase();
        if (!rule) {
            continue;
        }
        if (rule === "*") {
            return true;
        }
        const bare = rule.replace(/:\d+$/, "").replace(/^\*\.?/, "").replace(/^\./, "");
        if (bare && (host === bare || host.endsWith(`.${bare}`))) {
            return true;
        }
    }
    return false;
}

export function redactProxy(value: string): string {
    try {
        const url = new URL(value);
        if (url.username) {
            url.username = "***";
        }
        if (url.password) {
            url.password = "***";
        }
        return url.toString();
    } catch {
        return value;
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

export function withNetworkHint(error: unknown): string {
    const message = errorMessage(error);
    if (/dial tcp|connectex|oauth2\.googleapis|couldn'?t sign in|couldn'?t complete sign-in/i.test(message)) {
        const lead = /dial tcp/i.test(message)
            ? "登录没有完成：反重力在直接连接 Google，没有走代理。"
            : "登录没有完成：连接 Google 失败。";
        return `${lead}在登录卡片的「代理」中填写可用地址；留空时使用编辑器的 http.proxy。\n${message}`;
    }
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNABORTED|代理|timeout|timed out|network|ENETUNREACH|证书|certificate/i.test(message)) {
        return `${message}。若当前网络不能直接访问目标地址，在登录卡片的「代理」中填写可用地址；留空时使用编辑器的 http.proxy。`;
    }
    return message;
}

export function countDiffLines(oldText?: string, newText?: string): { add: number; del: number } {
    const a = oldText ? oldText.replace(/\r\n?/g, "\n").split("\n") : [];
    const b = newText ? newText.replace(/\r\n?/g, "\n").split("\n") : [];
    if (!a.length && !b.length) {
        return { add: 0, del: 0 };
    }
    if (!a.length) {
        return { add: b.length, del: 0 };
    }
    if (!b.length) {
        return { add: 0, del: a.length };
    }
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start += 1;
    }
    let aEnd = a.length;
    let bEnd = b.length;
    while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd -= 1;
        bEnd -= 1;
    }
    const aMid = a.slice(start, aEnd);
    const bMid = b.slice(start, bEnd);
    const m = aMid.length;
    const n = bMid.length;
    if (!m && !n) {
        return { add: 0, del: 0 };
    }
    if (!m) {
        return { add: n, del: 0 };
    }
    if (!n) {
        return { add: 0, del: m };
    }
    if (m * n > 160_000) {
        return { add: n, del: m };
    }
    let prev = new Uint32Array(n + 1);
    let curr = new Uint32Array(n + 1);
    for (let i = m - 1; i >= 0; i -= 1) {
        curr.fill(0);
        for (let j = n - 1; j >= 0; j -= 1) {
            curr[j] = aMid[i] === bMid[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    const lcs = prev[0];
    return { add: n - lcs, del: m - lcs };
}
