import { ICON_EXTERNAL } from "./icons";
import type { ElicitationAction, ElicitationFieldView, UiState, VsCodeApi } from "./types";

export interface ElicitationContext {
    ui: UiState;
    elicitationEl: HTMLElement | null;
    vscode: VsCodeApi;
}

export function renderElicitation(ctx: ElicitationContext): void {
    const { ui, elicitationEl, vscode } = ctx;
    if (!elicitationEl) {
        return;
    }
    const view = ui.state.elicitation;
    if (!view) {
        ui.elicitationId = "";
        elicitationEl.hidden = true;
        elicitationEl.replaceChildren();
        return;
    }
    if (ui.elicitationId === view.requestId && elicitationEl.firstElementChild) {
        return;
    }

    ui.elicitationId = view.requestId;
    elicitationEl.hidden = false;
    elicitationEl.replaceChildren();

    const head = document.createElement("div");
    head.className = "elicit-head";
    const headLeft = document.createElement("div");
    headLeft.className = "elicit-head-left";
    const titleEl = document.createElement("strong");
    titleEl.className = "elicit-title";
    titleEl.textContent = view.title || "请回答以下问题";
    headLeft.append(titleEl);
    if (view.message && view.mode !== "url") {
        const msgEl = document.createElement("span");
        msgEl.className = "elicit-sub";
        msgEl.textContent = view.message;
        headLeft.append(msgEl);
    }

    const progressEl = document.createElement("span");
    progressEl.className = "elicit-progress";
    head.append(headLeft, progressEl);
    elicitationEl.append(head);

    if (view.mode === "url") {
        progressEl.hidden = true;
        const body = document.createElement("div");
        body.className = "elicit-body";
        const note = document.createElement("p");
        note.className = "elicit-url-note";
        note.textContent = view.message || "请在浏览器中打开下方链接以完成认证或授权：";
        body.append(note);
        if (view.url) {
            const urlRow = document.createElement("div");
            urlRow.className = "elicit-url-row";
            const urlText = document.createElement("span");
            urlText.className = "elicit-url-text";
            urlText.textContent = view.url;
            urlText.title = view.url;
            const openBtn = document.createElement("button");
            openBtn.type = "button";
            openBtn.className = "elicit-btn";
            openBtn.innerHTML = `${ICON_EXTERNAL}<span>打开链接</span>`;
            openBtn.addEventListener("click", () => {
                vscode.postMessage({ type: "openLink", href: view.url ?? null });
            });
            urlRow.append(urlText, openBtn);
            body.append(urlRow);
        }
        const foot = document.createElement("div");
        foot.className = "elicit-foot";
        const actions = document.createElement("div");
        actions.className = "elicit-actions";
        actions.append(
            makeActionBtn("跳过", "elicit-btn ghost", () => sendAction("decline")),
            makeActionBtn("取消", "elicit-btn", () => sendAction("cancel")),
            makeActionBtn("已完成", "elicit-btn primary", () => sendAction("accept", {})),
        );
        foot.append(actions);
        elicitationEl.append(body, foot);
        return;
    }

    const draft: Record<string, unknown> = {};
    const fieldEls = new Map<string, HTMLElement>();
    const syncProgress = (): void => {
        if (!view.fields.length) {
            progressEl.hidden = true;
            return;
        }
        progressEl.hidden = false;
        const answered = view.fields.filter((f) => isFieldAnswered(f, draft)).length;
        progressEl.textContent = `已答 ${answered}/${view.fields.length}`;
    };

    const body = document.createElement("div");
    body.className = "elicit-body";

    const errBanner = document.createElement("div");
    errBanner.className = "elicit-error";
    errBanner.hidden = true;

    const clearError = (): void => {
        errBanner.hidden = true;
        errBanner.textContent = "";
    };

    view.fields.forEach((field, index) => {
        if (field.kind === "multi") {
            draft[field.key] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : [];
        } else if (field.kind === "boolean") {
            draft[field.key] = typeof field.defaultValue === "boolean" ? field.defaultValue : false;
        } else if (field.defaultValue !== undefined) {
            draft[field.key] = field.defaultValue;
        } else {
            draft[field.key] = "";
        }
        if (field.otherKey) {
            draft[field.otherKey] = "";
        }

        const fieldWrap = document.createElement("div");
        fieldWrap.className = "elicit-field";
        fieldEls.set(field.key, fieldWrap);

        if (field.kind === "boolean") {
            const toggleLabel = document.createElement("label");
            toggleLabel.className = "elicit-toggle";
            const info = document.createElement("div");
            info.className = "elicit-toggle-info";
            const qTitle = document.createElement("div");
            qTitle.className = "elicit-q-title";
            qTitle.textContent = view.fields.length > 1 ? `${index + 1}. ${field.title}` : field.title;
            if (field.required) {
                const req = document.createElement("span");
                req.className = "elicit-req";
                req.textContent = "*";
                qTitle.append(req);
            }
            info.append(qTitle);
            if (field.description) {
                const desc = document.createElement("div");
                desc.className = "elicit-q-desc";
                desc.textContent = field.description;
                info.append(desc);
            }
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = Boolean(draft[field.key]);
            const sw = document.createElement("span");
            sw.className = "settings-switch";
            checkbox.addEventListener("change", () => {
                draft[field.key] = checkbox.checked;
                clearError();
                syncProgress();
            });
            toggleLabel.append(info, checkbox, sw);
            fieldWrap.append(toggleLabel);
            body.append(fieldWrap);
            return;
        }

        const qHead = document.createElement("div");
        qHead.className = "elicit-q-head";
        const qTitle = document.createElement("span");
        qTitle.className = "elicit-q-title";
        qTitle.textContent = view.fields.length > 1 ? `${index + 1}. ${field.title}` : field.title;
        qHead.append(qTitle);
        if (field.kind === "multi") {
            const tag = document.createElement("span");
            tag.className = "elicit-tag";
            tag.textContent = "多选";
            qHead.append(tag);
        }
        if (field.required) {
            const req = document.createElement("span");
            req.className = "elicit-req";
            req.textContent = "*";
            qHead.append(req);
        }
        fieldWrap.append(qHead);

        if (field.description) {
            const desc = document.createElement("div");
            desc.className = "elicit-q-desc";
            desc.textContent = field.description;
            fieldWrap.append(desc);
        }

        if (field.kind === "single" || field.kind === "multi") {
            const isMulti = field.kind === "multi";
            const optionsBox = document.createElement("div");
            optionsBox.className = "elicit-options";
            optionsBox.setAttribute("role", isMulti ? "group" : "radiogroup");
            const optButtons: { value: string; btn: HTMLButtonElement }[] = [];
            let otherInput: HTMLInputElement | undefined;

            const syncOptionButtons = (): void => {
                if (isMulti) {
                    const current = Array.isArray(draft[field.key]) ? draft[field.key] as string[] : [];
                    for (const item of optButtons) {
                        const active = current.includes(item.value);
                        item.btn.classList.toggle("selected", active);
                        item.btn.setAttribute("aria-checked", active ? "true" : "false");
                    }
                } else {
                    const current = String(draft[field.key] ?? "");
                    for (const item of optButtons) {
                        const active = current === item.value;
                        item.btn.classList.toggle("selected", active);
                        item.btn.setAttribute("aria-checked", active ? "true" : "false");
                    }
                }
            };

            for (const opt of field.options ?? []) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "elicit-opt";
                btn.dataset.value = opt.value;
                btn.setAttribute("role", isMulti ? "checkbox" : "radio");

                const mark = document.createElement("span");
                mark.className = isMulti ? "elicit-check" : "elicit-radio";
                mark.setAttribute("aria-hidden", "true");

                const label = document.createElement("span");
                label.className = "elicit-opt-label";
                label.textContent = opt.label;

                btn.append(mark, label);
                if (opt.recommended) {
                    const rec = document.createElement("span");
                    rec.className = "elicit-rec";
                    rec.textContent = "推荐";
                    btn.append(rec);
                }

                btn.addEventListener("click", () => {
                    clearError();
                    if (isMulti) {
                        const list = Array.isArray(draft[field.key]) ? [...draft[field.key] as string[]] : [];
                        const pos = list.indexOf(opt.value);
                        if (pos >= 0) {
                            list.splice(pos, 1);
                        } else {
                            list.push(opt.value);
                        }
                        draft[field.key] = list;
                    } else {
                        const cur = String(draft[field.key] ?? "");
                        const next = cur === opt.value && !field.required ? "" : opt.value;
                        draft[field.key] = next;
                        if (next && field.otherKey && otherInput) {
                            draft[field.otherKey] = "";
                            otherInput.value = "";
                        }
                    }
                    syncOptionButtons();
                    syncProgress();
                });

                optButtons.push({ value: opt.value, btn });
                optionsBox.append(btn);
            }
            syncOptionButtons();
            fieldWrap.append(optionsBox);

            if (field.otherKey) {
                const otherKey = field.otherKey;
                otherInput = document.createElement("input");
                otherInput.type = "text";
                otherInput.className = "elicit-input elicit-other";
                otherInput.placeholder = "其他（自定义回答）...";
                otherInput.dataset.field = otherKey;
                otherInput.addEventListener("input", () => {
                    clearError();
                    draft[otherKey] = otherInput?.value ?? "";
                    if (!isMulti && otherInput?.value.trim()) {
                        draft[field.key] = "";
                        syncOptionButtons();
                    }
                    syncProgress();
                });
                fieldWrap.append(otherInput);
            }
        } else if (field.kind === "number") {
            const numInput = document.createElement("input");
            numInput.type = "number";
            numInput.className = "elicit-input";
            numInput.dataset.field = field.key;
            if (field.minimum !== undefined) {
                numInput.min = String(field.minimum);
            }
            if (field.maximum !== undefined) {
                numInput.max = String(field.maximum);
            }
            numInput.step = field.integer ? "1" : "any";
            if (field.defaultValue !== undefined) {
                numInput.value = String(field.defaultValue);
            }
            numInput.placeholder = rangePlaceholder(field);
            numInput.addEventListener("input", () => {
                clearError();
                draft[field.key] = numInput.value;
                syncProgress();
            });
            fieldWrap.append(numInput);
        } else {
            const textInput = document.createElement("input");
            textInput.type = inputTypeForFormat(field.format);
            textInput.className = "elicit-input";
            textInput.dataset.field = field.key;
            if (typeof field.defaultValue === "string") {
                textInput.value = field.defaultValue;
            }
            if (field.maxLength !== undefined) {
                textInput.maxLength = field.maxLength;
            }
            textInput.placeholder = "输入回答...";
            textInput.addEventListener("input", () => {
                clearError();
                draft[field.key] = textInput.value;
                syncProgress();
            });
            fieldWrap.append(textInput);
        }

        body.append(fieldWrap);
    });

    syncProgress();

    let locked = false;
    function sendAction(action: ElicitationAction, content?: Record<string, unknown>): void {
        if (locked) {
            return;
        }
        locked = true;
        for (const btn of elicitationEl?.querySelectorAll<HTMLButtonElement>(".elicit-foot button") ?? []) {
            btn.disabled = true;
        }
        vscode.postMessage({
            type: "elicitation",
            requestId: view!.requestId,
            action,
            content,
        });
    }

    const submit = (): void => {
        const validation = validateFields(view.fields, draft);
        if (validation) {
            errBanner.textContent = validation.message;
            errBanner.hidden = false;
            const targetWrap = fieldEls.get(validation.fieldKey);
            targetWrap?.scrollIntoView({ block: "nearest" });
            return;
        }
        clearError();
        sendAction("accept", { ...draft });
    };

    const foot = document.createElement("div");
    foot.className = "elicit-foot";
    const actions = document.createElement("div");
    actions.className = "elicit-actions";
    const skipBtn = makeActionBtn("跳过", "elicit-btn ghost", () => sendAction("decline"));
    const cancelBtn = makeActionBtn("取消", "elicit-btn", () => sendAction("cancel"));
    const submitBtn = makeActionBtn("提交回答", "elicit-btn primary", submit);
    actions.append(skipBtn, cancelBtn, submitBtn);
    foot.append(errBanner, actions);

    elicitationEl.onkeydown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
        }
    };

    elicitationEl.append(body, foot);
}

function makeActionBtn(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
}

function isFieldAnswered(field: ElicitationFieldView, draft: Record<string, unknown>): boolean {
    if (field.kind === "boolean") {
        return true;
    }
    if (field.kind === "single") {
        const selected = String(draft[field.key] ?? "").trim();
        const other = field.otherKey ? String(draft[field.otherKey] ?? "").trim() : "";
        return Boolean(selected || other);
    }
    if (field.kind === "multi") {
        const arr = Array.isArray(draft[field.key]) ? draft[field.key] as unknown[] : [];
        const other = field.otherKey ? String(draft[field.otherKey] ?? "").trim() : "";
        return arr.length > 0 || Boolean(other);
    }
    if (field.kind === "number") {
        const raw = draft[field.key];
        return raw !== undefined && raw !== null && String(raw).trim() !== "";
    }
    return String(draft[field.key] ?? "").trim().length > 0;
}

function validateFields(
    fields: ElicitationFieldView[],
    draft: Record<string, unknown>,
): { fieldKey: string; message: string } | undefined {
    for (const field of fields) {
        if (field.kind === "single" || field.kind === "multi") {
            if (field.required && !isFieldAnswered(field, draft)) {
                return { fieldKey: field.key, message: `请先完成必填问题：${field.title}` };
            }
            continue;
        }
        if (field.kind === "number") {
            const raw = String(draft[field.key] ?? "").trim();
            if (!raw) {
                if (field.required) {
                    return { fieldKey: field.key, message: `请填写数字：${field.title}` };
                }
                continue;
            }
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) {
                return { fieldKey: field.key, message: `请输入有效数字：${field.title}` };
            }
            if (field.integer && !Number.isInteger(parsed)) {
                return { fieldKey: field.key, message: `请输入整数：${field.title}` };
            }
            if (field.minimum !== undefined && parsed < field.minimum) {
                return { fieldKey: field.key, message: `「${field.title}」不能小于 ${field.minimum}` };
            }
            if (field.maximum !== undefined && parsed > field.maximum) {
                return { fieldKey: field.key, message: `「${field.title}」不能大于 ${field.maximum}` };
            }
            continue;
        }
        if (field.kind === "text") {
            const raw = String(draft[field.key] ?? "");
            if (field.required && !raw.trim()) {
                return { fieldKey: field.key, message: `请填写：${field.title}` };
            }
            if (raw && field.minLength !== undefined && raw.length < field.minLength) {
                return { fieldKey: field.key, message: `「${field.title}」至少需要 ${field.minLength} 个字符` };
            }
        }
    }
    return undefined;
}

function rangePlaceholder(field: ElicitationFieldView): string {
    if (field.minimum !== undefined && field.maximum !== undefined) {
        return `输入${field.integer ? "整数" : "数字"} (${field.minimum}–${field.maximum})`;
    }
    if (field.minimum !== undefined) {
        return `输入不少于 ${field.minimum} 的${field.integer ? "整数" : "数字"}`;
    }
    if (field.maximum !== undefined) {
        return `输入不超过 ${field.maximum} 的${field.integer ? "整数" : "数字"}`;
    }
    return field.integer ? "输入整数..." : "输入数字...";
}

function inputTypeForFormat(format?: string): string {
    switch (format) {
        case "email":
            return "email";
        case "uri":
            return "url";
        case "date":
            return "date";
        case "date-time":
            return "datetime-local";
        default:
            return "text";
    }
}
