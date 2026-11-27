import type {
    AccountTierView,
    AttachmentKind,
    AuthMethodView,
    ChatMeta,
    ChatTokenStats,
    CodeAttachment,
    CommandView,
    ConfigOptionView,
    HostMessage,
    LinkStatus,
    MessageRole,
    ModeView,
    PermissionView,
    QuotaBucketView,
    QuotaGroupView,
    QuotaStateView,
    SelectChoice,
    SettingsPatch,
    SettingsView,
    StoredMessage,
    TokenUsage,
    ToolDiff,
    ViewState,
    WebviewMessage,
} from "../chat/types";

export type {
    AccountTierView,
    AttachmentKind,
    AuthMethodView,
    ChatMeta,
    ChatTokenStats,
    CodeAttachment,
    CommandView,
    ConfigOptionView,
    HostMessage,
    LinkStatus,
    MessageRole,
    ModeView,
    PermissionView,
    QuotaBucketView,
    QuotaGroupView,
    QuotaStateView,
    SelectChoice,
    SettingsPatch,
    SettingsView,
    StoredMessage,
    TokenUsage,
    ToolDiff,
    ViewState,
    WebviewMessage,
};

export interface VsCodeApi {
    postMessage(message: WebviewMessage): void;
    getState?(): unknown;
    setState?(state: unknown): void;
}

declare global {
    function acquireVsCodeApi(): VsCodeApi;
}

export interface ToggleState {
    status: string;
    open: boolean;
}

export interface OpenPickerState {
    key: string;
    btn: HTMLButtonElement;
}

export interface UiState {
    historyOpen: boolean;
    settingsOpen: boolean;
    usageOpen: boolean;
    state: ViewState;
    selectSignature: string;
    historySignature: string;
    usageSignature: string;
    chipSignature: string;
    proxyMenu: boolean;
    proxyDraft: string | null;
    proxyCaret: number | null;
    proxyFocused: boolean;
    pendingSend: boolean;
    slashIndex: number;
    slashQuery: string;
    slashDismissed: boolean;
    slashMoved: boolean;
    slashMatches: CommandView[];
    openPicker: OpenPickerState | null;
    historyQuery: string;
    historyIndex: number;
    historyConfirmId: string;
    historyConfirmTimer: number;
    settingsFeedbackTimer: number;
    busyStartedAt: number;
    liveTimer: number;
    userToggled: Map<string, ToggleState>;
    msgStatus: Map<string, string>;
}

export interface NormalizedToolMeta {
    role: MessageRole;
    status: string;
    kind: string;
    title: string;
    detail: string;
    text: string;
}

export interface FileTarget {
    path: string;
    line?: number;
}
