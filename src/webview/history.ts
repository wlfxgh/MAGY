import { ICON_CHAT, ICON_CLOSE, ICON_DELETE, ICON_IMPORT, ICON_PLUS, ICON_SEARCH } from "./icons";
import type { ChatMeta, UiState, VsCodeApi } from "./types";
import { formatRelativeTime, formatTime, formatTokenCount, historyBucket } from "./utils";

export interface HistoryContext {
    ui: UiState;
    historyEl: HTMLElement;
    historyButton: HTMLElement;
    vscode: VsCodeApi;
    setHistoryOpen: (open: boolean) => void;
}

export function renderHistory(ctx: HistoryContext): void {
    const { ui, historyEl, historyButton, vscode, setHistoryOpen } = ctx;
    historyEl.hidden = !ui.historyOpen;
    historyButton.classList.toggle("active", ui.historyOpen);
    historyButton.setAttribute("aria-pressed", ui.historyOpen ? "true" : "false");
    if (!ui.historyOpen) {
        return;
    }
    const chats = Array.isArray(ui.state.chats) ? ui.state.chats : [];
    const signature = JSON.stringify([
        chats.map((chat) => [chat.id, chat.title, chat.updatedAt, chat.imported, chat.count, chat.preview, chat.totalTokens]),
        ui.state.activeId,
    ]);
    if (!historyEl.querySelector(".history-shell")) {
        historyEl.replaceChildren();
        const shell = document.createElement("div");
        shell.className = "history-shell";

        const head = document.createElement("div");
        head.className = "history-head";
        const headLeft = document.createElement("div");
        headLeft.className = "history-head-left";
        const headTitle = document.createElement("span");
        headTitle.className = "history-head-title";
        headTitle.textContent = "历史对话";
        const headCount = document.createElement("span");
        headCount.className = "history-head-count";
        headLeft.append(headTitle, headCount);

        const headActions = document.createElement("div");
        headActions.className = "history-head-actions";
        const newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.className = "history-head-btn";
        newBtn.title = "新建对话";
        newBtn.innerHTML = `${ICON_PLUS}<span>新建</span>`;
        newBtn.addEventListener("click", () => {
            setHistoryOpen(false);
            vscode.postMessage({ type: "newChat" });
        });
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "history-close-btn";
        closeBtn.title = "关闭 (Esc)";
        closeBtn.setAttribute("aria-label", "关闭历史面板");
        closeBtn.innerHTML = ICON_CLOSE;
        closeBtn.addEventListener("click", () => setHistoryOpen(false));
        headActions.append(newBtn, closeBtn);
        head.append(headLeft, headActions);

        const searchWrap = document.createElement("div");
        searchWrap.className = "history-search-wrap";
        const searchIcon = document.createElement("span");
        searchIcon.className = "history-search-icon";
        searchIcon.innerHTML = ICON_SEARCH;
        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.className = "history-search";
        searchInput.placeholder = "搜索对话标题或内容...";
        searchInput.value = ui.historyQuery;
        const searchClear = document.createElement("button");
        searchClear.type = "button";
        searchClear.className = "history-search-clear";
        searchClear.title = "清空搜索";
        searchClear.textContent = "×";
        searchClear.hidden = !ui.historyQuery;

        searchInput.addEventListener("input", () => {
            ui.historyQuery = searchInput.value;
            ui.historyIndex = ui.historyQuery.trim() ? 0 : -1;
            searchClear.hidden = !ui.historyQuery;
            renderHistoryItems(ctx);
        });
        searchInput.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            const items = Array.from(historyEl.querySelectorAll<HTMLElement>(".history-item"));
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (items.length) {
                    ui.historyIndex = (ui.historyIndex + 1 + items.length) % items.length;
                    syncHistoryFocus(ui, items);
                }
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                if (items.length) {
                    ui.historyIndex = ui.historyIndex <= 0 ? items.length - 1 : ui.historyIndex - 1;
                    syncHistoryFocus(ui, items);
                }
                return;
            }
            if (event.key === "Enter" && items.length) {
                const idx = ui.historyIndex >= 0 && ui.historyIndex < items.length ? ui.historyIndex : 0;
                const chatId = items[idx]?.dataset?.chatId;
                if (chatId) {
                    event.preventDefault();
                    setHistoryOpen(false);
                    vscode.postMessage({ type: "selectChat", id: chatId });
                }
            }
        });
        searchClear.addEventListener("click", () => {
            ui.historyQuery = "";
            ui.historyIndex = -1;
            searchInput.value = "";
            searchClear.hidden = true;
            renderHistoryItems(ctx);
            searchInput.focus();
        });
        searchWrap.append(searchIcon, searchInput, searchClear);

        const list = document.createElement("div");
        list.className = "history-list";
        const confirmBar = document.createElement("div");
        confirmBar.className = "history-confirm";
        confirmBar.hidden = true;
        shell.append(head, searchWrap, list, confirmBar);
        historyEl.append(shell);
        ui.historySignature = "";
    }

    const countEl = historyEl.querySelector<HTMLElement>(".history-head-count");
    if (countEl) {
        countEl.textContent = chats.length ? `${chats.length}` : "";
        countEl.hidden = !chats.length;
    }
    const searchWrapEl = historyEl.querySelector<HTMLElement>(".history-search-wrap");
    if (searchWrapEl) {
        searchWrapEl.hidden = chats.length <= 1 && !ui.historyQuery;
    }
    const searchInputEl = historyEl.querySelector<HTMLInputElement>(".history-search");
    if (searchInputEl && searchInputEl.value !== ui.historyQuery) {
        searchInputEl.value = ui.historyQuery;
    }
    const searchClearEl = historyEl.querySelector<HTMLElement>(".history-search-clear");
    if (searchClearEl) {
        searchClearEl.hidden = !ui.historyQuery;
    }

    if (signature !== ui.historySignature) {
        ui.historySignature = signature;
        if (ui.historyConfirmId && !chats.some((c) => c.id === ui.historyConfirmId)) {
            ui.historyConfirmId = "";
        }
        renderHistoryItems(ctx);
        renderHistoryConfirm(ctx);
    }
}

export function renderHistoryConfirm(ctx: HistoryContext): void {
    const { ui, historyEl, vscode } = ctx;
    const confirmBar = historyEl.querySelector<HTMLElement>(".history-confirm");
    if (!confirmBar) {
        return;
    }
    const chats = Array.isArray(ui.state.chats) ? ui.state.chats : [];
    const target = ui.historyConfirmId ? chats.find((c) => c.id === ui.historyConfirmId) : null;
    if (!target) {
        confirmBar.hidden = true;
        confirmBar.replaceChildren();
        return;
    }
    confirmBar.hidden = false;
    confirmBar.replaceChildren();
    const text = document.createElement("div");
    text.className = "history-confirm-text";
    const name = target.title || "未命名对话";
    text.textContent = `确定删除「${name}」？删除后不可恢复。`;
    const actions = document.createElement("div");
    actions.className = "history-confirm-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "history-confirm-cancel";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        ui.historyConfirmId = "";
        renderHistoryConfirm(ctx);
        renderHistoryItems(ctx);
    });
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "history-confirm-ok";
    okBtn.textContent = "确认删除";
    okBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = target.id;
        ui.historyConfirmId = "";
        renderHistoryConfirm(ctx);
        vscode.postMessage({ type: "deleteChat", id });
    });
    actions.append(cancelBtn, okBtn);
    confirmBar.append(text, actions);
}

function syncHistoryFocus(ui: UiState, items: HTMLElement[]): void {
    items.forEach((node, index) => {
        node.classList.toggle("focused", index === ui.historyIndex);
    });
    const target = items[ui.historyIndex];
    if (target) {
        target.scrollIntoView({ block: "nearest" });
    }
}

export function renderHistoryItems(ctx: HistoryContext): void {
    const { ui, historyEl, vscode, setHistoryOpen } = ctx;
    const listEl = historyEl.querySelector<HTMLElement>(".history-list");
    if (!listEl) {
        return;
    }
    listEl.replaceChildren();
    const chats = Array.isArray(ui.state.chats) ? ui.state.chats : [];
    if (!chats.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.innerHTML = '<div class="history-empty-title">暂无历史对话</div><div class="history-empty-note">发送第一条消息或引入 Cursor 对话后，记录会保留在这里。</div>';
        listEl.append(empty);
        return;
    }
    const needle = ui.historyQuery.trim().toLowerCase();
    const filtered = needle
        ? chats.filter((chat) => `${chat.title || ""}\n${chat.preview || ""}`.toLowerCase().includes(needle))
        : chats;
    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        const title = document.createElement("div");
        title.className = "history-empty-title";
        title.textContent = `未找到匹配“${ui.historyQuery.trim()}”的对话`;
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "history-empty-reset";
        reset.textContent = "清除搜索";
        reset.addEventListener("click", () => {
            ui.historyQuery = "";
            ui.historyIndex = -1;
            const searchInputEl = historyEl.querySelector<HTMLInputElement>(".history-search");
            const searchClearEl = historyEl.querySelector<HTMLElement>(".history-search-clear");
            if (searchInputEl) {
                searchInputEl.value = "";
                searchInputEl.focus();
            }
            if (searchClearEl) {
                searchClearEl.hidden = true;
            }
            renderHistoryItems(ctx);
        });
        empty.append(title, reset);
        listEl.append(empty);
        return;
    }

    const groups = new Map<string, ChatMeta[]>();
    for (const chat of filtered) {
        const label = historyBucket(chat.updatedAt);
        let groupList = groups.get(label);
        if (!groupList) {
            groupList = [];
            groups.set(label, groupList);
        }
        groupList.push(chat);
    }

    let flatIndex = 0;
    for (const [groupLabel, groupChats] of groups) {
        const groupHead = document.createElement("div");
        groupHead.className = "history-group";
        groupHead.textContent = groupLabel;
        listEl.append(groupHead);

        for (const chat of groupChats) {
            const isActive = chat.id === ui.state.activeId;
            const isConfirming = ui.historyConfirmId === chat.id;
            const row = document.createElement("div");
            row.className = `history-item${isActive ? " active" : ""}${isConfirming ? " deleting" : ""}${flatIndex === ui.historyIndex ? " focused" : ""}`;
            row.dataset.chatId = chat.id;
            row.setAttribute("role", "button");
            row.tabIndex = 0;
            flatIndex += 1;

            const icon = document.createElement("span");
            icon.className = "history-item-icon";
            icon.innerHTML = chat.imported ? ICON_IMPORT : ICON_CHAT;

            const main = document.createElement("div");
            main.className = "history-item-main";

            const top = document.createElement("div");
            top.className = "history-item-top";
            const title = document.createElement("span");
            title.className = "history-title";
            title.textContent = chat.title || "未命名对话";
            top.append(title);
            if (chat.imported) {
                const badge = document.createElement("span");
                badge.className = "history-tag";
                badge.textContent = "Cursor";
                top.append(badge);
            }
            if (isActive) {
                const cur = document.createElement("span");
                cur.className = "history-tag current";
                cur.textContent = "当前";
                top.append(cur);
            }
            const time = document.createElement("span");
            time.className = "history-time";
            time.textContent = formatRelativeTime(chat.updatedAt);
            time.title = formatTime(chat.updatedAt);
            top.append(time);

            const sub = document.createElement("div");
            sub.className = "history-sub";
            const count = typeof chat.count === "number" ? chat.count : undefined;
            const preview = (chat.preview || "").trim();
            const showPreview = Boolean(preview) && preview !== (chat.title || "").trim();
            const parts: string[] = [];
            if (showPreview) {
                parts.push(preview);
            } else if (count === 0) {
                parts.push("空白对话");
            }
            if (count && count > 0) {
                parts.push(`${count} 条消息`);
            }
            if (typeof chat.totalTokens === "number" && chat.totalTokens > 0) {
                parts.push(`${formatTokenCount(chat.totalTokens)} tok`);
            }
            sub.textContent = parts.join(" · ") || formatTime(chat.updatedAt);

            main.append(top, sub);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = `history-del${isConfirming ? " confirming" : ""}`;
            remove.title = "删除对话";
            remove.setAttribute("aria-label", "删除对话");
            remove.innerHTML = ICON_DELETE;
            remove.addEventListener("click", (event) => {
                event.stopPropagation();
                ui.historyConfirmId = isConfirming ? "" : chat.id;
                renderHistoryConfirm(ctx);
                renderHistoryItems(ctx);
            });

            const selectThis = (): void => {
                ui.historyConfirmId = "";
                setHistoryOpen(false);
                vscode.postMessage({ type: "selectChat", id: chat.id });
            };
            row.addEventListener("click", selectThis);
            row.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectThis();
                }
            });

            row.append(icon, main, remove);
            listEl.append(row);
        }
    }
}
