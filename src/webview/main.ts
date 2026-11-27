import { inferToolFileTarget, normalizeToolMeta, renderDiffs, unwrapJsonOutput } from "./diff";
import { initDragAndDrop } from "./dnd";
import { renderElicitation, type ElicitationContext } from "./elicitation";
import { renderHistory, renderHistoryConfirm, renderHistoryItems, type HistoryContext } from "./history";
import { attachmentIconSvg, iconSvg } from "./icons";
import { renderMarkdown } from "./markdown";
import { applyTypography, renderSettings, type SettingsContext } from "./settings";
import { renderUsage, renderUsagePill, type UsageContext } from "./usage";
import type {
    CodeAttachment,
    CommandView,
    HostMessage,
    SelectChoice,
    StoredMessage,
    UiState,
} from "./types";
import { cssEscape, durationLabel, emptyState, formatElapsed, lineLabel, proxyDisplay, statusLabel } from "./utils";

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages") as HTMLElement;
const historyEl = document.getElementById("history-panel") as HTMLElement;
const settingsEl = document.getElementById("settings-panel");
const usageEl = document.getElementById("usage-panel");
const elicitationEl = document.getElementById("elicitation");
const permissionEl = document.getElementById("permission") as HTMLElement;
const authEl = document.getElementById("auth") as HTMLElement;
const selectorsEl = document.getElementById("selectors") as HTMLElement;
const slashEl = document.getElementById("slash") as HTMLElement;
const chipsEl = document.getElementById("chips") as HTMLElement;
const composerEl = document.querySelector<HTMLElement>(".composer");
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;
const statusRowEl = document.getElementById("status-row");
const statusEl = document.getElementById("statusline") as HTMLButtonElement;
const usagePillEl = document.getElementById("usage-pill") as HTMLButtonElement | null;
const historyButton = document.getElementById("history") as HTMLButtonElement;
const usageButton = document.getElementById("usage");
const settingsButton = document.getElementById("settings");
const createButton = document.getElementById("create");
const importButton = document.getElementById("import");
const scrollBottomButton = document.getElementById("scroll-bottom") as HTMLButtonElement | null;

const ui: UiState = {
    historyOpen: false,
    settingsOpen: false,
    usageOpen: false,
    state: emptyState(),
    selectSignature: "",
    historySignature: "",
    usageSignature: "",
    chipSignature: "",
    proxyMenu: false,
    proxyDraft: null,
    proxyCaret: null,
    proxyFocused: true,
    pendingSend: false,
    slashIndex: 0,
    slashQuery: "",
    slashDismissed: false,
    slashMoved: false,
    slashMatches: [],
    openPicker: null,
    elicitationId: "",
    historyQuery: "",
    historyIndex: -1,
    historyConfirmId: "",
    historyConfirmTimer: 0,
    settingsFeedbackTimer: 0,
    busyStartedAt: 0,
    liveTimer: 0,
    userToggled: new Map(),
    msgStatus: new Map(),
};

const stageStack = document.createElement("div");
stageStack.id = "stage-stack";
const emptyEl = document.createElement("p");
emptyEl.className = "empty";
const connectWaitEl = document.createElement("div");
connectWaitEl.className = "connect-wait";
connectWaitEl.setAttribute("role", "status");
const connectWaitDotEl = document.createElement("span");
connectWaitDotEl.className = "connect-wait-dot";
connectWaitDotEl.setAttribute("aria-hidden", "true");
const connectWaitTextEl = document.createElement("span");
connectWaitTextEl.className = "connect-wait-text";
connectWaitTextEl.textContent = "等待连接";
connectWaitEl.append(connectWaitDotEl, connectWaitTextEl);

const historyCtx: HistoryContext = {
    ui,
    historyEl,
    historyButton,
    vscode,
    setHistoryOpen,
};

const settingsCtx: SettingsContext = {
    ui,
    settingsEl,
    settingsButton,
    vscode,
    setSettingsOpen,
    resizeInput,
};

const usageCtx: UsageContext = {
    ui,
    usageEl,
    usageButton,
    usagePillEl,
    vscode,
    setUsageOpen,
};

const elicitationCtx: ElicitationContext = {
    ui,
    elicitationEl,
    vscode,
};

function setHistoryOpen(open: boolean): void {
    const next = Boolean(open);
    if (ui.historyOpen === next) {
        return;
    }
    if (next && ui.settingsOpen) {
        setSettingsOpen(false);
    }
    if (next && ui.usageOpen) {
        setUsageOpen(false);
    }
    ui.historyOpen = next;
    historyButton.classList.toggle("active", next);
    historyButton.setAttribute("aria-pressed", next ? "true" : "false");
    if (next) {
        ui.historyQuery = "";
        ui.historyIndex = -1;
        ui.historyConfirmId = "";
        ui.historySignature = "";
    }
    renderHistory(historyCtx);
    if (next) {
        const searchInput = historyEl.querySelector<HTMLInputElement>(".history-search");
        if (searchInput) {
            requestAnimationFrame(() => searchInput.focus());
        }
    }
}

function setSettingsOpen(open: boolean): void {
    const next = Boolean(open);
    if (ui.settingsOpen === next) {
        return;
    }
    if (next && ui.historyOpen) {
        setHistoryOpen(false);
    }
    if (next && ui.usageOpen) {
        setUsageOpen(false);
    }
    ui.settingsOpen = next;
    if (settingsButton) {
        settingsButton.classList.toggle("active", next);
        settingsButton.setAttribute("aria-pressed", next ? "true" : "false");
    }
    renderSettings(settingsCtx, true);
}

function setUsageOpen(open: boolean): void {
    const next = Boolean(open);
    if (ui.usageOpen === next) {
        return;
    }
    if (next && ui.historyOpen) {
        setHistoryOpen(false);
    }
    if (next && ui.settingsOpen) {
        setSettingsOpen(false);
    }
    ui.usageOpen = next;
    if (next) {
        ui.usageSignature = "";
    }
    renderUsage(usageCtx);
}

createButton?.addEventListener("click", () => {
    setHistoryOpen(false);
    setSettingsOpen(false);
    setUsageOpen(false);
    vscode.postMessage({ type: "newChat" });
});

importButton?.addEventListener("click", () => {
    setHistoryOpen(false);
    setSettingsOpen(false);
    setUsageOpen(false);
    vscode.postMessage({ type: "importCursor" });
});

historyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setHistoryOpen(!ui.historyOpen);
});

if (usageButton) {
    usageButton.addEventListener("click", (event) => {
        event.stopPropagation();
        setUsageOpen(!ui.usageOpen);
    });
}

if (usagePillEl) {
    usagePillEl.addEventListener("click", (event) => {
        event.stopPropagation();
        setUsageOpen(!ui.usageOpen);
    });
}

if (settingsButton) {
    settingsButton.addEventListener("click", (event) => {
        event.stopPropagation();
        setSettingsOpen(!ui.settingsOpen);
    });
}

sendEl.addEventListener("click", onSendButton);
statusEl.addEventListener("click", (event) => {
    event.stopPropagation();
    setSettingsOpen(!ui.settingsOpen);
});
statusEl.title = "点击打开设置与代理配置";

inputEl.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) {
        return;
    }
    if (!slashEl.hidden && ui.slashMatches.length) {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            ui.slashIndex = (ui.slashIndex + 1) % ui.slashMatches.length;
            ui.slashMoved = true;
            renderSlash(true);
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            ui.slashIndex = (ui.slashIndex - 1 + ui.slashMatches.length) % ui.slashMatches.length;
            ui.slashMoved = true;
            renderSlash(true);
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            ui.slashDismissed = true;
            renderSlash();
            return;
        }
        if (event.key === "Tab") {
            event.preventDefault();
            applySlash(ui.slashMatches[ui.slashIndex]);
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            const chosen = ui.slashMatches[ui.slashIndex];
            const exact = chosen && inputEl.value.trim() === `/${chosen.name}`;
            if (chosen && (ui.slashMoved || !exact)) {
                event.preventDefault();
                applySlash(chosen);
                return;
            }
        }
    }
    if (event.key === "Escape" && ui.openPicker) {
        event.preventDefault();
        closePicker();
        return;
    }
    if (event.key === "Escape" && ui.historyOpen) {
        event.preventDefault();
        ui.historyOpen = false;
        renderHistory(historyCtx);
        return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendComposer();
    }
});

document.addEventListener("mousedown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (ui.openPicker && !target?.closest("#picker-menu, .picker-btn")) {
        closePicker();
    }
    if (ui.historyOpen && !target?.closest("#history-panel, #history")) {
        setHistoryOpen(false);
    }
    if (ui.settingsOpen && !target?.closest("#settings-panel, #settings, #statusline")) {
        setSettingsOpen(false);
    }
    if (ui.usageOpen && !target?.closest("#usage-panel, #usage, #usage-pill")) {
        setUsageOpen(false);
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.openPicker) {
        closePicker();
        return;
    }
    if (event.key === "Escape" && ui.usageOpen) {
        event.preventDefault();
        setUsageOpen(false);
        if (!inputEl.disabled) {
            inputEl.focus();
        }
        return;
    }
    if (event.key === "Escape" && ui.settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        if (!inputEl.disabled) {
            inputEl.focus();
        }
        return;
    }
    if (event.key === "Escape" && ui.historyOpen) {
        event.preventDefault();
        if (ui.historyConfirmId) {
            ui.historyConfirmId = "";
            renderHistoryConfirm(historyCtx);
            renderHistoryItems(historyCtx);
            return;
        }
        setHistoryOpen(false);
        if (!inputEl.disabled) {
            inputEl.focus();
        }
    }
});

window.addEventListener("resize", () => {
    if (ui.openPicker) {
        closePicker();
    }
});

inputEl.addEventListener("input", () => {
    ui.slashDismissed = false;
    resizeInput();
    renderSlash();
    syncSend();
});

if (composerEl) {
    composerEl.addEventListener("mousedown", (event) => {
        if (ui.historyOpen) {
            setHistoryOpen(false);
        }
        if (ui.settingsOpen) {
            setSettingsOpen(false);
        }
        if (ui.usageOpen) {
            setUsageOpen(false);
        }
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button, select, a, textarea, label")) {
            return;
        }
        event.preventDefault();
        inputEl.focus();
    });
}

messagesEl.addEventListener("scroll", syncScrollBottom);

scrollBottomButton?.addEventListener("click", () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
});

messagesEl.addEventListener("mousedown", () => {
    if (ui.historyOpen) {
        setHistoryOpen(false);
    }
    if (ui.settingsOpen) {
        setSettingsOpen(false);
    }
    if (ui.usageOpen) {
        setUsageOpen(false);
    }
});

messagesEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const copyButton = target?.closest<HTMLButtonElement>(".ref-copy");
    if (copyButton) {
        event.preventDefault();
        const ref = copyButton.closest(".ref");
        const code = ref ? ref.querySelector("pre code") : null;
        const text = code ? code.textContent || "" : "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
            void navigator.clipboard.writeText(text).then(() => {
                copyButton.textContent = "已复制";
                copyButton.classList.add("copied");
                clearTimeout(Number(copyButton.dataset.timer || 0));
                const timer = window.setTimeout(() => {
                    copyButton.textContent = "复制";
                    copyButton.classList.remove("copied");
                }, 1500);
                copyButton.dataset.timer = String(timer);
            }).catch(() => undefined);
        }
        return;
    }
    const link = target?.closest("a");
    if (!link) {
        return;
    }
    event.preventDefault();
    vscode.postMessage({ type: "openLink", href: link.getAttribute("href") });
});

initDragAndDrop(composerEl, vscode);

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
        return;
    }
    if (message.type === "snapshot") {
        closePicker();
        ui.userToggled.clear();
        ui.msgStatus.clear();
        ui.state = message.state || emptyState();
        ui.pendingSend = false;
        renderMessages(true);
        renderChrome();
    } else if (message.type === "delta") {
        upsertMessage(message.message);
    } else if (message.type === "status") {
        const messages = ui.state.messages;
        const keepTranscript = messages.length > 0;
        ui.state = Object.assign(emptyState(), message.state, { messages });
        if (!keepTranscript) {
            renderMessages(false);
        }
        renderChrome();
    } else if (message.type === "toggleHistory") {
        setHistoryOpen(!ui.historyOpen);
    } else if (message.type === "toggleSettings") {
        setSettingsOpen(!ui.settingsOpen);
    } else if (message.type === "toggleUsage") {
        const targetOpen = typeof message.open === "boolean" ? message.open : !ui.usageOpen;
        setUsageOpen(targetOpen);
    }
});

renderChrome();
vscode.postMessage({ type: "ready" });

function onSendButton(): void {
    if (ui.state.busy) {
        vscode.postMessage({ type: "cancel" });
        return;
    }
    sendComposer();
}

function sendComposer(): void {
    if (inputEl.disabled) {
        return;
    }
    const text = inputEl.value;
    const hasAttachment = (ui.state.attachments || []).length > 0;
    if (!text.trim() && !hasAttachment) {
        return;
    }
    inputEl.value = "";
    ui.pendingSend = true;
    ui.slashDismissed = false;
    resizeInput();
    renderSlash();
    syncConnectWait();
    syncSend();
    vscode.postMessage({ type: "send", text });
}

function upsertMessage(message: StoredMessage): void {
    if (!message || !message.id) {
        return;
    }
    const index = ui.state.messages.findIndex((item) => item.id === message.id);
    const prevMessage = index >= 0 ? ui.state.messages[index - 1] : ui.state.messages[ui.state.messages.length - 1];
    if (index >= 0) {
        ui.state.messages[index] = message;
    } else {
        ui.state.messages.push(message);
    }
    const stick = nearBottom();
    const existing = messagesEl.querySelector<HTMLElement>(`[data-id="${cssEscape(message.id)}"]`);
    if (existing instanceof HTMLDetailsElement && (message.role === "tool" || message.role === "thought")) {
        updateDetailsNode(existing, message, true);
    } else if (existing && message.role === "assistant" && existing.classList.contains("assistant")) {
        const head = existing.querySelector<HTMLElement>(":scope > .msg-head");
        if (head && message.text && !head.querySelector(".msg-copy-btn")) {
            head.append(makeCopyButton(message.id));
        }
        let body = existing.querySelector<HTMLElement>(":scope > .msg-text");
        if (message.text) {
            if (!body) {
                body = document.createElement("div");
                body.className = "msg-text";
                existing.append(body);
            }
            body.innerHTML = renderMarkdown(message.text);
        } else if (body) {
            body.remove();
        }
    } else {
        const node = renderMessage(message, prevMessage);
        if (!existing) {
            node.classList.add("enter");
        }
        if (existing) {
            existing.replaceWith(node);
        } else {
            const empty = messagesEl.querySelector(".empty, .connect-wait");
            if (empty) {
                empty.remove();
            }
            const live = document.getElementById("live-indicator");
            if (live && live.parentElement === messagesEl) {
                messagesEl.insertBefore(node, live);
            } else {
                messagesEl.append(node);
            }
        }
    }
    placeAuth();
    syncConnectWait();
    syncLivePulse();
    if (stick) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    syncScrollBottom();
}

function renderMessages(scroll: boolean): void {
    captureProxyDraft();
    const previousTop = messagesEl.scrollTop;
    const stick = scroll || nearBottom();
    const footer = document.querySelector("footer");
    const slash = document.getElementById("slash");
    if (composerEl && footer && composerEl.parentElement !== footer) {
        footer.append(composerEl);
    }
    if ((authEl.parentElement === messagesEl || authEl.parentElement === stageStack) && slash && footer) {
        footer.insertBefore(authEl, slash);
    }
    if (statusRowEl) {
        if (statusEl.parentElement !== statusRowEl) {
            statusRowEl.prepend(statusEl);
        }
        if (footer && statusRowEl.parentElement !== footer) {
            footer.append(statusRowEl);
        }
    } else if (statusEl.parentElement === messagesEl && footer) {
        if (composerEl && composerEl.parentElement === footer) {
            footer.insertBefore(statusEl, composerEl);
        } else {
            footer.append(statusEl);
        }
    }
    messagesEl.replaceChildren();
    const emptyThread = !ui.state.messages.length;
    const prelude = ui.state.status === "auth";
    messagesEl.classList.toggle("stage", emptyThread && prelude);
    if (!emptyThread) {
        let prev: StoredMessage | null = null;
        for (const message of ui.state.messages) {
            messagesEl.append(renderMessage(message, prev));
            prev = message;
        }
    }
    syncConnectWait();
    syncLivePulse();
    if (stick) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
        messagesEl.scrollTop = previousTop;
    }
    syncScrollBottom();
}

function syncConnectWait(): void {
    const show = !(ui.state.messages || []).length
        && !ui.pendingSend
        && authEl.hidden
        && ui.state.status === "connecting";
    if (!show) {
        if (connectWaitEl.parentElement) {
            connectWaitEl.remove();
        }
        messagesEl.classList.remove("waiting");
        return;
    }
    const label = statusText() || "等待连接";
    if (connectWaitTextEl.textContent !== label) {
        connectWaitTextEl.textContent = label;
    }
    messagesEl.classList.add("waiting");
    if (connectWaitEl.parentElement !== messagesEl) {
        messagesEl.replaceChildren(connectWaitEl);
    }
}

function syncEmptyHint(): void {
    const show = Boolean(composerEl)
        && !composerEl!.classList.contains("locked")
        && !ui.pendingSend
        && !(ui.state.messages || []).length
        && authEl.hidden
        && !inputEl.value.trim()
        && !(ui.state.attachments || []).length
        && slashEl.hidden;
    if ((ui.state.messages || []).length) {
        ui.pendingSend = false;
    }
    emptyEl.remove();
    if (!composerEl || composerEl.classList.contains("locked")) {
        return;
    }
    if (ui.state.status === "connecting" && !(ui.state.messages || []).length && authEl.hidden) {
        inputEl.placeholder = "等待连接中，可直接输入任务";
        return;
    }
    inputEl.placeholder = show
        ? "在编辑器里选中代码，加入这条对话。"
        : "输入任务，Enter 发送";
}

function placeAuth(): void {
    const footer = document.querySelector("footer");
    const gate = !(ui.state.messages || []).length && !authEl.hidden;
    messagesEl.classList.toggle("stage", gate);
    if (composerEl) {
        composerEl.classList.toggle("locked", gate);
    }
    inputEl.disabled = gate;
    inputEl.placeholder = gate ? "登录后即可输入" : "输入任务，Enter 发送";
    if (gate && composerEl && footer) {
        emptyEl.remove();
        if (usagePillEl) {
            usagePillEl.hidden = true;
        }
        if (slashEl.parentElement !== footer) {
            footer.insertBefore(slashEl, footer.firstChild);
        }
        authEl.append(composerEl);
        stageStack.replaceChildren(authEl, statusEl);
        messagesEl.append(stageStack);
        centerStage();
        syncScrollBottom();
        return;
    }
    stageStack.style.marginTop = "";
    if (stageStack.parentElement) {
        stageStack.remove();
    }
    if (composerEl && footer && composerEl.parentElement !== footer) {
        footer.append(composerEl);
    }
    if (composerEl && footer && composerEl.parentElement === footer) {
        footer.insertBefore(authEl, composerEl);
        if (elicitationEl) {
            footer.insertBefore(elicitationEl, composerEl);
        }
        footer.insertBefore(permissionEl, composerEl);
        footer.insertBefore(slashEl, composerEl);
        if (statusRowEl) {
            if (statusEl.parentElement !== statusRowEl) {
                statusRowEl.prepend(statusEl);
            }
            footer.append(statusRowEl);
        } else {
            footer.append(statusEl);
        }
        syncEmptyHint();
        return;
    }
    if (footer) {
        if (statusRowEl) {
            if (statusEl.parentElement !== statusRowEl) {
                statusRowEl.prepend(statusEl);
            }
            if (statusRowEl.parentElement !== footer) {
                footer.append(statusRowEl);
            }
        } else if (statusEl.parentElement !== footer) {
            footer.append(statusEl);
        }
    }
}

function centerStage(): void {
    stageStack.style.marginTop = "";
    stageStack.scrollTop = stageStack.scrollHeight;
}

window.addEventListener("resize", centerStage);

function computeDetailsOpen(message: StoredMessage, normalizedStatus: string, isUpdate: boolean): boolean {
    const isActive = normalizedStatus === "in_progress" || normalizedStatus === "pending";
    const prevStatus = ui.msgStatus.get(message.id) || "";
    const wasActive = prevStatus === "in_progress" || prevStatus === "pending";
    ui.msgStatus.set(message.id, normalizedStatus);
    if (isUpdate && wasActive && !isActive) {
        ui.userToggled.delete(message.id);
        return normalizedStatus === "failed";
    }
    const saved = ui.userToggled.get(message.id);
    if (saved && saved.status === normalizedStatus) {
        return saved.open;
    }
    return isActive;
}

function postRevealPath(filePath: string): void {
    if (!filePath) {
        return;
    }
    vscode.postMessage({ type: "revealPath", path: filePath });
}

function postOpenFile(filePath: string, line?: number): void {
    if (!filePath) {
        return;
    }
    vscode.postMessage({
        type: "openFile",
        path: filePath,
        line: typeof line === "number" && line > 0 ? line : undefined,
    });
}

function syncLivePulse(): void {
    const busy = Boolean(ui.state.busy);
    if (busy && !ui.busyStartedAt) {
        ui.busyStartedAt = Date.now();
    } else if (!busy) {
        ui.busyStartedAt = 0;
    }

    const msgs = ui.state.messages || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    for (const node of messagesEl.querySelectorAll(".msg.assistant.streaming")) {
        node.classList.remove("streaming");
    }
    const liveNodes = messagesEl.querySelectorAll<HTMLElement>("[data-live-since]");
    for (const el of liveNodes) {
        const since = Number(el.dataset.liveSince || 0);
        const label = el.dataset.liveLabel || "进行中";
        if (since > 0) {
            el.textContent = `${label} · ${formatElapsed(since)}`;
        }
    }

    let indicator = document.getElementById("live-indicator");
    const isStreamingAssistant = busy && last && last.role === "assistant";
    if (isStreamingAssistant && last) {
        const lastNode = messagesEl.querySelector(`.msg.assistant[data-id="${cssEscape(last.id)}"]`);
        if (lastNode) {
            lastNode.classList.add("streaming");
        }
    }

    const showIndicator = busy && msgs.length > 0 && !isStreamingAssistant && liveNodes.length === 0;
    if (showIndicator) {
        if (!indicator) {
            indicator = document.createElement("div");
            indicator.id = "live-indicator";
            indicator.className = "live-indicator enter";
            indicator.innerHTML = '<span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="live-text">Antigravity 正在响应</span><span class="live-time"></span>';
            messagesEl.append(indicator);
            if (nearBottom()) {
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
        }
        const timeEl = indicator.querySelector(".live-time");
        if (timeEl && ui.busyStartedAt) {
            timeEl.textContent = formatElapsed(ui.busyStartedAt);
        }
    } else if (indicator) {
        indicator.remove();
    }

    const needTick = busy || liveNodes.length > 0;
    if (needTick && !ui.liveTimer) {
        ui.liveTimer = window.setInterval(() => {
            if (!ui.state.busy && !messagesEl.querySelector("[data-live-since]")) {
                clearInterval(ui.liveTimer);
                ui.liveTimer = 0;
                syncLivePulse();
                return;
            }
            for (const el of messagesEl.querySelectorAll<HTMLElement>("[data-live-since]")) {
                const since = Number(el.dataset.liveSince || 0);
                const label = el.dataset.liveLabel || "进行中";
                if (since > 0) {
                    el.textContent = `${label} · ${formatElapsed(since)}`;
                }
            }
            const ind = document.getElementById("live-indicator");
            if (ind && ui.busyStartedAt) {
                const timeEl = ind.querySelector(".live-time");
                if (timeEl) {
                    timeEl.textContent = formatElapsed(ui.busyStartedAt);
                }
            }
        }, 200);
    } else if (!needTick && ui.liveTimer) {
        clearInterval(ui.liveTimer);
        ui.liveTimer = 0;
    }
}

function updateDetailsNode(node: HTMLDetailsElement, message: StoredMessage, isUpdate: boolean): void {
    const norm = normalizeToolMeta(message);
    node.dataset.status = norm.status || "";
    if (norm.kind) {
        node.dataset.kind = norm.kind;
    }
    const summary = node.querySelector<HTMLElement>(":scope > summary") || document.createElement("summary");
    if (!summary.parentElement) {
        summary.addEventListener("click", () => {
            queueMicrotask(() => {
                ui.userToggled.set(message.id, { status: norm.status || "", open: node.open });
            });
        });
    }
    summary.replaceChildren();
    const line = document.createElement("span");
    line.className = "tool-line";
    const icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.innerHTML = iconSvg(norm.role === "thought" ? "thought" : norm.kind);
    const name = document.createElement("span");
    name.className = "tool-name";
    const active = norm.status === "in_progress" || norm.status === "pending";
    if (norm.role === "thought") {
        name.textContent = active ? "正在思考" : "已思考";
        line.append(icon, name);
        const preview = !active ? norm.text.replace(/\s+/g, " ").trim() : "";
        if (preview) {
            const sub = document.createElement("span");
            sub.className = "tool-preview";
            sub.textContent = preview.slice(0, 80);
            line.append(sub);
        }
        const dur = durationLabel(message);
        if (dur && !active) {
            const status = document.createElement("span");
            status.className = "tool-status";
            status.textContent = dur;
            line.append(status);
        } else if (active) {
            const status = document.createElement("span");
            status.className = "tool-status";
            const since = message.startedAt || Date.now();
            status.dataset.liveSince = String(since);
            status.dataset.liveLabel = "思考中";
            status.textContent = `思考中 · ${formatElapsed(since)}`;
            line.append(status);
        }
    } else {
        const fileTarget = inferToolFileTarget(message, norm);
        const titleFileMatch = fileTarget
            ? /^(编辑|读取|写入|新建|删除)\s+(.+?)(\s+等\s+\d+\s+个文件)?$/.exec(norm.title || "")
            : null;
        if (fileTarget && titleFileMatch) {
            name.append(document.createTextNode(`${titleFileMatch[1]} `));
            const linkBtn = document.createElement("button");
            linkBtn.type = "button";
            linkBtn.className = "tool-file-link";
            linkBtn.textContent = titleFileMatch[2];
            linkBtn.title = `打开 ${fileTarget.path}${fileTarget.line ? `:${fileTarget.line}` : ""}`;
            linkBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                postOpenFile(fileTarget.path, fileTarget.line);
            });
            name.append(linkBtn);
            if (titleFileMatch[3]) {
                name.append(document.createTextNode(titleFileMatch[3]));
            }
        } else {
            name.textContent = norm.title;
        }
        line.append(icon, name);
        const exitMatch = /^退出\s+(-?\d+)(?:\s*·\s*(.+))?$/.exec(norm.detail || "");
        if (norm.detail && norm.detail !== statusLabel(norm.status) && !exitMatch) {
            const diffStat = /^\+(\d+)\s+-(\d+)$/.exec(norm.detail);
            const isPathDetail = Boolean(fileTarget && !diffStat);
            const detail = isPathDetail ? document.createElement("button") : document.createElement("span");
            const isCompact = Boolean(diffStat) || norm.detail.length <= 14;
            detail.className = isPathDetail
                ? (isCompact ? "tool-detail compact tool-file-btn" : "tool-detail tool-file-btn")
                : (isCompact ? "tool-detail compact" : "tool-detail");
            if (diffStat) {
                const addEl = document.createElement("span");
                addEl.className = "diff-stat-add";
                addEl.textContent = `+${diffStat[1]}`;
                const delEl = document.createElement("span");
                delEl.className = "diff-stat-del";
                delEl.textContent = `-${diffStat[2]}`;
                detail.append(addEl, " ", delEl);
            } else {
                detail.textContent = norm.detail;
                if (detail instanceof HTMLButtonElement && fileTarget) {
                    detail.type = "button";
                    detail.title = `打开 ${fileTarget.path}${fileTarget.line ? `:${fileTarget.line}` : ""}`;
                    detail.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        postOpenFile(fileTarget.path, fileTarget.line);
                    });
                }
            }
            line.append(detail);
        }
        if (active) {
            const status = document.createElement("span");
            status.className = "tool-status";
            const since = message.startedAt || Date.now();
            status.dataset.liveSince = String(since);
            status.dataset.liveLabel = statusLabel(norm.status) || "进行中";
            status.textContent = `${status.dataset.liveLabel} · ${formatElapsed(since)}`;
            line.append(status);
        } else if (exitMatch) {
            const code = Number(exitMatch[1]);
            const dur = exitMatch[2] || durationLabel(message);
            const status = document.createElement("span");
            status.className = code === 0 ? "tool-status ok" : "tool-status";
            status.textContent = code === 0 ? (dur ? `完成 · ${dur}` : "完成") : `退出 ${code}${dur ? ` · ${dur}` : ""}`;
            line.append(status);
        } else {
            const state = statusLabel(norm.status);
            const dur = !(norm.detail || "").includes("s") ? durationLabel(message) : "";
            const badgeText = [state, dur].filter(Boolean).join(" · ");
            if (badgeText) {
                const status = document.createElement("span");
                status.className = norm.status === "completed" ? "tool-status ok" : "tool-status";
                status.textContent = badgeText;
                line.append(status);
            }
        }
    }
    summary.append(line);

    const body = node.querySelector<HTMLElement>(":scope > .body") || document.createElement("div");
    body.className = "body";
    const prevScroll = body.scrollTop;
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    body.replaceChildren();
    if (norm.role === "tool" && Array.isArray(message.diffs) && message.diffs.length) {
        body.append(renderDiffs(message.diffs, postOpenFile));
    } else if (norm.role === "tool" && norm.kind === "execute" && norm.text) {
        const parts = norm.text.split(/\n\n/);
        if (parts[0] && parts[0].startsWith("$ ")) {
            const cmdEl = document.createElement("div");
            cmdEl.className = "cmd-line";
            cmdEl.textContent = parts[0];
            body.append(cmdEl);
            const out = unwrapJsonOutput(parts.slice(1).join("\n\n"));
            if (out.trim()) {
                const pre = document.createElement("pre");
                pre.className = "term-out";
                const code = document.createElement("code");
                code.textContent = out;
                pre.append(code);
                body.append(pre);
            }
        } else {
            const pre = document.createElement("pre");
            pre.className = "term-out";
            const code = document.createElement("code");
            code.textContent = unwrapJsonOutput(norm.text);
            pre.append(code);
            body.append(pre);
        }
    } else if (norm.role === "tool" && norm.kind === "read") {
        const fileTarget = inferToolFileTarget(message, norm);
        if (norm.detail) {
            const pathLine = document.createElement("button");
            pathLine.type = "button";
            pathLine.className = "tool-path-row tool-file-link";
            pathLine.textContent = norm.detail;
            pathLine.title = `打开 ${fileTarget?.path || norm.detail}`;
            pathLine.addEventListener("click", () => {
                postOpenFile(fileTarget?.path || norm.detail, fileTarget?.line);
            });
            body.append(pathLine);
        }
        if (norm.text.trim()) {
            const pre = document.createElement("pre");
            pre.className = "term-out";
            const code = document.createElement("code");
            code.textContent = norm.text;
            pre.append(code);
            body.append(pre);
        }
    } else if (norm.text) {
        body.innerHTML = renderMarkdown(norm.text);
    }

    if (!summary.parentElement) {
        node.append(summary, body);
    }
    node.open = computeDetailsOpen(message, norm.status, isUpdate);
    if (wasAtBottom) {
        body.scrollTop = body.scrollHeight;
    } else {
        body.scrollTop = prevScroll;
    }
}

function renderMessage(message: StoredMessage, prevMessage: StoredMessage | null): HTMLElement {
    const isDetails = message.role === "tool" || message.role === "thought";
    const node = document.createElement(isDetails ? "details" : "div");
    node.className = `msg ${message.role || "assistant"}`;
    node.dataset.id = message.id;
    if (node instanceof HTMLDetailsElement) {
        updateDetailsNode(node, message, false);
        return node;
    }
    if (message.role === "assistant" && (!prevMessage || prevMessage.role !== "assistant")) {
        const head = document.createElement("div");
        head.className = "msg-head";
        const left = document.createElement("span");
        left.className = "msg-head-left";
        left.innerHTML = '<span class="msg-dot" aria-hidden="true"></span><span class="msg-speaker">Antigravity</span>';
        head.append(left);
        if (message.text) {
            head.append(makeCopyButton(message.id));
        }
        node.append(head);
    }
    for (const attachment of message.attachments || []) {
        node.append(renderAttachment(attachment));
    }
    if (message.text) {
        const body = document.createElement("div");
        body.className = "msg-text";
        body.innerHTML = renderMarkdown(message.text);
        node.append(body);
    }
    return node;
}

function makeCopyButton(messageId: string): HTMLButtonElement {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-copy-btn";
    copyBtn.title = "复制回答";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", () => {
        const latest = ui.state.messages.find((item) => item.id === messageId);
        const text = latest?.text || "";
        void navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = "已复制";
            copyBtn.classList.add("copied");
            setTimeout(() => {
                if (copyBtn.isConnected) {
                    copyBtn.textContent = "复制";
                    copyBtn.classList.remove("copied");
                }
            }, 1500);
        }).catch(() => undefined);
    });
    return copyBtn;
}

function syncScrollBottom(): void {
    if (!scrollBottomButton) {
        return;
    }
    const isGate = !(ui.state.messages || []).length && !authEl.hidden;
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    scrollBottomButton.hidden = isGate || distance <= 120;
}

function renderAttachment(attachment: CodeAttachment): HTMLElement {
    const kind = attachment.kind || (attachment.text ? "selection" : "file");
    const targetPath = attachment.relativePath || attachment.fileName || "";
    if (!attachment.text) {
        const pill = document.createElement("div");
        pill.className = "ref ref-path-pill";
        const icon = document.createElement("span");
        icon.className = "ref-icon";
        icon.innerHTML = attachmentIconSvg(kind);
        const pathBtn = targetPath ? document.createElement("button") : document.createElement("span");
        pathBtn.className = targetPath ? "ref-path tool-file-link" : "ref-path";
        pathBtn.textContent = targetPath || "路径";
        if (pathBtn instanceof HTMLButtonElement && targetPath) {
            pathBtn.type = "button";
            pathBtn.title = kind === "directory" ? `在资源管理器中定位 ${targetPath}` : `打开 ${targetPath}`;
            pathBtn.addEventListener("click", () => {
                if (kind === "directory") {
                    postRevealPath(targetPath);
                } else {
                    postOpenFile(targetPath);
                }
            });
        }
        pill.append(icon, pathBtn);
        if (kind === "directory") {
            const tag = document.createElement("span");
            tag.className = "ref-kind-tag";
            tag.textContent = "目录";
            pill.append(tag);
        }
        return pill;
    }
    const block = document.createElement("div");
    block.className = "ref";
    const head = document.createElement("div");
    head.className = "ref-head";
    const pathEl = targetPath ? document.createElement("button") : document.createElement("span");
    pathEl.className = targetPath ? "ref-path tool-file-link" : "ref-path";
    pathEl.textContent = targetPath || "选区";
    if (pathEl instanceof HTMLButtonElement && targetPath) {
        pathEl.type = "button";
        pathEl.title = `打开 ${targetPath}${attachment.startLine ? `:${attachment.startLine}` : ""}`;
        pathEl.addEventListener("click", () => postOpenFile(targetPath, attachment.startLine));
    }
    const range = document.createElement("span");
    range.textContent = lineLabel(attachment.startLine, attachment.endLine);
    head.append(pathEl, range);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = attachment.text || "";
    pre.append(code);
    block.append(head, pre);
    return block;
}

function renderChrome(): void {
    applyTypography(ui);
    const busy = Boolean(ui.state.busy);
    sendEl.textContent = busy ? "停止" : "发送";
    sendEl.classList.toggle("stop", busy);
    const fullStatus = statusText();
    const caption = statusCaption(fullStatus);
    statusEl.textContent = caption;
    statusEl.title = fullStatus.length > caption.length ? `${fullStatus}（点击打开设置）` : "点击打开设置与代理配置";
    statusEl.hidden = !caption;
    statusEl.dataset.state = ui.state.status || "";
    renderBarTitle();
    renderHistory(historyCtx);
    renderSettings(settingsCtx, false);
    renderElicitation(elicitationCtx);
    renderPermission();
    renderAuth();
    syncConnectWait();
    const isGate = !(ui.state.messages || []).length && !authEl.hidden;
    renderUsage(usageCtx);
    renderUsagePill(usagePillEl, ui, isGate);
    renderSelectors();
    renderChips();
    renderSlash();
    syncLivePulse();
    resizeInput();
    syncSend();
    syncScrollBottom();
}

function syncSend(): void {
    const busy = Boolean(ui.state.busy);
    const ready = inputEl.value.trim().length > 0 || (ui.state.attachments || []).length > 0;
    sendEl.disabled = !busy && !ready && !inputEl.disabled;
}

function renderBarTitle(): void {
    const name = document.querySelector(".brand-name");
    if (!name) {
        return;
    }
    const chat = (ui.state.chats || []).find((item) => item.id === ui.state.activeId);
    const title = chat && chat.title ? chat.title : "新对话";
    if (name.textContent !== title) {
        name.textContent = title;
    }
}

function renderChips(): void {
    const attachments = ui.state.attachments || [];
    const signature = JSON.stringify(attachments.map((item) => [item.id, item.kind, item.relativePath, item.startLine, item.endLine]));
    chipsEl.hidden = attachments.length === 0;
    if (signature === ui.chipSignature) {
        return;
    }
    ui.chipSignature = signature;
    chipsEl.replaceChildren();
    for (const attachment of attachments) {
        const kind = attachment.kind || (attachment.text ? "selection" : "file");
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.title = attachment.relativePath || "";
        const icon = document.createElement("span");
        icon.className = "chip-icon";
        icon.innerHTML = attachmentIconSvg(kind);
        const pathEl = attachment.relativePath ? document.createElement("button") : document.createElement("span");
        pathEl.className = attachment.relativePath ? "chip-path tool-file-link" : "chip-path";
        pathEl.textContent = attachment.fileName || attachment.relativePath || "选区";
        if (pathEl instanceof HTMLButtonElement && attachment.relativePath) {
            pathEl.type = "button";
            pathEl.title = kind === "directory"
                ? `在资源管理器中定位 ${attachment.relativePath}`
                : `打开 ${attachment.relativePath}${attachment.startLine ? `:${attachment.startLine}` : ""}`;
            pathEl.addEventListener("click", (e) => {
                e.stopPropagation();
                if (kind === "directory") {
                    postRevealPath(attachment.relativePath);
                } else {
                    postOpenFile(attachment.relativePath, attachment.startLine);
                }
            });
        }
        const range = document.createElement("span");
        range.className = "chip-range";
        range.textContent = kind === "directory" ? "目录" : lineLabel(attachment.startLine, attachment.endLine);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "移除路径");
        remove.addEventListener("click", () => vscode.postMessage({ type: "removeAttachment", id: attachment.id }));
        chip.append(icon, pathEl, range, remove);
        chipsEl.append(chip);
    }
}

function renderPermission(): void {
    const permission = ui.state.permission;
    if (!permission) {
        permissionEl.hidden = true;
        permissionEl.replaceChildren();
        return;
    }
    permissionEl.hidden = false;
    permissionEl.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = permission.title || "需要确认";
    permissionEl.append(title);
    if (permission.detail) {
        const detail = document.createElement("pre");
        detail.textContent = permission.detail;
        permissionEl.append(detail);
    }
    const choices = document.createElement("div");
    choices.className = "choices";
    const secondary: HTMLButtonElement[] = [];
    const primary: HTMLButtonElement[] = [];
    for (const option of permission.options || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = option.name || option.id;
        if (String(option.kind).startsWith("allow")) {
            button.className = "primary";
            primary.push(button);
        } else {
            secondary.push(button);
        }
        button.addEventListener("click", () => {
            vscode.postMessage({ type: "permission", requestId: permission.requestId, optionId: option.id });
        });
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
    choices.append(cancel, ...secondary, ...primary);
    permissionEl.append(choices);
}

function renderAuth(): void {
    if (composerEl && composerEl.parentElement === authEl) {
        composerEl.remove();
    }
    const show = ui.state.status === "auth";
    if (!show) {
        ui.proxyMenu = false;
        authEl.hidden = true;
        authEl.replaceChildren();
        placeAuth();
        return;
    }
    const previous = authEl.querySelector<HTMLInputElement>(".proxy-edit input");
    const editing = ui.proxyMenu && previous && document.activeElement === previous ? previous.value : null;
    authEl.hidden = false;
    authEl.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "登录后继续";
    const note = document.createElement("p");
    note.textContent = "当前对话会保留。";
    const choices = document.createElement("div");
    choices.className = "choices";
    if (ui.proxyMenu) {
        choices.append(proxyBackRow(), proxyEditRow(editing));
        authEl.append(title, choices);
    } else {
        const google = (ui.state.authMethods || []).find((method) => method.id === "oauth-personal" || /google/i.test(method.name || ""));
        if (google) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "primary";
            button.textContent = google.name || "Log in with Google";
            button.addEventListener("click", () => vscode.postMessage({ type: "login", methodId: google.id }));
            choices.append(button);
        }
        choices.append(proxyEntryRow());
        authEl.append(title, note, choices);
    }
    placeAuth();
}

function proxyEntryRow(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "proxy";
    const name = document.createElement("span");
    name.textContent = "代理";
    button.append(name);
    const current = proxyDisplay(ui.state.proxyUrl);
    if (current) {
        const value = document.createElement("span");
        value.className = "proxy-value";
        value.textContent = current;
        button.append(value);
    }
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        ui.proxyMenu = true;
        ui.proxyDraft = null;
        ui.proxyCaret = null;
        ui.proxyFocused = true;
        renderAuth();
    });
    return button;
}

function proxyBackRow(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "back";
    button.textContent = "保存并返回";
    button.addEventListener("click", () => closeProxyMenu(true));
    return button;
}

function proxyEditRow(editing: string | null): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "proxy-edit";
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "127.0.0.1:7890（留空使用编辑器代理）";
    if (typeof ui.proxyDraft !== "string") {
        ui.proxyDraft = editing !== null ? editing : proxyDisplay((ui.state.settings && ui.state.settings.proxy) || ui.state.proxyUrl);
    }
    input.value = ui.proxyDraft;
    input.addEventListener("input", () => {
        ui.proxyDraft = input.value;
    });
    input.addEventListener("keydown", (event) => {
        if (event.isComposing || event.keyCode === 229) {
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            closeProxyMenu(true);
        } else if (event.key === "Escape") {
            event.preventDefault();
            closeProxyMenu(false);
        }
    });
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "proxy-save-btn";
    saveBtn.textContent = "应用";
    saveBtn.addEventListener("click", () => closeProxyMenu(true));
    row.append(input, saveBtn);
    if (ui.proxyFocused) {
        const caret = ui.proxyCaret;
        requestAnimationFrame(() => {
            if (!input.isConnected) {
                return;
            }
            input.focus();
            if (typeof caret === "number") {
                input.setSelectionRange(caret, caret);
            }
        });
    }
    return row;
}

function closeProxyMenu(commit: boolean): void {
    captureProxyDraft();
    const raw = String(ui.proxyDraft ?? "").trim();
    const prevExplicit = proxyDisplay((ui.state.settings && ui.state.settings.proxy) || "");
    const prevEffective = proxyDisplay(ui.state.proxyUrl);
    ui.proxyMenu = false;
    ui.proxyDraft = null;
    ui.proxyCaret = null;
    ui.proxyFocused = true;
    if (commit && (raw !== prevExplicit || (raw && raw !== prevEffective))) {
        vscode.postMessage({ type: "setProxy", proxy: raw });
    }
    renderAuth();
}

function captureProxyDraft(): void {
    if (!ui.proxyMenu) {
        return;
    }
    const input = authEl.querySelector<HTMLInputElement>(".proxy-edit input");
    if (input) {
        ui.proxyDraft = input.value;
        ui.proxyCaret = input.selectionStart;
        ui.proxyFocused = document.activeElement === input;
    }
}

function statusText(): string {
    return String(ui.state.statusText || "").replace(/\s+/g, " ").trim();
}

function statusCaption(text?: string): string {
    const value = text === undefined || text === null ? statusText() : text;
    if (!value) {
        return "";
    }
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

function renderSelectors(): void {
    const signature = JSON.stringify({
        modes: ui.state.modes,
        currentModeId: ui.state.currentModeId,
        options: ui.state.options,
    });
    if (signature === ui.selectSignature) {
        return;
    }
    ui.selectSignature = signature;
    closePicker();
    selectorsEl.replaceChildren();
    if ((ui.state.modes || []).length) {
        const modeChoices: SelectChoice[] = ui.state.modes.map((mode) => ({
            value: mode.id,
            name: mode.name,
            description: mode.description,
        }));
        const mode = makePicker("mode", "模式", modeChoices, ui.state.currentModeId, (value) => {
            vscode.postMessage({ type: "setMode", modeId: value });
        });
        selectorsEl.append(mode);
    }
    for (const option of ui.state.options || []) {
        const id = String(option.id || "").toLowerCase();
        const cat = String(option.category || "").toLowerCase();
        const kind = (id === "thought_level" || id === "thinking_level" || cat === "thought_level" || cat === "thought")
            ? "thought_level"
            : (id === "model" || cat === "model" ? "model" : (option.category || "option"));
        selectorsEl.append(makePicker(kind, option.name, option.options, option.current, (value) => {
            vscode.postMessage({ type: "setOption", configId: option.id, value });
        }));
    }
}

function applySlash(command: CommandView | undefined): void {
    if (!command) {
        return;
    }
    inputEl.value = `/${command.name} `;
    ui.slashDismissed = false;
    ui.slashMoved = false;
    inputEl.focus();
    resizeInput();
    renderSlash();
    syncSend();
}

function renderSlash(scrollActive?: boolean): void {
    const value = inputEl.value;
    const match = /^\/([^\s]*)$/.exec(value);
    const commands = ui.state.commands || [];
    if (!match || !commands.length || ui.slashDismissed) {
        ui.slashMatches = [];
        ui.slashQuery = "";
        ui.slashIndex = 0;
        ui.slashMoved = false;
        slashEl.hidden = true;
        slashEl.replaceChildren();
        syncEmptyHint();
        return;
    }
    const query = match[1].toLowerCase();
    const matched = commands.filter((command) => command.name.toLowerCase().includes(query));
    if (query !== ui.slashQuery) {
        ui.slashQuery = query;
        ui.slashIndex = 0;
        ui.slashMoved = false;
    }
    ui.slashMatches = matched;
    if (!matched.length) {
        slashEl.hidden = true;
        slashEl.replaceChildren();
        syncEmptyHint();
        return;
    }
    if (ui.slashIndex >= matched.length) {
        ui.slashIndex = 0;
    }
    slashEl.hidden = false;
    slashEl.replaceChildren();
    matched.forEach((command, index) => {
        const button = document.createElement("button");
        button.type = "button";
        if (index === ui.slashIndex) {
            button.className = "active";
        }
        const name = document.createElement("span");
        name.textContent = `/${command.name}`;
        button.append(name);
        if (command.description) {
            const description = document.createElement("span");
            description.className = "slash-desc";
            description.textContent = command.description;
            button.append(description);
        }
        button.addEventListener("mouseenter", () => {
            if (ui.slashIndex === index) {
                return;
            }
            const prev = slashEl.querySelector("button.active");
            if (prev) {
                prev.classList.remove("active");
            }
            ui.slashIndex = index;
            button.classList.add("active");
        });
        button.addEventListener("click", () => applySlash(command));
        slashEl.append(button);
        if (scrollActive && index === ui.slashIndex) {
            button.scrollIntoView({ block: "nearest" });
        }
    });
    syncEmptyHint();
}

function closePicker(): void {
    const menu = document.getElementById("picker-menu");
    if (menu) {
        menu.remove();
    }
    if (ui.openPicker?.btn) {
        ui.openPicker.btn.setAttribute("aria-expanded", "false");
        ui.openPicker.btn.closest(".picker")?.classList.remove("open");
    }
    ui.openPicker = null;
}

function openPickerMenu(
    key: string,
    label: string,
    items: SelectChoice[],
    current: string,
    btn: HTMLButtonElement,
    onChange: (value: string) => void,
): void {
    if (ui.openPicker && ui.openPicker.key === key) {
        closePicker();
        return;
    }
    closePicker();
    const menu = document.createElement("div");
    menu.id = "picker-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", label);
    const head = document.createElement("div");
    head.className = "picker-menu-head";
    head.textContent = label;
    menu.append(head);
    for (const item of items) {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = `picker-opt${item.value === current ? " active" : ""}`;
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", item.value === current ? "true" : "false");
        const row = document.createElement("div");
        row.className = "picker-opt-row";
        const check = document.createElement("span");
        check.className = "picker-check";
        check.textContent = item.value === current ? "✓" : "";
        const title = document.createElement("span");
        title.className = "picker-opt-name";
        title.textContent = item.name || item.value;
        row.append(check, title);
        opt.append(row);
        if (item.description) {
            const desc = document.createElement("div");
            desc.className = "picker-opt-desc";
            desc.textContent = item.description;
            opt.append(desc);
        }
        opt.addEventListener("click", () => {
            closePicker();
            if (item.value !== current) {
                onChange(item.value);
            }
        });
        menu.append(opt);
    }
    document.body.append(menu);
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
    const bottom = window.innerHeight - rect.top + 6;
    menu.style.left = `${left}px`;
    menu.style.bottom = `${bottom}px`;
    btn.setAttribute("aria-expanded", "true");
    btn.closest(".picker")?.classList.add("open");
    ui.openPicker = { key, btn };
}

function makePicker(
    kind: string,
    label: string,
    choices: SelectChoice[],
    current: string,
    onChange: (value: string) => void,
): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = `picker ${kind}`;
    const seen = new Set<string>();
    const items: SelectChoice[] = [];
    const list = Array.isArray(choices) ? choices.slice() : [];
    if (current && !list.some((item) => item.value === current)) {
        list.unshift({ value: current, name: current });
    }
    for (const item of list) {
        if (!item || seen.has(item.value)) {
            continue;
        }
        seen.add(item.value);
        items.push(item);
    }
    const selected = items.find((item) => item.value === current) || items[0];
    wrap.dataset.value = selected ? selected.value : "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.title = selected ? `${label}：${selected.name}` : label;
    if (kind === "thought_level") {
        const icon = document.createElement("span");
        icon.className = "picker-icon";
        icon.innerHTML = iconSvg("thought");
        btn.append(icon);
    }
    const text = document.createElement("span");
    text.className = "picker-text";
    text.textContent = selected ? selected.name : label;
    const caret = document.createElement("span");
    caret.className = "picker-caret";
    caret.setAttribute("aria-hidden", "true");
    btn.append(text, caret);
    btn.addEventListener("click", (event) => {
        event.stopPropagation();
        openPickerMenu(`${kind}:${label}`, label, items, current, btn, onChange);
    });
    wrap.append(btn);
    return wrap;
}

function nearBottom(): boolean {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function resizeInput(): void {
    const composer = inputEl.closest(".composer");
    if (composer && composer.classList.contains("locked")) {
        inputEl.style.height = "";
        return;
    }
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}
