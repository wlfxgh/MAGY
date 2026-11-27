import { ICON_CLOSE, ICON_EXTERNAL } from "./icons";
import type { SettingsPatch, SettingsView, UiState, VsCodeApi } from "./types";
import { clampFontSize, DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, proxyDisplay } from "./utils";

export interface SettingsContext {
    ui: UiState;
    settingsEl: HTMLElement | null;
    settingsButton: HTMLElement | null;
    vscode: VsCodeApi;
    setSettingsOpen: (open: boolean) => void;
    resizeInput: () => void;
}

export function currentSettings(ui: UiState): SettingsView {
    const s = ui.state.settings;
    return {
        proxy: String(s?.proxy ?? ""),
        effectiveProxy: String(s?.effectiveProxy ?? ui.state.proxyUrl ?? ""),
        noProxy: String(s?.noProxy ?? "localhost,127.0.0.1,::1"),
        dangerouslySkipPermissions: Boolean(s?.dangerouslySkipPermissions),
        sandbox: Boolean(s?.sandbox),
        binaryPath: String(s?.binaryPath ?? ""),
        cursorDataDir: String(s?.cursorDataDir ?? ""),
        fontSize: clampFontSize(s?.fontSize),
    };
}

export function applyTypography(ui: UiState): void {
    const size = clampFontSize(currentSettings(ui).fontSize);
    document.documentElement.style.setProperty("--magy-font-size", `${size}px`);
}

function normalizeProxyInput(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function markPendingField(el: HTMLInputElement, displayValue: string): void {
    el.dataset.dirty = "";
    el.dataset.pendingValue = displayValue;
    el.dataset.pendingUntil = String(Date.now() + 3000);
}

function clearFieldTracking(el: HTMLInputElement): void {
    el.dataset.dirty = "";
    el.dataset.pendingValue = "";
    el.dataset.pendingUntil = "";
}

function attachDraftHandlers(el: HTMLInputElement): void {
    el.addEventListener("input", () => {
        el.dataset.dirty = "1";
    });
    el.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            el.dataset.dirty = "";
        }
    });
}

function syncProxyHint(settingsEl: HTMLElement, cfg: SettingsView): void {
    const proxyHint = settingsEl.querySelector<HTMLElement>('[data-hint="proxy"]');
    if (!proxyHint) {
        return;
    }
    const effective = proxyDisplay(cfg.effectiveProxy);
    const explicit = proxyDisplay(cfg.proxy);
    if (explicit) {
        proxyHint.textContent = `当前已指定：${explicit}`;
    } else if (effective) {
        proxyHint.textContent = `当前自动继承编辑器代理：${effective}`;
    } else {
        proxyHint.textContent = "当前未启用代理";
    }
}

function flashSettingsSaved(ui: UiState, settingsEl: HTMLElement | null, text: string): void {
    if (!settingsEl) {
        return;
    }
    const badge = settingsEl.querySelector<HTMLElement>(".settings-saved");
    if (!badge) {
        return;
    }
    badge.textContent = text || "已保存";
    badge.hidden = false;
    clearTimeout(ui.settingsFeedbackTimer);
    ui.settingsFeedbackTimer = window.setTimeout(() => {
        if (badge.isConnected) {
            badge.hidden = true;
        }
    }, 2000);
}

export function renderSettings(ctx: SettingsContext, resetInputs: boolean): void {
    const { ui, settingsEl, settingsButton, vscode, setSettingsOpen, resizeInput } = ctx;
    if (!settingsEl) {
        return;
    }
    settingsEl.hidden = !ui.settingsOpen;
    if (settingsButton) {
        settingsButton.classList.toggle("active", ui.settingsOpen);
        settingsButton.setAttribute("aria-pressed", ui.settingsOpen ? "true" : "false");
    }
    if (!ui.settingsOpen) {
        return;
    }
    const cfg = currentSettings(ui);
    if (!settingsEl.querySelector(".settings-shell")) {
        settingsEl.replaceChildren();
        const shell = document.createElement("div");
        shell.className = "settings-shell";

        const head = document.createElement("div");
        head.className = "settings-head";
        const headLeft = document.createElement("div");
        headLeft.className = "settings-head-left";
        const headTitle = document.createElement("span");
        headTitle.className = "settings-head-title";
        headTitle.textContent = "MAGY 设置";
        const savedBadge = document.createElement("span");
        savedBadge.className = "settings-saved";
        savedBadge.hidden = true;
        headLeft.append(headTitle, savedBadge);

        const headActions = document.createElement("div");
        headActions.className = "settings-head-actions";
        const ideBtn = document.createElement("button");
        ideBtn.type = "button";
        ideBtn.className = "history-head-btn";
        ideBtn.title = "在编辑器设置中打开";
        ideBtn.innerHTML = `${ICON_EXTERNAL}<span>全部设置</span>`;
        ideBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "openIdeSettings" });
        });
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "history-close-btn";
        closeBtn.title = "关闭 (Esc)";
        closeBtn.setAttribute("aria-label", "关闭设置面板");
        closeBtn.innerHTML = ICON_CLOSE;
        closeBtn.addEventListener("click", () => setSettingsOpen(false));
        headActions.append(ideBtn, closeBtn);
        head.append(headLeft, headActions);

        const body = document.createElement("div");
        body.className = "settings-body";

        const displayGroup = document.createElement("div");
        displayGroup.className = "settings-group";
        const displayTitle = document.createElement("div");
        displayTitle.className = "settings-group-title";
        displayTitle.textContent = "外观与排版";

        const fontField = document.createElement("div");
        fontField.className = "settings-field";
        const fontLabel = document.createElement("label");
        fontLabel.textContent = "字体大小";
        const fontRow = document.createElement("div");
        fontRow.className = "settings-font-row";

        const fontStepper = document.createElement("div");
        fontStepper.className = "settings-font-stepper";
        const decBtn = document.createElement("button");
        decBtn.type = "button";
        decBtn.className = "settings-mini-btn settings-font-step";
        decBtn.dataset.fontAction = "dec";
        decBtn.title = "减小字体";
        decBtn.textContent = "A-";

        const fontValueWrap = document.createElement("div");
        fontValueWrap.className = "settings-font-value";
        const fontInput = document.createElement("input");
        fontInput.type = "number";
        fontInput.min = String(MIN_FONT_SIZE);
        fontInput.max = String(MAX_FONT_SIZE);
        fontInput.step = "1";
        fontInput.dataset.field = "fontSize";
        fontInput.className = "settings-font-input";
        fontInput.setAttribute("aria-label", "字体大小（像素）");
        const fontUnit = document.createElement("span");
        fontUnit.className = "settings-font-unit";
        fontUnit.textContent = "px";
        fontValueWrap.append(fontInput, fontUnit);

        const incBtn = document.createElement("button");
        incBtn.type = "button";
        incBtn.className = "settings-mini-btn settings-font-step";
        incBtn.dataset.fontAction = "inc";
        incBtn.title = "增大字体";
        incBtn.textContent = "A+";
        fontStepper.append(decBtn, fontValueWrap, incBtn);

        const fontResetBtn = document.createElement("button");
        fontResetBtn.type = "button";
        fontResetBtn.className = "settings-mini-btn ghost";
        fontResetBtn.dataset.fontAction = "reset";
        fontResetBtn.textContent = "默认";

        const commitFontSize = (raw: unknown): void => {
            const next = clampFontSize(raw);
            ui.state.settings = Object.assign({}, currentSettings(ui), { fontSize: next });
            fontInput.value = String(next);
            markPendingField(fontInput, String(next));
            decBtn.disabled = next <= MIN_FONT_SIZE;
            incBtn.disabled = next >= MAX_FONT_SIZE;
            fontResetBtn.disabled = next === DEFAULT_FONT_SIZE;
            applyTypography(ui);
            resizeInput();
            vscode.postMessage({ type: "updateSettings", patch: { fontSize: next } });
            flashSettingsSaved(ui, settingsEl, `字体 ${next} px`);
        };
        attachDraftHandlers(fontInput);
        decBtn.addEventListener("click", () => commitFontSize(currentSettings(ui).fontSize - 1));
        incBtn.addEventListener("click", () => commitFontSize(currentSettings(ui).fontSize + 1));
        fontResetBtn.addEventListener("click", () => commitFontSize(DEFAULT_FONT_SIZE));
        fontInput.addEventListener("change", () => commitFontSize(fontInput.value));
        fontInput.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                commitFontSize(fontInput.value);
                fontInput.blur();
            }
        });

        fontRow.append(fontStepper, fontResetBtn);
        const fontHint = document.createElement("div");
        fontHint.className = "settings-hint";
        fontHint.textContent = `默认 ${DEFAULT_FONT_SIZE} px（范围 ${MIN_FONT_SIZE}–${MAX_FONT_SIZE} px），作用于对话正文、输入框与代码块`;
        fontField.append(fontLabel, fontRow, fontHint);
        displayGroup.append(displayTitle, fontField);

        const netGroup = document.createElement("div");
        netGroup.className = "settings-group";
        const netTitle = document.createElement("div");
        netTitle.className = "settings-group-title";
        netTitle.textContent = "网络与代理";

        const proxyField = document.createElement("div");
        proxyField.className = "settings-field";
        const proxyLabel = document.createElement("label");
        proxyLabel.textContent = "HTTP 代理";
        const proxyRow = document.createElement("div");
        proxyRow.className = "settings-input-row";
        const proxyInput = document.createElement("input");
        proxyInput.type = "text";
        proxyInput.dataset.field = "proxy";
        proxyInput.spellcheck = false;
        proxyInput.autocomplete = "off";
        proxyInput.placeholder = "http://127.0.0.1:7890（留空继承编辑器）";
        attachDraftHandlers(proxyInput);
        const proxyClear = document.createElement("button");
        proxyClear.type = "button";
        proxyClear.className = "settings-mini-btn ghost";
        proxyClear.textContent = "清空";
        const proxySave = document.createElement("button");
        proxySave.type = "button";
        proxySave.className = "settings-mini-btn primary";
        proxySave.textContent = "应用";

        const commitProxy = (value: string): void => {
            const normalized = normalizeProxyInput(value);
            const display = proxyDisplay(normalized);
            proxyInput.value = display;
            markPendingField(proxyInput, display);
            const prev = currentSettings(ui);
            const nextSettings: SettingsView = {
                ...prev,
                proxy: normalized,
                effectiveProxy: normalized || (prev.proxy ? "" : prev.effectiveProxy),
            };
            ui.state.settings = nextSettings;
            syncProxyHint(settingsEl, nextSettings);
            vscode.postMessage({ type: "updateSettings", patch: { proxy: normalized } });
            flashSettingsSaved(ui, settingsEl, normalized ? "代理已更新" : "已清空代理");
        };
        proxySave.addEventListener("click", () => commitProxy(proxyInput.value));
        proxyClear.addEventListener("click", () => commitProxy(""));
        proxyInput.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                commitProxy(proxyInput.value);
            }
        });
        proxyRow.append(proxyInput, proxyClear, proxySave);

        const proxyNote = document.createElement("div");
        proxyNote.className = "settings-hint";
        proxyNote.dataset.hint = "proxy";
        proxyField.append(proxyLabel, proxyRow, proxyNote);

        const noProxyField = document.createElement("div");
        noProxyField.className = "settings-field";
        const noProxyLabel = document.createElement("label");
        noProxyLabel.textContent = "不走代理的主机 (noProxy)";
        const noProxyRow = document.createElement("div");
        noProxyRow.className = "settings-input-row";
        const noProxyInput = document.createElement("input");
        noProxyInput.type = "text";
        noProxyInput.dataset.field = "noProxy";
        noProxyInput.spellcheck = false;
        noProxyInput.autocomplete = "off";
        noProxyInput.placeholder = "localhost,127.0.0.1,::1";
        attachDraftHandlers(noProxyInput);
        const noProxySave = document.createElement("button");
        noProxySave.type = "button";
        noProxySave.className = "settings-mini-btn";
        noProxySave.textContent = "应用";
        const commitNoProxy = (): void => {
            const next = noProxyInput.value.trim() || "localhost,127.0.0.1,::1";
            noProxyInput.value = next;
            markPendingField(noProxyInput, next);
            ui.state.settings = Object.assign({}, currentSettings(ui), { noProxy: next });
            vscode.postMessage({ type: "updateSettings", patch: { noProxy: next } });
            flashSettingsSaved(ui, settingsEl, "已保存");
        };
        noProxySave.addEventListener("click", commitNoProxy);
        noProxyInput.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                commitNoProxy();
            }
        });
        noProxyRow.append(noProxyInput, noProxySave);
        noProxyField.append(noProxyLabel, noProxyRow);

        netGroup.append(netTitle, proxyField, noProxyField);

        const permGroup = document.createElement("div");
        permGroup.className = "settings-group";
        const permTitle = document.createElement("div");
        permTitle.className = "settings-group-title";
        permTitle.textContent = "权限与安全";

        const makeToggleRow = (
            field: "dangerouslySkipPermissions" | "sandbox",
            titleText: string,
            descText: string,
            danger: boolean,
        ): HTMLLabelElement => {
            const row = document.createElement("label");
            row.className = `settings-toggle${danger ? " danger" : ""}`;
            const info = document.createElement("div");
            info.className = "settings-toggle-info";
            const title = document.createElement("span");
            title.className = "settings-toggle-title";
            title.textContent = titleText;
            const desc = document.createElement("span");
            desc.className = "settings-toggle-desc";
            desc.textContent = descText;
            info.append(title, desc);
            const input = document.createElement("input");
            input.type = "checkbox";
            input.dataset.field = field;
            const track = document.createElement("span");
            track.className = "settings-switch";
            input.addEventListener("change", () => {
                const checked = input.checked;
                markPendingField(input, String(checked));
                ui.state.settings = Object.assign({}, currentSettings(ui), { [field]: checked });
                const patch: SettingsPatch = { [field]: checked };
                vscode.postMessage({ type: "updateSettings", patch });
                flashSettingsSaved(ui, settingsEl, "已保存");
            });
            row.append(info, input, track);
            return row;
        };

        permGroup.append(
            permTitle,
            makeToggleRow("dangerouslySkipPermissions", "跳过权限确认", "启用 --dangerously-skip-permissions 自动放行操作", true),
            makeToggleRow("sandbox", "沙盒模式", "启动反重力时附带 --sandbox 沙盒隔离", false),
        );

        const pathGroup = document.createElement("div");
        pathGroup.className = "settings-group";
        const pathTitle = document.createElement("div");
        pathTitle.className = "settings-group-title";
        pathTitle.textContent = "运行时与路径";

        const makePathField = (
            field: "binaryPath" | "cursorDataDir",
            labelText: string,
            placeholder: string,
        ): HTMLDivElement => {
            const wrap = document.createElement("div");
            wrap.className = "settings-field";
            const lbl = document.createElement("label");
            lbl.textContent = labelText;
            const row = document.createElement("div");
            row.className = "settings-input-row";
            const inp = document.createElement("input");
            inp.type = "text";
            inp.dataset.field = field;
            inp.spellcheck = false;
            inp.autocomplete = "off";
            inp.placeholder = placeholder;
            attachDraftHandlers(inp);
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "settings-mini-btn";
            btn.textContent = "应用";
            const commit = (): void => {
                const next = inp.value.trim();
                inp.value = next;
                markPendingField(inp, next);
                ui.state.settings = Object.assign({}, currentSettings(ui), { [field]: next });
                const patch: SettingsPatch = { [field]: next };
                vscode.postMessage({ type: "updateSettings", patch });
                flashSettingsSaved(ui, settingsEl, "已保存");
            };
            btn.addEventListener("click", commit);
            inp.addEventListener("keydown", (event) => {
                if (event.isComposing || event.keyCode === 229) {
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                }
            });
            row.append(inp, btn);
            wrap.append(lbl, row);
            return wrap;
        };

        pathGroup.append(
            pathTitle,
            makePathField("binaryPath", "自定义反重力路径 (binaryPath)", "留空使用插件内置版本"),
            makePathField("cursorDataDir", "Cursor 数据目录 (cursorDataDir)", "留空自动探测本机 Cursor 目录"),
        );

        const actGroup = document.createElement("div");
        actGroup.className = "settings-group";
        const actTitle = document.createElement("div");
        actTitle.className = "settings-group-title";
        actTitle.textContent = "运行操作";
        const actGrid = document.createElement("div");
        actGrid.className = "settings-actions-grid";
        const makeActionBtn = (
            label: string,
            msgType: "install" | "setApiKey" | "showLog" | "retry",
            closePanel: boolean,
        ): HTMLButtonElement => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "settings-action-btn";
            btn.textContent = label;
            btn.addEventListener("click", () => {
                if (closePanel) {
                    setSettingsOpen(false);
                }
                vscode.postMessage({ type: msgType });
            });
            return btn;
        };
        const loginBtn = document.createElement("button");
        loginBtn.type = "button";
        loginBtn.className = "settings-action-btn wide";
        loginBtn.textContent = "登录 Google 账号";
        loginBtn.addEventListener("click", () => {
            setSettingsOpen(false);
            vscode.postMessage({ type: "login", methodId: "oauth-personal" });
        });
        actGrid.append(
            makeActionBtn("安装 / 更新内置版本", "install", true),
            makeActionBtn("设置 Gemini API Key", "setApiKey", true),
            makeActionBtn("查看运行日志", "showLog", false),
            makeActionBtn("重连反重力", "retry", true),
            loginBtn,
        );
        actGroup.append(actTitle, actGrid);

        body.append(displayGroup, netGroup, permGroup, pathGroup, actGroup);
        shell.append(head, body);
        settingsEl.append(shell);
    }

    const setFieldValue = (field: string, value: string | boolean): void => {
        const el = settingsEl.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
        if (!el) {
            return;
        }
        if (resetInputs) {
            clearFieldTracking(el);
            if (el.type === "checkbox") {
                el.checked = Boolean(value);
            } else {
                el.value = String(value);
            }
            return;
        }
        const incoming = el.type === "checkbox" ? String(Boolean(value)) : String(value);
        const until = Number(el.dataset.pendingUntil || "0");
        if (until > 0) {
            if (incoming === (el.dataset.pendingValue ?? "") || Date.now() >= until) {
                el.dataset.pendingUntil = "";
                el.dataset.pendingValue = "";
            } else {
                return;
            }
        }
        if (el.type === "checkbox") {
            el.checked = Boolean(value);
            return;
        }
        if (el.dataset.dirty === "1" || document.activeElement === el) {
            return;
        }
        el.value = String(value);
    };
    setFieldValue("proxy", proxyDisplay(cfg.proxy));
    setFieldValue("noProxy", cfg.noProxy);
    setFieldValue("dangerouslySkipPermissions", cfg.dangerouslySkipPermissions);
    setFieldValue("sandbox", cfg.sandbox);
    setFieldValue("binaryPath", cfg.binaryPath);
    setFieldValue("cursorDataDir", cfg.cursorDataDir);
    setFieldValue("fontSize", String(cfg.fontSize));
    const decFontBtn = settingsEl.querySelector<HTMLButtonElement>('button[data-font-action="dec"]');
    const incFontBtn = settingsEl.querySelector<HTMLButtonElement>('button[data-font-action="inc"]');
    const resetFontBtn = settingsEl.querySelector<HTMLButtonElement>('button[data-font-action="reset"]');
    if (decFontBtn) {
        decFontBtn.disabled = cfg.fontSize <= MIN_FONT_SIZE;
    }
    if (incFontBtn) {
        incFontBtn.disabled = cfg.fontSize >= MAX_FONT_SIZE;
    }
    if (resetFontBtn) {
        resetFontBtn.disabled = cfg.fontSize === DEFAULT_FONT_SIZE;
    }

    const proxyEl = settingsEl.querySelector<HTMLInputElement>('input[data-field="proxy"]');
    const proxyPending = Boolean(proxyEl && Number(proxyEl.dataset.pendingUntil || "0") > Date.now());
    if (resetInputs || !proxyPending) {
        syncProxyHint(settingsEl, cfg);
    }
}
