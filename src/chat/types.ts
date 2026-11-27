export type MessageRole = "user" | "assistant" | "thought" | "tool" | "system";

export type AttachmentKind = "selection" | "file" | "directory";

export interface CodeAttachment {
    id: string;
    kind?: AttachmentKind;
    fileName: string;
    relativePath: string;
    languageId: string;
    startLine: number;
    endLine: number;
    text: string;
}

export interface ToolDiff {
    path: string;
    oldText?: string;
    newText?: string;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
    thoughtTokens: number;
    totalTokens: number;
}

export interface ChatTokenStats {
    contextUsed: number;
    contextSize: number;
    total: TokenUsage;
    lastTurn?: TokenUsage;
    turns: number;
    updatedAt?: number;
}

export interface AccountTierView {
    id: string;
    name: string;
    upgradeUri?: string;
}

export interface QuotaBucketView {
    id: string;
    name: string;
    window: string;
    remainingFraction: number;
    resetTime?: string;
    description?: string;
}

export interface QuotaGroupView {
    name: string;
    description?: string;
    buckets: QuotaBucketView[];
}

export interface QuotaStateView {
    loading: boolean;
    fetchedAt?: number;
    error?: string;
    tier?: AccountTierView;
    description?: string;
    groups: QuotaGroupView[];
    remainingCredits?: number;
    upgradeUri?: string;
}

export interface StoredMessage {
    id: string;
    role: MessageRole;
    text: string;
    title?: string;
    status?: string;
    kind?: string;
    detail?: string;
    filePath?: string;
    line?: number;
    diffs?: ToolDiff[];
    startedAt?: number;
    finishedAt?: number;
    imported?: boolean;
    attachments?: CodeAttachment[];
}

export interface ChatMeta {
    id: string;
    title: string;
    updatedAt: number;
    imported?: boolean;
    acpSessionId?: string;
    count?: number;
    preview?: string;
    totalTokens?: number;
}

export interface ChatRecord extends ChatMeta {
    createdAt: number;
    needsContext: boolean;
    contextText?: string;
    tokenStats?: ChatTokenStats;
    messages: StoredMessage[];
}

export interface SelectChoice {
    value: string;
    name: string;
    description?: string;
}

export interface ConfigOptionView {
    id: string;
    name: string;
    category?: string;
    current: string;
    options: SelectChoice[];
}

export interface ModeView {
    id: string;
    name: string;
    description?: string;
}

export interface AuthMethodView {
    id: string;
    name: string;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export type ElicitationFieldKind = "single" | "multi" | "text" | "number" | "boolean";

export interface ElicitationOption {
    value: string;
    label: string;
    recommended?: boolean;
}

export interface ElicitationFieldView {
    key: string;
    kind: ElicitationFieldKind;
    title: string;
    description?: string;
    required: boolean;
    options?: ElicitationOption[];
    otherKey?: string;
    otherTitle?: string;
    otherPlaceholder?: string;
    defaultValue?: string | number | boolean | string[];
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    minLength?: number;
    maxLength?: number;
    format?: string;
}

export interface ElicitationView {
    requestId: string;
    mode: "form" | "url";
    title: string;
    message: string;
    fields: ElicitationFieldView[];
    url?: string;
}

export interface PermissionView {
    requestId: string;
    title: string;
    detail?: string;
    options: { id: string; name: string; kind: string }[];
}

export interface CommandView {
    name: string;
    description: string;
}

export type LinkStatus = "setup" | "disconnected" | "connecting" | "ready" | "running" | "auth" | "error";

export interface SettingsView {
    proxy: string;
    effectiveProxy: string;
    noProxy: string;
    dangerouslySkipPermissions: boolean;
    sandbox: boolean;
    binaryPath: string;
    cursorDataDir: string;
    fontSize: number;
}

export interface ViewState {
    chats: ChatMeta[];
    activeId: string;
    messages: StoredMessage[];
    attachments: CodeAttachment[];
    status: LinkStatus;
    statusText: string;
    runtimeLabel: string;
    runtimeInstalled: boolean;
    authenticated: boolean;
    proxy: string;
    proxyUrl: string;
    usageText: string;
    busy: boolean;
    modes: ModeView[];
    currentModeId: string;
    options: ConfigOptionView[];
    authMethods: AuthMethodView[];
    permission?: PermissionView;
    elicitation?: ElicitationView;
    commands: CommandView[];
    settings?: SettingsView;
    tokenStats?: ChatTokenStats;
    quota: QuotaStateView;
}

export interface SettingsPatch {
    proxy?: string;
    noProxy?: string;
    dangerouslySkipPermissions?: boolean;
    sandbox?: boolean;
    binaryPath?: string;
    cursorDataDir?: string;
    fontSize?: number;
}

export type HostMessage =
    | { type: "snapshot"; state: ViewState }
    | { type: "delta"; message: StoredMessage }
    | { type: "status"; state: ViewState }
    | { type: "toggleHistory" }
    | { type: "toggleSettings" }
    | { type: "toggleUsage"; open?: boolean };

export type WebviewMessage =
    | { type: "ready" }
    | { type: "send"; text: string }
    | { type: "removeAttachment"; id: string }
    | { type: "cancel" }
    | { type: "newChat" }
    | { type: "selectChat"; id: string }
    | { type: "deleteChat"; id: string }
    | { type: "importCursor" }
    | { type: "setOption"; configId: string; value: string }
    | { type: "setMode"; modeId: string }
    | { type: "permission"; requestId: string; optionId: string }
    | { type: "elicitation"; requestId: string; action: ElicitationAction; content?: Record<string, unknown> }
    | { type: "login"; methodId: string }
    | { type: "logout" }
    | { type: "exportChat"; id?: string }
    | { type: "setProxy"; proxy: string }
    | { type: "updateSettings"; patch: SettingsPatch }
    | { type: "setApiKey" }
    | { type: "openIdeSettings" }
    | { type: "retry" }
    | { type: "install" }
    | { type: "startSetup"; proxy?: string }
    | { type: "moveView" }
    | { type: "showLog" }
    | { type: "refreshQuota"; force?: boolean }
    | { type: "openLink"; href: string | null }
    | { type: "openFile"; path: string; line?: number }
    | { type: "revealPath"; path: string }
    | { type: "addDroppedPaths"; items: string[] };
