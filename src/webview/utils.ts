import type { StoredMessage, ViewState } from "./types";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 22;

export function clampFontSize(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return DEFAULT_FONT_SIZE;
    }
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(num)));
}

export function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function cssEscape(value: string): string {
    if (window.CSS && window.CSS.escape) {
        return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, "");
}

export function statusLabel(status: string): string {
    const labels: Record<string, string> = {
        pending: "进行中",
        in_progress: "进行中",
        completed: "完成",
        failed: "失败",
        cancelled: "已取消",
    };
    return labels[status] || "";
}

export function lineLabel(start?: number, end?: number): string {
    if (!start) {
        return "";
    }
    if (!end || start === end) {
        return `${start} 行`;
    }
    return `${start}–${end} 行`;
}

export function formatTime(value?: number): string {
    if (!value) {
        return "";
    }
    const date = new Date(value);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hours}:${minutes}`;
}

export function formatRelativeTime(value?: number): string {
    if (!value) {
        return "";
    }
    const diff = Date.now() - value;
    if (diff >= 0 && diff < 60000) {
        return "刚刚";
    }
    if (diff >= 0 && diff < 3600000) {
        return `${Math.floor(diff / 60000)} 分钟前`;
    }
    const date = new Date(value);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    if (value >= startOfToday) {
        return `${hh}:${mm}`;
    }
    if (value >= startOfToday - 86400000) {
        return `昨天 ${hh}:${mm}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function historyBucket(value?: number): string {
    if (!value) {
        return "更早";
    }
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 86400000;
    if (value >= startOfToday) {
        return "今天";
    }
    if (value >= startOfToday - dayMs) {
        return "昨天";
    }
    if (value >= startOfToday - 6 * dayMs) {
        return "7 天内";
    }
    return "更早";
}

export function formatElapsed(sinceMs: number): string {
    const sec = Math.max(0, (Date.now() - sinceMs) / 1000);
    return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

export function durationLabel(message: StoredMessage): string {
    if (message.startedAt && message.finishedAt && message.finishedAt >= message.startedAt) {
        const sec = (message.finishedAt - message.startedAt) / 1000;
        if (sec >= 0.1) {
            return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
        }
    }
    return "";
}

export function proxyDisplay(url?: string): string {
    return String(url || "").replace(/^http:\/\//i, "");
}

export function formatTokenCount(n: number): string {
    if (!Number.isFinite(n) || n <= 0) {
        return "0";
    }
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (n >= 100_000) {
        return `${Math.round(n / 1_000)}k`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return String(Math.round(n));
}

export function formatExactNumber(n: number): string {
    if (!Number.isFinite(n)) {
        return "0";
    }
    return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

export function formatResetCountdown(iso?: string): string {
    if (!iso) {
        return "";
    }
    const target = Date.parse(iso);
    if (!Number.isFinite(target) || target <= 86_400_000) {
        return "";
    }
    const diffMs = target - Date.now();
    if (diffMs <= 60_000) {
        return "即将重置";
    }
    const totalMins = Math.ceil(diffMs / 60_000);
    const days = Math.floor(totalMins / (60 * 24));
    const hours = Math.floor((totalMins % (60 * 24)) / 60);
    const mins = totalMins % 60;
    if (days > 0) {
        return hours > 0 ? `${days} 天 ${hours} 小时后重置` : `${days} 天后重置`;
    }
    if (hours > 0) {
        return mins > 0 ? `${hours} 小时 ${mins} 分钟后重置` : `${hours} 小时后重置`;
    }
    return `${mins} 分钟后重置`;
}

export function emptyState(): ViewState {
    return {
        chats: [],
        activeId: "",
        messages: [],
        attachments: [],
        status: "connecting",
        statusText: "等待连接",
        runtimeLabel: "",
        runtimeInstalled: true,
        proxy: "",
        proxyUrl: "",
        usageText: "",
        busy: false,
        modes: [],
        currentModeId: "",
        options: [],
        authMethods: [],
        commands: [],
        quota: { loading: false, groups: [] },
    };
}
