import { ICON_CLOSE, ICON_EXTERNAL, ICON_REFRESH } from "./icons";
import type { ChatTokenStats, QuotaBucketView, QuotaGroupView, UiState, VsCodeApi } from "./types";
import { formatExactNumber, formatRelativeTime, formatResetCountdown, formatTime, formatTokenCount } from "./utils";

export interface UsageContext {
    ui: UiState;
    usageEl: HTMLElement | null;
    usageButton: HTMLElement | null;
    usagePillEl: HTMLButtonElement | null;
    vscode: VsCodeApi;
    setUsageOpen: (open: boolean) => void;
}

export function renderUsage(ctx: UsageContext): void {
    const { ui, usageEl, usageButton, usagePillEl, vscode, setUsageOpen } = ctx;
    if (usageButton) {
        usageButton.classList.toggle("active", ui.usageOpen);
        usageButton.setAttribute("aria-pressed", ui.usageOpen ? "true" : "false");
    }
    if (usagePillEl) {
        usagePillEl.classList.toggle("active", ui.usageOpen);
        usagePillEl.setAttribute("aria-pressed", ui.usageOpen ? "true" : "false");
    }
    if (!usageEl) {
        return;
    }
    usageEl.hidden = !ui.usageOpen;
    if (!ui.usageOpen) {
        ui.usageSignature = "";
        return;
    }

    const quota = ui.state.quota || { loading: false, groups: [] };
    const stats = ui.state.tokenStats;
    const signature = JSON.stringify([stats ?? null, quota]);
    if (signature === ui.usageSignature && usageEl.querySelector(".usage-shell")) {
        return;
    }
    const prevBody = usageEl.querySelector<HTMLElement>(".usage-body");
    const prevScrollTop = prevBody ? prevBody.scrollTop : 0;
    ui.usageSignature = signature;

    usageEl.replaceChildren();
    const shell = document.createElement("div");
    shell.className = "usage-shell";

    const head = document.createElement("div");
    head.className = "usage-head";
    const headLeft = document.createElement("div");
    headLeft.className = "usage-head-left";
    const title = document.createElement("span");
    title.className = "usage-head-title";
    title.textContent = "用量与统计";
    headLeft.append(title);
    if (quota.tier?.name) {
        const tier = document.createElement("span");
        tier.className = "usage-tier";
        tier.textContent = quota.tier.name;
        headLeft.append(tier);
    }

    const headActions = document.createElement("div");
    headActions.className = "usage-head-actions";
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = `history-head-btn usage-refresh-btn${quota.loading ? " spinning" : ""}`;
    refreshBtn.title = "刷新剩余用量";
    refreshBtn.disabled = Boolean(quota.loading);
    refreshBtn.innerHTML = `${ICON_REFRESH}<span>${quota.loading ? "刷新中" : "刷新"}</span>`;
    refreshBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "refreshQuota", force: true });
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "history-close-btn";
    closeBtn.title = "关闭 (Esc)";
    closeBtn.setAttribute("aria-label", "关闭用量面板");
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener("click", () => setUsageOpen(false));

    headActions.append(refreshBtn, closeBtn);
    head.append(headLeft, headActions);

    const body = document.createElement("div");
    body.className = "usage-body";
    body.append(renderTokenSection(stats), renderQuotaSection(ui, vscode));

    shell.append(head, body);
    usageEl.append(shell);
    if (prevScrollTop > 0) {
        body.scrollTop = prevScrollTop;
    }
}

export function renderUsagePill(pillEl: HTMLButtonElement | null, ui: UiState, isGate: boolean): void {
    if (!pillEl) {
        return;
    }
    const stats = ui.state.tokenStats;
    const quota = ui.state.quota;
    const show = !isGate && (
        ui.state.status === "ready"
        || ui.state.status === "running"
        || Boolean(stats)
        || Boolean(quota?.fetchedAt)
    );
    pillEl.hidden = !show;
    if (!show) {
        return;
    }

    let text = "用量";
    let level: "normal" | "warn" | "danger" = "normal";
    const tips: string[] = [];

    if (stats && stats.contextSize > 0) {
        const pct = Math.min(100, Math.round((stats.contextUsed / stats.contextSize) * 100));
        text = `${formatTokenCount(stats.contextUsed)}/${formatTokenCount(stats.contextSize)} · ${pct}%`;
        if (pct >= 90) {
            level = "danger";
        } else if (pct >= 70) {
            level = "warn";
        }
        tips.push(`上下文窗口：${formatExactNumber(stats.contextUsed)} / ${formatExactNumber(stats.contextSize)} (${pct}%)`);
    } else if (stats && stats.total.totalTokens > 0) {
        text = `${formatTokenCount(stats.total.totalTokens)} tok`;
    }

    if (stats && stats.total.totalTokens > 0) {
        tips.push(`对话累计：${formatExactNumber(stats.total.totalTokens)} tokens（输入 ${formatExactNumber(stats.total.inputTokens)} / 输出 ${formatExactNumber(stats.total.outputTokens)}）`);
    }

    if (quota?.groups?.length) {
        let minFraction = 1;
        for (const group of quota.groups) {
            const first = group.buckets[0];
            if (first) {
                tips.push(`${group.name} ${bucketWindowLabel(first)}：${Math.round(first.remainingFraction * 100)}%`);
            }
            for (const bucket of group.buckets) {
                minFraction = Math.min(minFraction, bucket.remainingFraction);
            }
        }
        if (level === "normal") {
            if (minFraction < 0.15) {
                level = "danger";
            } else if (minFraction <= 0.4) {
                level = "warn";
            }
        }
    }

    tips.push("点击查看剩余用量与 Token 统计");

    pillEl.dataset.level = level;
    pillEl.title = tips.join("\n");
    pillEl.replaceChildren();
    const dot = document.createElement("span");
    dot.className = "usage-pill-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "usage-pill-text";
    label.textContent = text;
    pillEl.append(dot, label);
}

function renderTokenSection(stats: ChatTokenStats | undefined): HTMLDivElement {
    const group = document.createElement("div");
    group.className = "usage-group";

    const head = document.createElement("div");
    head.className = "usage-group-head";
    const title = document.createElement("div");
    title.className = "usage-group-title";
    title.textContent = "当前对话 Token";
    head.append(title);
    if (stats && stats.turns > 0) {
        const meta = document.createElement("span");
        meta.className = "usage-group-meta";
        meta.textContent = `共 ${stats.turns} 轮`;
        head.append(meta);
    }
    group.append(head);

    if (!stats || (stats.contextSize === 0 && stats.total.totalTokens === 0 && stats.turns === 0)) {
        const empty = document.createElement("div");
        empty.className = "usage-empty";
        empty.textContent = "当前对话尚无 Token 统计，发送消息后自动记录。";
        group.append(empty);
        return group;
    }

    if (stats.contextSize > 0) {
        const pct = Math.min(100, Math.round((stats.contextUsed / stats.contextSize) * 100));
        const barBlock = document.createElement("div");
        barBlock.className = "usage-bar-block";
        const row = document.createElement("div");
        row.className = "usage-bar-row";
        row.title = `${formatExactNumber(stats.contextUsed)} / ${formatExactNumber(stats.contextSize)} tokens`;
        const left = document.createElement("span");
        left.textContent = "上下文窗口";
        const right = document.createElement("span");
        right.className = "usage-bar-val";
        right.textContent = `${formatTokenCount(stats.contextUsed)} / ${formatTokenCount(stats.contextSize)} (${pct}%)`;
        row.append(left, right);

        const track = document.createElement("div");
        track.className = "usage-meter-track";
        const fill = document.createElement("div");
        fill.className = `usage-meter-fill${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`;
        fill.style.width = `${pct}%`;
        track.append(fill);

        barBlock.append(row, track);
        group.append(barBlock);
    }

    const total = stats.total;
    const grid = document.createElement("div");
    grid.className = "usage-metrics-grid";

    const totalVal = total.totalTokens > 0 ? total.totalTokens : stats.contextUsed;
    grid.append(
        makeMetricCell("总计 Token", formatTokenCount(totalVal), `${formatExactNumber(totalVal)} tokens`),
        makeMetricCell(
            "输入 Token",
            formatTokenCount(total.inputTokens),
            total.cachedReadTokens > 0
                ? `输入 ${formatExactNumber(total.inputTokens)} · 缓存读取 ${formatExactNumber(total.cachedReadTokens)}${total.cachedWriteTokens > 0 ? ` · 缓存写入 ${formatExactNumber(total.cachedWriteTokens)}` : ""}`
                : `${formatExactNumber(total.inputTokens)} tokens`,
            total.cachedReadTokens > 0 ? `含缓存 ${formatTokenCount(total.cachedReadTokens)}` : undefined,
        ),
        makeMetricCell("输出 Token", formatTokenCount(total.outputTokens), `${formatExactNumber(total.outputTokens)} tokens`),
        makeMetricCell("思考 Token", formatTokenCount(total.thoughtTokens), `${formatExactNumber(total.thoughtTokens)} tokens`),
    );
    group.append(grid);

    if (stats.lastTurn && stats.turns > 0) {
        const last = stats.lastTurn;
        const summary = document.createElement("div");
        summary.className = "usage-last-turn";
        const parts = [
            `输入 ${formatTokenCount(last.inputTokens)}`,
            `输出 ${formatTokenCount(last.outputTokens)}`,
        ];
        if (last.thoughtTokens > 0) {
            parts.push(`思考 ${formatTokenCount(last.thoughtTokens)}`);
        }
        summary.textContent = `本轮：${parts.join(" · ")}`;
        group.append(summary);
    }

    return group;
}

function renderQuotaSection(ui: UiState, vscode: VsCodeApi): HTMLDivElement {
    const quota = ui.state.quota || { loading: false, groups: [] };
    const group = document.createElement("div");
    group.className = "usage-group";

    const head = document.createElement("div");
    head.className = "usage-group-head";
    const title = document.createElement("div");
    title.className = "usage-group-title";
    title.textContent = "账号剩余用量";
    const meta = document.createElement("span");
    meta.className = "usage-group-meta";
    if (quota.loading) {
        meta.textContent = "查询中…";
    } else if (quota.fetchedAt) {
        const rel = formatRelativeTime(quota.fetchedAt);
        meta.textContent = rel === "刚刚" ? "刚刚更新" : `${rel}更新`;
        meta.title = `上次刷新：${formatTime(quota.fetchedAt)}`;
    }
    head.append(title, meta);
    group.append(head);

    if (quota.loading && !quota.groups.length) {
        const loading = document.createElement("div");
        loading.className = "usage-loading";
        loading.textContent = "正在获取账号剩余用量…";
        group.append(loading);
    }

    if (quota.error) {
        const errBox = document.createElement("div");
        errBox.className = "usage-error";
        const errText = document.createElement("div");
        errText.className = "usage-error-text";
        errText.textContent = quota.error;
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "settings-mini-btn";
        retryBtn.textContent = "重试";
        retryBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "refreshQuota", force: true });
        });
        errBox.append(errText, retryBtn);
        group.append(errBox);
    }

    if (quota.groups.length) {
        const list = document.createElement("div");
        list.className = "usage-quota-list";
        for (const item of quota.groups) {
            list.append(renderQuotaGroup(item));
        }
        group.append(list);
    } else if (!quota.loading && !quota.error) {
        const emptyRow = document.createElement("div");
        emptyRow.className = "usage-empty-row";
        const empty = document.createElement("div");
        empty.className = "usage-empty";
        empty.textContent = "尚未获取剩余用量，点击「刷新」获取。";
        const fetchBtn = document.createElement("button");
        fetchBtn.type = "button";
        fetchBtn.className = "settings-mini-btn";
        fetchBtn.textContent = "获取用量";
        fetchBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "refreshQuota", force: true });
        });
        emptyRow.append(empty, fetchBtn);
        group.append(emptyRow);
    }

    if (typeof quota.remainingCredits === "number") {
        const creditsRow = document.createElement("div");
        creditsRow.className = "usage-credits-row";
        const left = document.createElement("span");
        left.className = "usage-credits-label";
        left.textContent = "AI 积分余额";
        const right = document.createElement("div");
        right.className = "usage-credits-right";
        const val = document.createElement("span");
        val.className = "usage-credits-val";
        val.textContent = formatExactNumber(quota.remainingCredits);
        right.append(val);
        const upgradeUri = quota.upgradeUri || quota.tier?.upgradeUri;
        if (upgradeUri) {
            const linkBtn = document.createElement("button");
            linkBtn.type = "button";
            linkBtn.className = "usage-link-btn";
            linkBtn.innerHTML = `${ICON_EXTERNAL}<span>升级</span>`;
            linkBtn.title = upgradeUri;
            linkBtn.addEventListener("click", () => {
                vscode.postMessage({ type: "openLink", href: upgradeUri });
            });
            right.append(linkBtn);
        }
        creditsRow.append(left, right);
        group.append(creditsRow);
    }

    if (quota.groups.length || quota.description) {
        const note = document.createElement("div");
        note.className = "usage-footnote";
        note.textContent = "同组模型共享 5 小时与每周额度。";
        group.append(note);
    }

    return group;
}

function renderQuotaGroup(item: QuotaGroupView): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "usage-quota-group";

    const head = document.createElement("div");
    head.className = "usage-quota-head";
    const name = document.createElement("div");
    name.className = "usage-quota-name";
    name.textContent = item.name;
    head.append(name);

    const models = cleanModelList(item.description);
    if (models) {
        const sub = document.createElement("div");
        sub.className = "usage-quota-models";
        sub.textContent = models;
        sub.title = models;
        head.append(sub);
    }
    wrap.append(head);

    for (const bucket of item.buckets) {
        const row = document.createElement("div");
        row.className = "usage-bucket";

        const pct = Math.min(100, Math.max(0, Math.round(bucket.remainingFraction * 100)));
        const level = pct < 15 ? "danger" : pct <= 40 ? "warn" : "";

        const top = document.createElement("div");
        top.className = "usage-bucket-row";
        const label = document.createElement("span");
        label.className = "usage-bucket-label";
        label.textContent = bucketWindowLabel(bucket);

        const meta = document.createElement("div");
        meta.className = "usage-bucket-meta";
        const resetText = formatResetCountdown(bucket.resetTime) || (pct === 100 && !bucket.resetTime ? "满额" : "");
        if (resetText) {
            const reset = document.createElement("span");
            reset.className = "usage-bucket-reset";
            reset.textContent = resetText;
            if (bucket.resetTime) {
                const ms = Date.parse(bucket.resetTime);
                if (Number.isFinite(ms) && ms > 86_400_000) {
                    reset.title = `重置时间：${formatTime(ms)}`;
                }
            }
            meta.append(reset);
        }
        const pctEl = document.createElement("span");
        pctEl.className = `usage-bucket-pct${level ? ` ${level}` : ""}`;
        pctEl.textContent = `${pct}%`;
        meta.append(pctEl);
        top.append(label, meta);

        const track = document.createElement("div");
        track.className = "usage-meter-track";
        const fill = document.createElement("div");
        fill.className = `usage-meter-fill${level ? ` ${level}` : ""}`;
        fill.style.width = `${pct}%`;
        track.append(fill);

        row.append(top, track);
        wrap.append(row);
    }

    return wrap;
}

function makeMetricCell(label: string, value: string, title: string, hint?: string): HTMLDivElement {
    const cell = document.createElement("div");
    cell.className = "usage-metric-card";
    cell.title = title;
    const lbl = document.createElement("div");
    lbl.className = "usage-metric-label";
    lbl.textContent = label;
    const val = document.createElement("div");
    val.className = "usage-metric-value";
    val.textContent = value;
    cell.append(lbl, val);
    if (hint) {
        const sub = document.createElement("div");
        sub.className = "usage-metric-hint";
        sub.textContent = hint;
        cell.append(sub);
    }
    return cell;
}

function bucketWindowLabel(bucket: QuotaBucketView): string {
    const w = (bucket.window || "").toLowerCase();
    if (w === "5h") {
        return "5 小时额度";
    }
    if (w === "weekly") {
        return "每周额度";
    }
    return bucket.name;
}

function cleanModelList(description?: string): string {
    if (!description) {
        return "";
    }
    return description.replace(/^Models\s+within\s+this\s+group:\s*/i, "").trim();
}
