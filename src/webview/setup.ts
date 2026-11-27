import { currentSettings } from "./settings";
import type { UiState, VsCodeApi, ViewState } from "./types";
import { proxyDisplay } from "./utils";

export interface SetupContext {
    ui: UiState;
    setupEl: HTMLElement | null;
    vscode: VsCodeApi;
    setSettingsOpen: (open: boolean) => void;
}

export function shouldShowSetup(state: ViewState): boolean {
    return state.status === "setup" || (state.status === "error" && state.runtimeInstalled === false);
}

export function renderSetup(ctx: SetupContext): boolean {
    const { ui, setupEl, vscode, setSettingsOpen } = ctx;
    if (!setupEl) {
        return false;
    }
    const show = shouldShowSetup(ui.state);
    if (!show) {
        setupEl.hidden = true;
        setupEl.replaceChildren();
        return false;
    }

    setupEl.hidden = false;
    if (!setupEl.querySelector(".setup-shell")) {
        setupEl.replaceChildren();
        const shell = document.createElement("div");
        shell.className = "setup-shell";

        const hero = document.createElement("div");
        hero.className = "setup-hero";
        const heroTop = document.createElement("div");
        heroTop.className = "setup-hero-top";
        const title = document.createElement("h2");
        title.className = "setup-title";
        title.textContent = "欢迎使用 MAGY";
        const badge = document.createElement("span");
        badge.className = "setup-badge";
        badge.textContent = "首次准备";
        heroTop.append(title, badge);
        const sub = document.createElement("p");
        sub.className = "setup-sub";
        sub.textContent = "在侧边栏中使用 Antigravity（反重力）AI 编程助手，完成下方准备即可开始。";
        hero.append(heroTop, sub);

        const steps = document.createElement("div");
        steps.className = "setup-steps";

        const step1 = document.createElement("div");
        step1.className = "setup-step";
        const num1 = document.createElement("span");
        num1.className = "setup-step-num";
        num1.textContent = "1";
        const body1 = document.createElement("div");
        body1.className = "setup-step-body";
        const head1 = document.createElement("div");
        head1.className = "setup-step-head";
        const title1 = document.createElement("span");
        title1.className = "setup-step-title";
        title1.textContent = "移至右侧辅助侧边栏";
        const tag1 = document.createElement("span");
        tag1.className = "setup-tag";
        tag1.textContent = "推荐";
        head1.append(title1, tag1);
        const desc1 = document.createElement("p");
        desc1.className = "setup-step-desc";
        desc1.textContent = "左侧保留文件资源管理器、右侧常驻 AI 对话更顺手；也可直接将左侧 MAGY 图标拖到右侧栏。";
        const moveBtn = document.createElement("button");
        moveBtn.type = "button";
        moveBtn.className = "setup-move-btn";
        moveBtn.textContent = "移动到右侧辅助栏";
        moveBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "moveView" });
        });
        body1.append(head1, desc1, moveBtn);
        step1.append(num1, body1);

        const step2 = document.createElement("div");
        step2.className = "setup-step";
        const num2 = document.createElement("span");
        num2.className = "setup-step-num";
        num2.textContent = "2";
        const body2 = document.createElement("div");
        body2.className = "setup-step-body";
        const head2 = document.createElement("div");
        head2.className = "setup-step-head";
        const title2 = document.createElement("span");
        title2.className = "setup-step-title";
        title2.textContent = "配置网络代理";
        const tag2 = document.createElement("span");
        tag2.className = "setup-tag optional";
        tag2.textContent = "可选";
        head2.append(title2, tag2);
        const desc2 = document.createElement("p");
        desc2.className = "setup-step-desc";
        desc2.textContent = "首次需要下载 Antigravity 运行时，如网络受限请填写本机代理。";
        const proxyInput = document.createElement("input");
        proxyInput.type = "text";
        proxyInput.className = "setup-input";
        proxyInput.dataset.setupProxy = "1";
        proxyInput.spellcheck = false;
        proxyInput.autocomplete = "off";
        proxyInput.placeholder = "http://127.0.0.1:7890（留空继承编辑器）";
        proxyInput.addEventListener("input", () => {
            proxyInput.dataset.dirty = "1";
        });
        const hint2 = document.createElement("div");
        hint2.className = "setup-hint";
        hint2.dataset.setupHint = "1";
        body2.append(head2, desc2, proxyInput, hint2);
        step2.append(num2, body2);

        steps.append(step1, step2);

        const errBox = document.createElement("div");
        errBox.className = "setup-error";
        errBox.hidden = true;

        const actions = document.createElement("div");
        actions.className = "setup-actions";
        const startBtn = document.createElement("button");
        startBtn.type = "button";
        startBtn.className = "setup-primary-btn primary";
        const submitSetup = (): void => {
            proxyInput.dataset.dirty = "";
            vscode.postMessage({ type: "startSetup", proxy: proxyInput.value });
        };
        startBtn.addEventListener("click", submitSetup);
        proxyInput.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                submitSetup();
            }
        });

        const altBtn = document.createElement("button");
        altBtn.type = "button";
        altBtn.className = "setup-link-btn";
        altBtn.textContent = "已有本地 agy？打开设置指定路径";
        altBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            setSettingsOpen(true);
        });
        actions.append(startBtn, altBtn);

        const tips = document.createElement("div");
        tips.className = "setup-tips";
        tips.textContent = "选中代码按 Ctrl+Alt+L / Cmd+Alt+L 加入对话；顶栏可导入 Cursor 对话或查看用量。";

        shell.append(hero, steps, errBox, actions, tips);
        setupEl.append(shell);
    }

    const cfg = currentSettings(ui);
    const proxyInput = setupEl.querySelector<HTMLInputElement>('input[data-setup-proxy="1"]');
    const hintEl = setupEl.querySelector<HTMLElement>('[data-setup-hint="1"]');
    const errEl = setupEl.querySelector<HTMLElement>(".setup-error");
    const startBtn = setupEl.querySelector<HTMLButtonElement>(".setup-primary-btn");

    if (proxyInput && proxyInput.dataset.dirty !== "1" && document.activeElement !== proxyInput) {
        proxyInput.value = proxyDisplay(cfg.proxy);
    }
    if (hintEl) {
        const explicit = proxyDisplay(cfg.proxy);
        const effective = proxyDisplay(cfg.effectiveProxy);
        if (explicit) {
            hintEl.textContent = `当前已配置：${explicit}`;
        } else if (effective) {
            hintEl.textContent = `当前自动继承编辑器代理：${effective}`;
        } else {
            hintEl.textContent = "留空则直接连接；如需代理可填写地址（如 127.0.0.1:7890）";
        }
    }
    const isError = ui.state.status === "error";
    const errText = isError ? String(ui.state.statusText || "").trim() : "";
    if (errEl) {
        errEl.hidden = !errText;
        errEl.textContent = errText;
    }
    if (startBtn) {
        startBtn.textContent = isError ? "重新下载并启动" : "下载并启动 Antigravity";
    }

    return true;
}
