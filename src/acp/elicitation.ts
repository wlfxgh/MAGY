import type {
    ElicitationAction,
    ElicitationFieldView,
    ElicitationOption,
    ElicitationView,
} from "../chat/types";
import { asRecord } from "../util";

/** Parses an ACP `elicitation/create` request into a normalized form or URL view model. */
export function parseElicitationRequest(requestId: string, params: unknown): ElicitationView {
    const record = asRecord(params);
    const mode = record.mode === "url" ? "url" : "form";
    const rawMessage = typeof record.message === "string" ? record.message.trim() : "";
    const url = mode === "url" && typeof record.url === "string" ? record.url.trim() : undefined;

    if (mode === "url") {
        return {
            requestId,
            mode: "url",
            title: "需要外部确认",
            message: rawMessage || "反重力请求在浏览器中完成下一步验证或授权。",
            fields: [],
            url,
        };
    }

    const questionCountMatch = /^The agent has (\d+) questions?\.?$/i.exec(rawMessage);
    const title = questionCountMatch ? "请回答以下问题" : "请补充信息";
    const schema = asRecord(record.requestedSchema);
    const props = asRecord(schema.properties);
    const requiredSet = new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((item): item is string => typeof item === "string")
            : [],
    );

    const entries = Object.entries(props);
    const consumedOtherKeys = new Set<string>();
    const pairedOthers = new Map<string, { otherKey: string; otherTitle: string; otherPlaceholder?: string }>();

    for (const [key, rawSchema] of entries) {
        const prop = asRecord(rawSchema);
        const isChoice = prop.type === "array"
            || Array.isArray(prop.oneOf)
            || Array.isArray(prop.anyOf)
            || Array.isArray(prop.enum);
        if (!isChoice) {
            continue;
        }
        const candidateOtherKey = `${key}_other`;
        if (!Object.prototype.hasOwnProperty.call(props, candidateOtherKey)) {
            continue;
        }
        const otherProp = asRecord(props[candidateOtherKey]);
        const otherType = typeof otherProp.type === "string" ? otherProp.type : "string";
        const otherHasChoices = Array.isArray(otherProp.oneOf)
            || Array.isArray(otherProp.anyOf)
            || Array.isArray(otherProp.enum);
        if (otherType === "string" && !otherHasChoices && !requiredSet.has(candidateOtherKey)) {
            consumedOtherKeys.add(candidateOtherKey);
            const otherTitle = typeof otherProp.title === "string" && otherProp.title.trim()
                ? otherProp.title.trim()
                : "其他";
            const otherPlaceholder = typeof otherProp.description === "string" && otherProp.description.trim()
                ? otherProp.description.trim()
                : undefined;
            pairedOthers.set(key, { otherKey: candidateOtherKey, otherTitle, otherPlaceholder });
        }
    }

    const fields: ElicitationFieldView[] = [];
    for (const [key, rawSchema] of entries) {
        if (consumedOtherKeys.has(key)) {
            continue;
        }
        const field = parseField(key, asRecord(rawSchema), requiredSet.has(key), pairedOthers.get(key));
        if (field) {
            fields.push(field);
        }
    }

    const message = questionCountMatch
        ? `共 ${fields.length || Number(questionCountMatch[1])} 个问题`
        : (rawMessage || (fields.length ? `共 ${fields.length} 个问题` : "请确认或填写以下内容"));

    return {
        requestId,
        mode: "form",
        title,
        message,
        fields,
    };
}

/** Sanitizes webview elicitation submission data into an ACP `elicitation/create` response. */
export function buildElicitationResponse(
    view: ElicitationView,
    action: ElicitationAction,
    rawContent?: Record<string, unknown>,
): { action: ElicitationAction; content?: Record<string, unknown> } {
    if (action === "decline" || action === "cancel") {
        return { action };
    }
    if (view.mode === "url") {
        return { action: "accept", content: {} };
    }

    const input = rawContent ?? {};
    const content: Record<string, unknown> = {};

    for (const field of view.fields) {
        if (field.kind === "single") {
            const selected = typeof input[field.key] === "string" ? input[field.key] as string : "";
            if (selected) {
                content[field.key] = selected;
            }
            if (field.otherKey) {
                const otherVal = typeof input[field.otherKey] === "string"
                    ? (input[field.otherKey] as string).trim()
                    : "";
                if (otherVal) {
                    content[field.otherKey] = otherVal;
                }
            }
            continue;
        }

        if (field.kind === "multi") {
            const rawArr = Array.isArray(input[field.key]) ? input[field.key] as unknown[] : [];
            const selected = rawArr.filter((item): item is string => typeof item === "string" && item !== "");
            if (selected.length) {
                content[field.key] = selected;
            } else if (field.required) {
                content[field.key] = [];
            }
            if (field.otherKey) {
                const otherVal = typeof input[field.otherKey] === "string"
                    ? (input[field.otherKey] as string).trim()
                    : "";
                if (otherVal) {
                    content[field.otherKey] = otherVal;
                }
            }
            continue;
        }

        if (field.kind === "boolean") {
            if (input[field.key] !== undefined) {
                content[field.key] = Boolean(input[field.key]);
            } else if (typeof field.defaultValue === "boolean") {
                content[field.key] = field.defaultValue;
            } else {
                content[field.key] = false;
            }
            continue;
        }

        if (field.kind === "number") {
            const rawVal = input[field.key];
            if (rawVal === undefined || rawVal === null || rawVal === "") {
                continue;
            }
            const parsed = typeof rawVal === "number" ? rawVal : Number(rawVal);
            if (Number.isFinite(parsed)) {
                content[field.key] = field.integer ? Math.trunc(parsed) : parsed;
            }
            continue;
        }

        const textVal = typeof input[field.key] === "string" ? input[field.key] as string : "";
        if (textVal || field.required) {
            content[field.key] = textVal;
        }
    }

    return { action: "accept", content };
}

function parseField(
    key: string,
    prop: Record<string, unknown>,
    required: boolean,
    pairedOther?: { otherKey: string; otherTitle: string; otherPlaceholder?: string },
): ElicitationFieldView | undefined {
    const title = typeof prop.title === "string" && prop.title.trim() ? prop.title.trim() : key;
    const description = typeof prop.description === "string" && prop.description.trim()
        ? prop.description.trim()
        : undefined;
    const type = typeof prop.type === "string" ? prop.type : "";

    if (type === "array") {
        const items = asRecord(prop.items);
        const options = extractOptions(items);
        if (!options.length) {
            return {
                key,
                kind: "text",
                title,
                description,
                required,
                defaultValue: Array.isArray(prop.default)
                    ? prop.default.filter((v): v is string => typeof v === "string").join(", ")
                    : undefined,
            };
        }
        const defaultValue = Array.isArray(prop.default)
            ? prop.default.filter((item): item is string => typeof item === "string")
            : undefined;
        return {
            key,
            kind: "multi",
            title,
            description,
            required,
            options,
            otherKey: pairedOther?.otherKey,
            otherTitle: pairedOther?.otherTitle,
            otherPlaceholder: pairedOther?.otherPlaceholder,
            defaultValue,
        };
    }

    const singleOptions = extractOptions(prop);
    if (singleOptions.length) {
        const defaultValue = typeof prop.default === "string" ? prop.default : undefined;
        return {
            key,
            kind: "single",
            title,
            description,
            required,
            options: singleOptions,
            otherKey: pairedOther?.otherKey,
            otherTitle: pairedOther?.otherTitle,
            otherPlaceholder: pairedOther?.otherPlaceholder,
            defaultValue,
        };
    }

    if (type === "boolean") {
        return {
            key,
            kind: "boolean",
            title,
            description,
            required,
            defaultValue: typeof prop.default === "boolean" ? prop.default : false,
        };
    }

    if (type === "number" || type === "integer") {
        const minimum = typeof prop.minimum === "number" && Number.isFinite(prop.minimum) ? prop.minimum : undefined;
        const maximum = typeof prop.maximum === "number" && Number.isFinite(prop.maximum) ? prop.maximum : undefined;
        const defaultValue = typeof prop.default === "number" && Number.isFinite(prop.default)
            ? prop.default
            : undefined;
        return {
            key,
            kind: "number",
            title,
            description,
            required,
            integer: type === "integer",
            minimum,
            maximum,
            defaultValue,
        };
    }

    return {
        key,
        kind: "text",
        title,
        description,
        required,
        defaultValue: typeof prop.default === "string" ? prop.default : undefined,
        minLength: typeof prop.minLength === "number" && Number.isFinite(prop.minLength) ? prop.minLength : undefined,
        maxLength: typeof prop.maxLength === "number" && Number.isFinite(prop.maxLength) ? prop.maxLength : undefined,
        format: typeof prop.format === "string" && prop.format.trim() ? prop.format.trim() : undefined,
    };
}

function extractOptions(schema: Record<string, unknown>): ElicitationOption[] {
    const rawChoices = Array.isArray(schema.oneOf)
        ? schema.oneOf
        : Array.isArray(schema.anyOf)
            ? schema.anyOf
            : undefined;
    if (rawChoices) {
        const out: ElicitationOption[] = [];
        for (const item of rawChoices) {
            const record = asRecord(item);
            const rawConst = record.const ?? record.value;
            if (rawConst === undefined || rawConst === null) {
                continue;
            }
            const value = String(rawConst);
            const rawLabel = typeof record.title === "string" && record.title.trim()
                ? record.title.trim()
                : (typeof record.label === "string" && record.label.trim() ? record.label.trim() : value);
            out.push(normalizeOption(value, rawLabel));
        }
        return out;
    }

    if (Array.isArray(schema.enum)) {
        const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
        const out: ElicitationOption[] = [];
        schema.enum.forEach((rawVal, idx) => {
            if (rawVal === undefined || rawVal === null) {
                return;
            }
            const value = String(rawVal);
            const nameCandidate = names[idx];
            const rawLabel = typeof nameCandidate === "string" && nameCandidate.trim()
                ? nameCandidate.trim()
                : value;
            out.push(normalizeOption(value, rawLabel));
        });
        return out;
    }

    return [];
}

function normalizeOption(value: string, rawLabel: string): ElicitationOption {
    const recPrefix = /^\s*\((?:Recommended|推荐)\)\s*/i;
    const recSuffix = /\s*[(（](?:Recommended|推荐)[)）]\s*$/i;
    const recommended = recPrefix.test(rawLabel) || recSuffix.test(rawLabel);
    const label = recommended
        ? rawLabel.replace(recPrefix, "").replace(recSuffix, "").trim() || rawLabel.trim()
        : rawLabel;
    return recommended ? { value, label, recommended: true } : { value, label };
}
