import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { AcpConnection, isAuthError } from "../acp/connection";
import { contentText, emptyTokenUsage, extractDiffs, flattenOptions, mergeTokenUsage, readAntigravityTier, readAuthMethods, readPromptUsage, readStopReason } from "../acp/content";
import { buildElicitationResponse, parseElicitationRequest } from "../acp/elicitation";
import { ClientTools } from "../acp/tools";
import { fetchCreditsQuota, fetchUsageQuota } from "../agent/quota";
import { AgyRuntime } from "../agent/runtime";
import { type CursorConversationSummary } from "../cursor/discover";
import { CursorScanner } from "../cursor/scanner";
import { buildContinuation, titleFrom, type TranscriptMessage } from "../cursor/parse";
import { agentEnv, normalizeFontSize, readSettings, workspaceCwd, workspacePaths, type AgySettings } from "../settings";
import { asRecord, clip, countDiffLines, errorMessage, normalizeProxy, redactProxy, resolveProxy, withNetworkHint } from "../util";
import { displayLineRange, formatAttachedPrompt } from "./prompt";
import { blankMessage, ChatStore } from "./store";
import type { AccountTierView, AuthMethodView, ChatRecord, ChatTokenStats, CodeAttachment, CommandView, ConfigOptionView, ElicitationAction, ElicitationView, HostMessage, LinkStatus, ModeView, PermissionView, QuotaBucketView, QuotaGroupView, QuotaStateView, StoredMessage, TokenUsage, ToolDiff, ViewState } from "./types";

const API_KEY_SECRET = "magy.geminiApiKey";
const LEGACY_API_KEY_SECRET = "mine-agy.geminiApiKey";
const PREFERRED_MODE_KEY = "magy.preferredMode";
const PREFERRED_OPTIONS_KEY = "magy.preferredOptions";
const CACHED_QUOTA_KEY = "magy.cachedQuota";
const AUTH_CONFIRMED_KEY = "magy.authConfirmed";
const SKIP_PERMISSIONS_MODE_ID = "bypass-permissions";
const UI_LIMIT = 300;
const BUILTIN_USAGE_COMMAND: CommandView = { name: "usage", description: "查看账号剩余用量与当前对话 Token 统计" };

interface CursorCache {
    key: string;
    conversations: CursorConversationSummary[];
    warnings: string[];
    fetchedAt: number;
}

interface CursorPickItem extends vscode.QuickPickItem {
    summary?: CursorConversationSummary;
    toggleAll?: boolean;
    toggleWorkspace?: boolean;
}

interface PendingElicitation {
    view: ElicitationView;
    resolve: (result: unknown) => void;
}

interface Outgoing {
    chatId: string;
    text: string;
    attachments: CodeAttachment[];
}

export class ChatController implements vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private webview: vscode.Webview | undefined;
    private settings: AgySettings;
    private connection: AcpConnection | undefined;
    private readonly tools: ClientTools;
    private active: ChatRecord | undefined;
    private streamingChatId: string | undefined;
    private activeSessionId: string | undefined;
    private initialized = false;
    private protocolVersion = 1;
    private status: LinkStatus = "connecting";
    private statusText = "等待连接";
    private hasAuthenticatedInSession = false;
    private hasEverAuthenticated = false;
    private runtimeLabel = "未安装";
    private runtimeBinary = "";
    private quota: QuotaStateView = { loading: false, groups: [] };
    private quotaPromise: Promise<void> | undefined;
    private quotaCliChain: Promise<void> = Promise.resolve();
    private initialQuotaWarmed = false;
    private quotaWarmTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly cursorScanner = new CursorScanner();
    private cursorCache: CursorCache | undefined;
    private cursorWarmPromise: Promise<CursorCache> | undefined;
    private cursorWarmKey = "";
    private cursorWarmTimer: ReturnType<typeof setTimeout> | undefined;
    private busy = false;
    private awaitingIdle = false;
    private started = false;
    private disposed = false;
    private restartAfterTurn = false;
    private pendingPrompt: Outgoing | undefined;
    private readonly queue: Outgoing[] = [];
    private draft: CodeAttachment[] = [];
    private modes: ModeView[] = [];
    private currentModeId = "";
    private options: ConfigOptionView[] = [];
    private authMethods: AuthMethodView[] = [];
    private commands: CommandView[] = [];
    private permission: PermissionView | undefined;
    private readonly permissionWaiters = new Map<string, (optionId: string | null) => void>();
    private readonly elicitationQueue: PendingElicitation[] = [];
    private turnToken = "";
    private recordedUsageTurnToken = "";
    private connectionPromise: Promise<void> | undefined;
    private sessionChain: Promise<void> = Promise.resolve();
    private deltaTimer: ReturnType<typeof setTimeout> | undefined;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private saveChat: ChatRecord | undefined;
    private readonly deletedIds = new Set<string>();
    private readonly pendingDeltas = new Map<string, StoredMessage>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        private readonly store: ChatStore,
        private readonly runtime: AgyRuntime,
    ) {
        this.settings = readSettings();
        this.quota = this.loadCachedQuota();
        this.hasEverAuthenticated = Boolean(this.context.globalState.get<boolean>(AUTH_CONFIRMED_KEY));
        this.tools = new ClientTools(() => {
            const folders = workspacePaths();
            return folders.length ? folders : [workspaceCwd()];
        });
    }

    attach(view: vscode.WebviewView, extensionUri: vscode.Uri): void {
        this.view = view;
        const webview = view.webview;
        this.webview = webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, "media"),
                vscode.Uri.joinPath(extensionUri, "out", "webview"),
            ],
        };
        webview.html = htmlFor(webview, extensionUri);
        webview.onDidReceiveMessage((message) => {
            void this.onMessage(message);
        });
        this.syncViewTitle();
    }

    detach(webview: vscode.Webview): void {
        if (this.webview === webview) {
            this.webview = undefined;
            this.view = undefined;
        }
    }

    toggleHistory(): void {
        this.post({ type: "toggleHistory" });
    }

    toggleSettings(): void {
        this.post({ type: "toggleSettings" });
    }

    toggleUsage(): void {
        this.post({ type: "toggleUsage" });
    }

    async newChat(): Promise<void> {
        await this.flushSave();
        this.clearPendingDeltas();
        if (this.active && !this.active.messages.length && !this.active.imported && !this.busy) {
            this.active.updatedAt = Date.now();
            if (this.status === "ready") {
                this.statusText = this.readyLabel();
            }
            this.postSnapshot();
            await this.focus();
            return;
        }
        const chat = this.store.create();
        this.active = chat;
        this.activeSessionId = undefined;
        if (this.status === "ready") {
            this.statusText = this.readyLabel();
        }
        await this.store.save(chat);
        this.postSnapshot();
        await this.focus();
        if (this.connection && this.initialized && !this.busy) {
            try {
                await this.bindSession(chat);
            } catch (error) {
                this.fail(withNetworkHint(error));
            }
        }
    }

    async importCursor(): Promise<void> {
        if (!this.view?.visible) {
            await this.focus();
        }
        const picked = await this.pickConversation();
        if (!picked) {
            return;
        }
        const loaded = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在引入 Cursor 对话",
        }, () => this.cursorScanner.load(picked, this.settings.cursorDataDir || undefined));
        const title = loaded.title || picked.title;
        const source = loaded.messages;
        const visible = source.length > UI_LIMIT ? source.slice(-UI_LIMIT) : source;
        const omitted = source.length - visible.length;
        const messages: StoredMessage[] = [
            blankMessage("system", omitted
                ? `已导入 Cursor 对话「${title}」（已折叠较早的 ${omitted} 条），发送消息时将作为上下文继续对话。`
                : `已导入 Cursor 对话「${title}」，发送消息时将作为上下文继续对话。`, { imported: true }),
            ...visible.map((message) => fromTranscript(message)),
        ];
        await this.flushSave();
        this.clearPendingDeltas();
        const chat = this.store.create({
            title,
            imported: true,
            needsContext: source.some((message) => message.role === "user" || message.role === "assistant"),
            contextText: buildContinuation(title, source),
            messages,
        });
        this.active = chat;
        this.activeSessionId = undefined;
        if (this.status === "ready") {
            this.statusText = this.readyLabel();
        }
        await this.store.save(chat);
        this.postSnapshot();
        if (this.connection && this.initialized && !this.busy && this.status !== "auth") {
            try {
                await this.bindSession(chat);
            } catch (error) {
                this.fail(withNetworkHint(error));
            }
        }
    }

    async installRuntime(): Promise<void> {
        if (this.busy) {
            void vscode.window.showWarningMessage("当前正在生成，请稍后再更新反重力");
            return;
        }
        this.stopProcess();
        this.status = "connecting";
        this.statusText = "正在更新反重力";
        this.pushStatus();
        try {
            const network = this.network();
            const info = await this.runtime.ensure({
                proxy: network.proxy,
                noProxy: network.noProxy,
                force: true,
                onProgress: (text) => {
                    this.statusText = text;
                    this.pushStatus();
                },
            });
            this.runtimeBinary = info.binary;
            this.runtimeLabel = `内置 ${info.version}`;
            this.status = "disconnected";
            this.statusText = this.settings.binaryPath
                ? `已更新内置版本 ${info.version}（当前仍使用 magy.binaryPath 指定的路径）`
                : `已安装 ${info.version}`;
            this.pushStatus();
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    async setApiKey(): Promise<void> {
        await this.login("gemini-api-key");
    }

    async toggleSkipPermissions(): Promise<void> {
        const next = !this.settings.dangerouslySkipPermissions;
        await vscode.workspace.getConfiguration("magy").update("dangerouslySkipPermissions", next, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(next
            ? "已开启跳过权限模式 (--dangerously-skip-permissions)"
            : "已关闭跳过权限模式");
    }

    onWorkspaceFoldersChanged(): void {
        this.cursorCache = undefined;
        this.scheduleCursorWarmup(600);
    }

    onSettingsChanged(): void {
        const prev = this.settings;
        const prevSkip = this.isSkipPermissions();
        this.settings = readSettings();
        if (prev.cursorDataDir !== this.settings.cursorDataDir) {
            this.cursorCache = undefined;
            this.scheduleCursorWarmup(600);
        }
        const nextSkip = this.isSkipPermissions();
        if (nextSkip) {
            this.approvePendingPermissions();
        }
        const processChanged = prev.proxy !== this.settings.proxy
            || prev.noProxy !== this.settings.noProxy
            || prev.binaryPath !== this.settings.binaryPath
            || prev.sandbox !== this.settings.sandbox
            || prev.dangerouslySkipPermissions !== this.settings.dangerouslySkipPermissions
            || prev.extraArgs.join("\0") !== this.settings.extraArgs.join("\0");
        if (!processChanged) {
            this.pushStatus();
            return;
        }
        if (this.busy) {
            this.restartAfterTurn = true;
            this.statusText = "设置已更改，当前回合结束后重连";
            this.pushStatus();
            return;
        }
        const relink = this.status === "auth"
            || this.status === "connecting"
            || this.status === "disconnected"
            || this.status === "error"
            || !(this.active?.messages.length)
            || prevSkip !== nextSkip;
        this.stopProcess();
        if (relink) {
            void this.rebindActiveAfterRestart();
            return;
        }
        this.status = "disconnected";
        this.statusText = "设置已更新，下次发送时重新连接";
        this.pushStatus();
    }

    private async rebindActiveAfterRestart(): Promise<void> {
        try {
            await this.ensureConnection();
            if (this.active) {
                await this.bindSession(this.active);
            }
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    private async setProxy(value: string): Promise<void> {
        const proxy = normalizeProxy(value);
        const cfg = vscode.workspace.getConfiguration("magy");
        const current = normalizeProxy(String(cfg.get("proxy", "") ?? ""));
        if (proxy === current && proxy === this.network().proxy) {
            return;
        }
        await cfg.update("proxy", proxy, vscode.ConfigurationTarget.Global);
    }

    private async updateSettings(rawPatch: unknown): Promise<void> {
        const patch = asRecord(rawPatch);
        const cfg = vscode.workspace.getConfiguration("magy");
        if (typeof patch.proxy === "string") {
            await cfg.update("proxy", normalizeProxy(patch.proxy), vscode.ConfigurationTarget.Global);
        }
        if (typeof patch.noProxy === "string") {
            await cfg.update("noProxy", patch.noProxy.trim() || "localhost,127.0.0.1,::1", vscode.ConfigurationTarget.Global);
        }
        if (typeof patch.dangerouslySkipPermissions === "boolean") {
            await cfg.update("dangerouslySkipPermissions", patch.dangerouslySkipPermissions, vscode.ConfigurationTarget.Global);
        }
        if (typeof patch.sandbox === "boolean") {
            await cfg.update("sandbox", patch.sandbox, vscode.ConfigurationTarget.Global);
        }
        if (typeof patch.binaryPath === "string") {
            await cfg.update("binaryPath", patch.binaryPath.trim(), vscode.ConfigurationTarget.Global);
        }
        if (typeof patch.cursorDataDir === "string") {
            await cfg.update("cursorDataDir", patch.cursorDataDir.trim(), vscode.ConfigurationTarget.Global);
        }
        if (patch.fontSize !== undefined) {
            await cfg.update("fontSize", normalizeFontSize(patch.fontSize), vscode.ConfigurationTarget.Global);
        }
        this.settings = readSettings();
        this.pushStatus();
    }

    dispose(): void {
        this.disposed = true;
        if (this.deltaTimer) {
            clearTimeout(this.deltaTimer);
        }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        if (this.cursorWarmTimer) {
            clearTimeout(this.cursorWarmTimer);
        }
        if (this.quotaWarmTimer) {
            clearTimeout(this.quotaWarmTimer);
        }
        this.cursorScanner.dispose();
        for (const waiter of this.permissionWaiters.values()) {
            waiter(null);
        }
        this.permissionWaiters.clear();
        this.cancelAllElicitations();
        this.stopProcess();
    }

    private async onMessage(message: unknown): Promise<void> {
        const record = asRecord(message);
        try {
            switch (record.type) {
                case "ready":
                    if (!this.started) {
                        this.started = true;
                        await this.bootstrap();
                    } else {
                        this.postSnapshot();
                    }
                    return;
                case "send":
                    await this.send(String(record.text ?? ""));
                    return;
                case "removeAttachment":
                    this.draft = this.draft.filter((item) => item.id !== String(record.id ?? ""));
                    this.pushStatus();
                    return;
                case "cancel":
                    this.cancel();
                    return;
                case "newChat":
                    await this.newChat();
                    return;
                case "selectChat":
                    await this.selectChat(String(record.id ?? ""));
                    return;
                case "deleteChat":
                    await this.deleteChat(String(record.id ?? ""));
                    return;
                case "importCursor":
                    await this.importCursor();
                    return;
                case "setOption":
                    await this.setOption(String(record.configId ?? ""), String(record.value ?? ""));
                    return;
                case "setMode":
                    await this.setMode(String(record.modeId ?? ""));
                    return;
                case "permission":
                    this.resolvePermission(String(record.requestId ?? ""), typeof record.optionId === "string" ? record.optionId : null);
                    return;
                case "elicitation": {
                    const actionRaw = record.action;
                    const action: ElicitationAction = actionRaw === "accept" || actionRaw === "decline"
                        ? actionRaw
                        : "cancel";
                    this.resolveElicitation(String(record.requestId ?? ""), action, asRecord(record.content));
                    return;
                }
                case "login":
                    await this.login(String(record.methodId ?? ""));
                    return;
                case "setProxy":
                    await this.setProxy(String(record.proxy ?? ""));
                    return;
                case "updateSettings":
                    await this.updateSettings(record.patch);
                    return;
                case "setApiKey":
                    await this.setApiKey();
                    return;
                case "openIdeSettings":
                    await vscode.commands.executeCommand("workbench.action.openSettings", "magy.");
                    return;
                case "retry":
                    await this.retry();
                    return;
                case "install":
                    await this.installRuntime();
                    return;
                case "showLog":
                    this.output.show(true);
                    return;
                case "refreshQuota":
                    void this.refreshQuota(Boolean(record.force));
                    return;
                case "openLink":
                    await this.openLink(String(record.href ?? ""));
                    return;
                case "openFile":
                    await this.openFile(
                        String(record.path ?? ""),
                        typeof record.line === "number" && Number.isFinite(record.line) ? record.line : undefined,
                    );
                    return;
                case "revealPath":
                    await this.revealPath(String(record.path ?? ""));
                    return;
                case "addDroppedPaths":
                    await this.addDroppedPaths(Array.isArray(record.items) ? record.items : []);
                    return;
                default:
                    return;
            }
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    private async bootstrap(): Promise<void> {
        await this.current();
        this.ensureFallbackAuth();
        this.postSnapshot();
        this.scheduleCursorWarmup(800);
        try {
            await this.ensureSession(await this.current());
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    private async retry(): Promise<void> {
        this.stopProcess();
        try {
            await this.ensureSession(await this.current());
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    async addSelection(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selections.every((item) => item.isEmpty)) {
            void vscode.window.showInformationMessage("先在编辑器中选中代码或文本");
            return;
        }
        const document = editor.document;
        const relative = document.uri.scheme === "file"
            ? vscode.workspace.asRelativePath(document.uri, false)
            : path.basename(document.fileName);
        const relativePath = relative.replace(/\\/g, "/");
        let added = 0;
        for (const selection of editor.selections) {
            if (selection.isEmpty) {
                continue;
            }
            const text = document.getText(selection);
            if (!text.trim()) {
                continue;
            }
            const range = displayLineRange(selection.start.line, selection.end.line, selection.end.character);
            const attachment: CodeAttachment = {
                id: randomUUID(),
                kind: "selection",
                fileName: path.basename(relativePath),
                relativePath,
                languageId: document.languageId,
                startLine: range.startLine,
                endLine: range.endLine,
                text: clip(text, 20000),
            };
            const key = attachmentKey(attachment);
            this.draft = this.draft.filter((item) => attachmentKey(item) !== key);
            this.draft.push(attachment);
            added += 1;
        }
        if (!added) {
            return;
        }
        await this.focus();
        this.pushStatus();
    }

    async addPaths(uris: readonly vscode.Uri[]): Promise<void> {
        const list = uris.length
            ? uris
            : (vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : []);
        if (!list.length) {
            void vscode.window.showInformationMessage("先选中或右键点击一个文件或目录");
            return;
        }
        const added = await this.attachUris(list);
        if (!added) {
            return;
        }
        await this.focus();
        this.pushStatus();
    }

    private async addDroppedPaths(rawItems: readonly unknown[]): Promise<void> {
        const uris: vscode.Uri[] = [];
        const seen = new Set<string>();
        for (const item of rawItems) {
            const raw = String(item ?? "").trim();
            if (!raw) {
                continue;
            }
            const resolved = await this.resolveDropTarget(raw);
            if (!resolved) {
                continue;
            }
            const key = resolved.fsPath.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            uris.push(resolved);
        }
        if (!uris.length) {
            return;
        }
        const added = await this.attachUris(uris);
        if (added) {
            this.pushStatus();
        }
    }

    private async attachUris(uris: readonly vscode.Uri[]): Promise<number> {
        let added = 0;
        for (const uri of uris) {
            if (uri.scheme !== "file") {
                continue;
            }
            let isDir = false;
            try {
                const stat = await fs.stat(uri.fsPath);
                isDir = stat.isDirectory();
            } catch {
                continue;
            }
            const relative = vscode.workspace.asRelativePath(uri, false);
            const relativePath = (relative || uri.fsPath).replace(/\\/g, "/");
            const fileName = path.basename(relativePath) || relativePath;
            const attachment: CodeAttachment = {
                id: randomUUID(),
                kind: isDir ? "directory" : "file",
                fileName,
                relativePath,
                languageId: "",
                startLine: 0,
                endLine: 0,
                text: "",
            };
            const key = attachmentKey(attachment);
            this.draft = this.draft.filter((item) => attachmentKey(item) !== key);
            this.draft.push(attachment);
            added += 1;
        }
        return added;
    }

    private async resolveDropTarget(raw: string): Promise<vscode.Uri | undefined> {
        if (/^file:\/\//i.test(raw)) {
            try {
                const parsed = vscode.Uri.parse(raw);
                if (parsed.scheme === "file") {
                    const stat = await fs.stat(parsed.fsPath);
                    if (stat.isFile() || stat.isDirectory()) {
                        return parsed;
                    }
                }
            } catch {
                return undefined;
            }
            return undefined;
        }
        const cleaned = raw.replace(/^["']|["']$/g, "").replace(/^\/([A-Za-z]:[\\/])/, "$1").trim();
        if (!cleaned || /^https?:\/\//i.test(cleaned)) {
            return undefined;
        }
        const resolved = await this.resolveLocalEntryUri(cleaned, true);
        return resolved;
    }

    private async send(text: string): Promise<void> {
        const trimmed = text.trim();
        const attachments = this.draft.slice();
        if (!trimmed && !attachments.length) {
            return;
        }
        if (!attachments.length && /^\/(usage|quota)$/i.test(trimmed)) {
            this.post({ type: "toggleUsage", open: true });
            void this.refreshQuota(true);
            return;
        }
        this.draft = [];
        const chat = await this.current();
        const outgoing: Outgoing = { chatId: chat.id, text: trimmed, attachments };
        if (this.busy) {
            this.queue.push(outgoing);
            this.addMessage(chat, userMessage(outgoing));
            this.retitle(chat, outgoing);
            this.statusText = "已加入队列，当前回合结束后发送";
            this.pushStatus();
            return;
        }
        await this.runPrompt(chat, outgoing, true);
    }

    private async runPrompt(chat: ChatRecord, outgoing: Outgoing, display: boolean): Promise<void> {
        const promptBody = formatAttachedPrompt(outgoing.text, outgoing.attachments);
        if (display) {
            this.addMessage(chat, userMessage(outgoing));
            this.retitle(chat, outgoing);
        }
        this.streamingChatId = chat.id;
        this.turnToken = randomUUID();
        this.busy = true;
        this.awaitingIdle = false;
        this.status = "running";
        this.statusText = "正在生成";
        this.pushStatus();
        let consumedContext = false;
        try {
            const sessionStatus = await this.ensureSession(chat);
            if (sessionStatus === "auth" || !chat.acpSessionId || !this.connection) {
                this.pendingPrompt = outgoing;
                this.busy = false;
                this.streamingChatId = undefined;
                this.pushStatus();
                return;
            }
            let prompt = promptBody;
            if (chat.needsContext && chat.contextText) {
                prompt = `${chat.contextText}\n\n# 当前请求\n${promptBody}`;
                chat.needsContext = false;
                consumedContext = true;
            }
            const result = await this.connection.request("session/prompt", {
                sessionId: chat.acpSessionId,
                prompt: [{ type: "text", text: prompt }],
            });
            const turnUsage = readPromptUsage(result);
            if (turnUsage && this.recordedUsageTurnToken !== this.turnToken) {
                this.recordedUsageTurnToken = this.turnToken;
                this.recordTurnUsage(chat, turnUsage);
            }
            const stop = readStopReason(result);
            if (stop || this.protocolVersion < 2) {
                this.finishTurn(stop || "end_turn");
            } else {
                this.awaitingIdle = true;
                this.statusText = "正在生成";
                this.pushStatus();
            }
        } catch (error) {
            if (consumedContext) {
                chat.needsContext = true;
            }
            this.busy = false;
            this.streamingChatId = undefined;
            if (this.disposed) {
                return;
            }
            if (isAuthError(error)) {
                this.handleAuthFailure();
                return;
            }
            this.fail(withNetworkHint(error));
        } finally {
            this.scheduleSave(chat);
        }
    }

    private finishTurn(stopReason: string): void {
        const target = this.streamingChatId ? (this.store.peek(this.streamingChatId) ?? this.active) : this.active;
        if (target) {
            this.finalizeActiveMessages(target, stopReason === "cancelled" ? "cancelled" : "completed");
            this.scheduleSave(target);
        }
        this.busy = false;
        this.awaitingIdle = false;
        this.streamingChatId = undefined;
        const label = stopLabel(stopReason);
        this.status = "ready";
        this.statusText = label || this.readyLabel();
        this.pushStatus();
        if (this.restartAfterTurn) {
            this.restartAfterTurn = false;
            this.stopProcess();
            this.status = "disconnected";
            this.statusText = "设置已更新，下次发送时重新连接";
            this.pushStatus();
            return;
        }
        const next = this.queue.shift();
        if (next) {
            void this.resumeQueued(next);
        }
    }

    private async resumeQueued(next: Outgoing): Promise<void> {
        const queued = this.store.peek(next.chatId) ?? await this.store.get(next.chatId);
        if (queued) {
            await this.runPrompt(queued, next, false);
        }
    }

    private cancel(): void {
        const chat = this.active;
        if (this.connection && chat?.acpSessionId) {
            try {
                this.connection.notify("session/cancel", { sessionId: chat.acpSessionId });
            } catch (error) {
                this.output.appendLine(withNetworkHint(error));
            }
        }
        for (const waiter of this.permissionWaiters.values()) {
            waiter(null);
        }
        this.permissionWaiters.clear();
        this.permission = undefined;
        this.cancelAllElicitations();
        this.queue.length = 0;
        this.statusText = "正在取消";
        this.pushStatus();
    }

    private async selectChat(id: string): Promise<void> {
        if (this.deletedIds.has(id)) {
            return;
        }
        const chat = await this.store.get(id);
        if (!chat) {
            return;
        }
        await this.flushSave();
        this.clearPendingDeltas();
        this.active = chat;
        this.activeSessionId = undefined;
        if (this.status === "ready") {
            this.statusText = this.readyLabel();
        }
        this.store.setActive(chat.id);
        await this.store.rememberActive();
        this.postSnapshot();
        if (!this.connection || !this.initialized || this.busy || this.status === "auth") {
            return;
        }
        try {
            await this.bindSession(chat);
        } catch (error) {
            this.fail(withNetworkHint(error));
        }
    }

    private async deleteChat(id: string): Promise<void> {
        if (this.streamingChatId === id) {
            return;
        }
        this.deletedIds.add(id);
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            if (this.queue[index].chatId === id) {
                this.queue.splice(index, 1);
            }
        }
        if (this.saveChat?.id === id) {
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
                this.saveTimer = undefined;
            }
            this.saveChat = undefined;
        }
        const deletingActive = this.active?.id === id;
        if (deletingActive) {
            this.clearPendingDeltas();
            this.active = undefined;
            this.activeSessionId = undefined;
        }
        await this.store.remove(id);
        if (!deletingActive) {
            this.pushStatus();
            return;
        }
        const next = this.store.list()[0];
        if (next) {
            await this.selectChat(next.id);
            return;
        }
        await this.newChat();
    }

    private async setOption(configId: string, value: string): Promise<void> {
        if (!configId || !value) {
            return;
        }
        await this.savePreferredOption(configId, value);
        const chat = await this.current();
        if (!this.connection || !this.initialized) {
            this.updateLocalOption(configId, value);
            this.pushStatus();
            return;
        }
        if (!chat.acpSessionId) {
            await this.bindSession(chat, true);
        }
        if (!chat.acpSessionId) {
            this.updateLocalOption(configId, value);
            this.pushStatus();
            return;
        }
        const result = await this.connection.request("session/set_config_option", {
            sessionId: chat.acpSessionId,
            configId,
            value,
        }, 20000);
        this.applySessionMeta(result);
        this.updateLocalOption(configId, value);
        this.pushStatus();
    }

    private async setMode(modeId: string): Promise<void> {
        if (!modeId) {
            return;
        }
        if (modeId === SKIP_PERMISSIONS_MODE_ID) {
            if (!this.settings.dangerouslySkipPermissions) {
                await vscode.workspace.getConfiguration("magy").update("dangerouslySkipPermissions", true, vscode.ConfigurationTarget.Global);
            }
            this.approvePendingPermissions();
            this.pushStatus();
            return;
        }
        await this.context.globalState.update(PREFERRED_MODE_KEY, modeId);
        if (this.settings.dangerouslySkipPermissions) {
            this.currentModeId = modeId;
            await vscode.workspace.getConfiguration("magy").update("dangerouslySkipPermissions", false, vscode.ConfigurationTarget.Global);
            this.pushStatus();
            return;
        }
        if (this.settings.extraArgs.includes("--dangerously-skip-permissions")) {
            const nextArgs = this.settings.extraArgs.filter((item) => item !== "--dangerously-skip-permissions");
            this.currentModeId = modeId;
            await vscode.workspace.getConfiguration("magy").update("extraArgs", nextArgs, vscode.ConfigurationTarget.Global);
            this.pushStatus();
            return;
        }
        const chat = await this.current();
        if (!this.connection || !this.initialized) {
            this.currentModeId = modeId;
            this.pushStatus();
            return;
        }
        if (!chat.acpSessionId) {
            await this.bindSession(chat, true);
        }
        if (!chat.acpSessionId) {
            this.currentModeId = modeId;
            this.pushStatus();
            return;
        }
        await this.connection.request("session/set_mode", { sessionId: chat.acpSessionId, modeId }, 20000);
        this.currentModeId = modeId;
        this.pushStatus();
    }

    private isSkipPermissions(): boolean {
        return this.settings.dangerouslySkipPermissions || this.settings.extraArgs.includes("--dangerously-skip-permissions");
    }

    private approvePendingPermissions(): void {
        if (!this.permission) {
            return;
        }
        const optionId = pickAutoApproveOption(this.permission.options.map((item) => ({
            optionId: item.id,
            kind: item.kind,
        })));
        this.resolvePermission(this.permission.requestId, optionId);
    }

    private async savePreferredOption(configId: string, value: string): Promise<void> {
        const current = this.context.globalState.get<Record<string, string>>(PREFERRED_OPTIONS_KEY) ?? {};
        await this.context.globalState.update(PREFERRED_OPTIONS_KEY, { ...current, [configId]: value });
    }

    private updateLocalOption(configId: string, value: string): void {
        const target = this.options.find((item) => item.id === configId);
        if (target && target.options.some((choice) => choice.value === value)) {
            target.current = value;
        }
    }

    private async applyPreferences(connection: AcpConnection, sessionId: string, isCurrentTarget: () => boolean): Promise<void> {
        const preferredMode = this.context.globalState.get<string>(PREFERRED_MODE_KEY);
        if (preferredMode && preferredMode !== this.currentModeId && this.modes.some((mode) => mode.id === preferredMode)) {
            try {
                await connection.request("session/set_mode", { sessionId, modeId: preferredMode }, 15000);
                if (isCurrentTarget()) {
                    this.currentModeId = preferredMode;
                }
            } catch (error) {
                this.output.appendLine(`恢复模式偏好失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const preferredOptions = this.context.globalState.get<Record<string, string>>(PREFERRED_OPTIONS_KEY) ?? {};
        const orderedIds = [
            ...this.options
                .filter((item) => item.id === "model" || item.category === "model")
                .map((item) => item.id),
            ...this.options
                .filter((item) => item.id !== "model" && item.category !== "model")
                .map((item) => item.id),
        ];
        for (const optionId of orderedIds) {
            const option = this.options.find((item) => item.id === optionId);
            if (!option) {
                continue;
            }
            const preferredValue = preferredOptions[option.id];
            if (!preferredValue || preferredValue === option.current) {
                continue;
            }
            if (!option.options.some((choice) => choice.value === preferredValue)) {
                continue;
            }
            try {
                const result = await connection.request("session/set_config_option", {
                    sessionId,
                    configId: option.id,
                    value: preferredValue,
                }, 15000);
                if (isCurrentTarget()) {
                    this.applySessionMeta(result);
                    this.updateLocalOption(option.id, preferredValue);
                }
            } catch (error) {
                this.output.appendLine(`恢复选项 ${option.id} 偏好失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async login(methodId: string): Promise<void> {
        if (!methodId) {
            return;
        }
        if (methodId === "gemini-api-key") {
            const key = await vscode.window.showInputBox({
                title: "Gemini API Key",
                password: true,
                ignoreFocusOut: true,
                prompt: "密钥只保存在编辑器的机密存储中",
            });
            if (!key?.trim()) {
                return;
            }
            await this.context.secrets.store(API_KEY_SECRET, key.trim());
            if (this.busy) {
                this.restartAfterTurn = true;
                this.statusText = "密钥已保存，当前回合结束后生效";
                this.pushStatus();
                return;
            }
            this.stopProcess();
        }
        await this.ensureConnection();
        if (methodId !== "gemini-api-key") {
            this.statusText = "正在等待浏览器登录";
            this.pushStatus();
            const conn = this.requireConnection();
            try {
                await conn.request("authenticate", { methodId });
            } catch (error) {
                if (this.connection !== conn) {
                    return;
                }
                throw error;
            }
            if (this.connection !== conn) {
                return;
            }
        }
        const chat = await this.current();
        this.quota.error = undefined;
        await this.bindSession(chat);
        if (this.pendingPrompt && this.status === "ready") {
            const pending = this.pendingPrompt;
            this.pendingPrompt = undefined;
            const chatForPrompt = this.store.peek(pending.chatId) ?? await this.store.get(pending.chatId);
            if (chatForPrompt) {
                await this.runPrompt(chatForPrompt, pending, false);
            }
        }
    }

    private async ensureSession(chat: ChatRecord): Promise<LinkStatus> {
        await this.ensureConnection();
        if (!this.connection || !this.initialized) {
            return this.status;
        }
        if (chat.acpSessionId && this.activeSessionId === chat.acpSessionId && this.status !== "auth") {
            return this.status;
        }
        await this.bindSession(chat, true);
        return this.status;
    }

    private async ensureConnection(): Promise<void> {
        if (this.connection && this.initialized) {
            return;
        }
        if (!this.connectionPromise) {
            this.connectionPromise = this.startConnection().finally(() => {
                this.connectionPromise = undefined;
            });
        }
        await this.connectionPromise;
    }

    private async startConnection(): Promise<void> {
        const connectLabel = this.hasAuthenticatedInSession ? "正在重新连接" : "等待连接";
        this.status = "connecting";
        this.statusText = connectLabel;
        this.pushStatus();
        const network = this.network();
        const info = await this.runtime.ensure({
            proxy: network.proxy,
            noProxy: network.noProxy,
            binaryPath: this.settings.binaryPath,
            onProgress: (text) => {
                this.statusText = text;
                this.pushStatus();
            },
        });
        this.runtimeBinary = info.binary;
        this.runtimeLabel = info.managed ? `内置 ${info.version}` : `自定义路径`;
        const logFile = path.join(this.context.globalStorageUri.fsPath, "logs", "acp.log");
        await fs.mkdir(path.dirname(logFile), { recursive: true });
        const args = ["acp", "--log-file", logFile];
        if (this.settings.sandbox && !this.settings.extraArgs.includes("--sandbox")) {
            args.push("--sandbox");
        }
        if (this.isSkipPermissions() && !this.settings.extraArgs.includes("--dangerously-skip-permissions")) {
            args.push("--dangerously-skip-permissions");
        }
        args.push(...this.settings.extraArgs);
        const apiKey = await this.context.secrets.get(API_KEY_SECRET) || await this.context.secrets.get(LEGACY_API_KEY_SECRET);
        const connection = new AcpConnection(info.binary, args, {
            cwd: workspaceCwd(),
            env: agentEnv(this.settings, apiKey),
            onStderr: (text) => this.output.append(text),
            onProtocolError: (text) => this.output.appendLine(text),
        });
        this.connection = connection;
        connection.setExitHandler((code) => {
            if (this.disposed || this.connection !== connection) {
                return;
            }
            this.connection = undefined;
            this.initialized = false;
            this.activeSessionId = undefined;
            this.fail(`反重力进程已退出 (${code ?? "未知"})`);
        });
        connection.setNotificationHandler((method, params) => {
            if (method === "session/update") {
                this.onUpdate(params);
            }
        });
        connection.setRequestHandler((method, params) => this.onAgentRequest(method, params));
        this.statusText = connectLabel;
        this.pushStatus();
        const init = await connection.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                elicitation: { form: {} },
            },
            clientInfo: { name: "magy", title: "MAGY", version: String(this.context.extension.packageJSON.version ?? "0.2.0") },
        }, 30000);
        this.initialized = true;
        const record = asRecord(init);
        this.protocolVersion = Number(record.protocolVersion ?? 1);
        this.authMethods = googleOnly(readAuthMethods(record.authMethods));
        this.ensureFallbackAuth();
        this.output.appendLine(`已连接 ${this.runtimeLabel}，协议版本 ${this.protocolVersion}`);
        this.output.appendLine(`ACP 日志：${logFile}`);
        this.pushStatus();
    }

    private bindSession(chat: ChatRecord, forPrompt = false): Promise<void> {
        const run = this.sessionChain.then(() => this.bindSessionInner(chat, forPrompt));
        this.sessionChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async bindSessionInner(chat: ChatRecord, forPrompt: boolean): Promise<void> {
        if (this.deletedIds.has(chat.id)) {
            return;
        }
        if (!forPrompt && this.active?.id !== chat.id) {
            return;
        }
        const connection = this.requireConnection();
        const cwd = workspaceCwd();
        const isCurrentTarget = (): boolean => !this.deletedIds.has(chat.id)
            && (this.active?.id === chat.id || this.streamingChatId === chat.id);
        const runWithAuthRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
            try {
                return await fn();
            } catch (error) {
                if (!isAuthError(error) || !(this.hasAuthenticatedInSession || this.hasEverAuthenticated) || this.disposed || this.connection !== connection) {
                    throw error;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 650));
                if (this.disposed || this.connection !== connection) {
                    throw error;
                }
                return await fn();
            }
        };
        if (chat.acpSessionId) {
            try {
                const resumed = await runWithAuthRetry(() => connection.request("session/resume", {
                    sessionId: chat.acpSessionId,
                    cwd,
                    mcpServers: [],
                }, 30000));
                if (!isCurrentTarget()) {
                    return;
                }
                this.activeSessionId = chat.acpSessionId;
                this.applySessionMeta(resumed);
                await this.applyPreferences(connection, chat.acpSessionId, isCurrentTarget);
                if (!isCurrentTarget()) {
                    return;
                }
                this.markAuthenticated();
                this.status = "ready";
                this.statusText = this.readyLabel();
                this.pushStatus();
                this.scheduleInitialQuotaWarmup();
                return;
            } catch (error) {
                if (isAuthError(error)) {
                    this.handleAuthFailure();
                    return;
                }
                if (this.deletedIds.has(chat.id)) {
                    return;
                }
                this.output.appendLine(`无法恢复会话，将新建：${error instanceof Error ? error.message : String(error)}`);
                if (chat.messages.some((message) => message.role === "user" || message.role === "assistant")) {
                    chat.needsContext = true;
                    if (!chat.contextText) {
                        chat.contextText = buildContinuation(chat.title, chat.messages.map(toTranscript));
                    }
                }
                chat.acpSessionId = undefined;
            }
        }
        try {
            const created = await runWithAuthRetry(() => connection.request("session/new", { cwd, mcpServers: [] }, 30000));
            const sessionId = String(asRecord(created).sessionId ?? "");
            if (!sessionId) {
                throw new Error("反重力没有返回会话编号");
            }
            if (this.deletedIds.has(chat.id)) {
                return;
            }
            chat.acpSessionId = sessionId;
            this.scheduleSave(chat);
            if (!isCurrentTarget()) {
                return;
            }
            this.activeSessionId = sessionId;
            this.applySessionMeta(created);
            await this.applyPreferences(connection, sessionId, isCurrentTarget);
            if (!isCurrentTarget()) {
                return;
            }
            this.markAuthenticated();
            this.status = "ready";
            this.statusText = this.readyLabel();
            this.pushStatus();
            this.scheduleInitialQuotaWarmup();
        } catch (error) {
            if (isAuthError(error)) {
                this.handleAuthFailure();
                return;
            }
            throw error;
        }
    }

    private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
        if (method === "session/request_permission") {
            return this.askPermission(params);
        }
        if (method === "elicitation/create") {
            return this.askElicitation(params);
        }
        return this.tools.handle(method, params);
    }

    private askElicitation(params: unknown): Promise<unknown> {
        const requestId = randomUUID();
        const view = parseElicitationRequest(requestId, params);
        void this.focus();
        return new Promise((resolve) => {
            this.elicitationQueue.push({ view, resolve });
            this.pushStatus();
        });
    }

    private resolveElicitation(requestId: string, action: ElicitationAction, content?: Record<string, unknown>): void {
        const index = this.elicitationQueue.findIndex((entry) => entry.view.requestId === requestId);
        if (index < 0) {
            return;
        }
        const [entry] = this.elicitationQueue.splice(index, 1);
        this.pushStatus();
        entry.resolve(buildElicitationResponse(entry.view, action, content));
    }

    private cancelAllElicitations(): void {
        if (!this.elicitationQueue.length) {
            return;
        }
        const entries = this.elicitationQueue.splice(0);
        for (const entry of entries) {
            entry.resolve({ action: "cancel" });
        }
    }

    private askPermission(params: unknown): Promise<unknown> {
        const record = asRecord(params);
        const tool = asRecord(record.toolCall);
        const requestId = randomUUID();
        const options = Array.isArray(record.options) ? record.options : [];
        if (this.isSkipPermissions()) {
            const optionId = pickAutoApproveOption(options);
            if (optionId) {
                return Promise.resolve({ outcome: { outcome: "selected", optionId } });
            }
        }
        void this.focus();
        this.permission = {
            requestId,
            title: String(tool.title ?? tool.name ?? "需要确认"),
            detail: tool.rawInput ? clip(JSON.stringify(tool.rawInput, null, 2), 800) : undefined,
            options: options.map((item) => {
                const option = asRecord(item);
                return {
                    id: String(option.optionId ?? ""),
                    name: String(option.name ?? option.optionId ?? "确认"),
                    kind: String(option.kind ?? ""),
                };
            }).filter((item) => item.id),
        };
        this.pushStatus();
        return new Promise((resolve) => {
            this.permissionWaiters.set(requestId, (optionId) => {
                this.permission = undefined;
                this.pushStatus();
                if (!optionId) {
                    resolve({ outcome: { outcome: "cancelled" } });
                    return;
                }
                resolve({ outcome: { outcome: "selected", optionId } });
            });
        });
    }

    private resolvePermission(requestId: string, optionId: string | null): void {
        const waiter = this.permissionWaiters.get(requestId);
        if (!waiter) {
            return;
        }
        this.permissionWaiters.delete(requestId);
        waiter(optionId);
    }

    private onUpdate(params: unknown): void {
        const envelope = asRecord(params);
        const sessionId = typeof envelope.sessionId === "string" ? envelope.sessionId : undefined;
        const chat = this.targetChat();
        if (!chat) {
            return;
        }
        if (sessionId && chat.acpSessionId && sessionId !== chat.acpSessionId) {
            return;
        }
        const update = asRecord(envelope.update ?? envelope);
        const kind = String(update.sessionUpdate ?? "");
        if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
            if (kind === "user_message_chunk") {
                return;
            }
            const chunk = contentText(update.content);
            if (!chunk) {
                return;
            }
            this.finalizeActiveThoughts(chat);
            const messageId = typeof update.messageId === "string" ? update.messageId : this.turnToken;
            this.appendText(chat, `assistant:${messageId}`, "assistant", chunk);
        } else if (kind === "agent_thought_chunk") {
            const chunk = contentText(update.content);
            if (!chunk) {
                return;
            }
            const messageId = typeof update.messageId === "string" ? update.messageId : this.turnToken;
            this.appendThought(chat, `thought:${messageId}`, chunk);
        } else if (kind === "tool_call" || kind === "tool_call_update") {
            if (kind === "tool_call") {
                this.finalizeActiveThoughts(chat);
            }
            this.upsertTool(chat, update, kind === "tool_call");
        } else if (kind === "plan") {
            this.finalizeActiveThoughts(chat);
            const entries = Array.isArray(update.entries) ? update.entries : [];
            const text = entries.map((entry) => {
                const item = asRecord(entry);
                return `- [${String(item.status ?? "pending")}] ${String(item.content ?? "")}`;
            }).join("\n");
            const done = entries.length > 0 && entries.every((entry) => {
                const s = String(asRecord(entry).status ?? "");
                return s === "completed" || s === "done";
            });
            this.upsertMessage(chat, {
                id: `plan:${this.turnToken || "active"}`,
                role: "tool",
                kind: "plan",
                title: "执行计划",
                status: done ? "completed" : "in_progress",
                text,
            });
        } else if (kind === "current_mode_update") {
            this.currentModeId = String(update.currentModeId ?? "");
            this.pushStatus();
        } else if (kind === "config_option_update") {
            this.applySessionMeta({ configOptions: update.configOptions });
            this.pushStatus();
        } else if (kind === "session_info_update" && typeof update.title === "string" && update.title.trim()) {
            chat.title = update.title.trim();
            this.scheduleSave(chat);
            this.pushStatus();
        } else if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
            const serverCommands = update.availableCommands.map((item) => {
                const command = asRecord(item);
                return { name: String(command.name ?? ""), description: String(command.description ?? "") };
            }).filter((item) => item.name);
            this.commands = withBuiltinCommands(serverCommands);
            this.pushStatus();
        } else if (kind === "usage_update") {
            if (typeof update.used === "number" && typeof update.size === "number" && update.size > 0) {
                this.recordContextUsage(chat, update.used, update.size);
                if (this.status === "ready" && this.active?.id === chat.id) {
                    this.statusText = this.readyLabel();
                }
                this.pushStatus();
            }
        }
        const turnUsage = readPromptUsage(update);
        if (turnUsage && this.turnToken && this.recordedUsageTurnToken !== this.turnToken) {
            this.recordedUsageTurnToken = this.turnToken;
            this.recordTurnUsage(chat, turnUsage);
        }
        const stop = readStopReason(update);
        if (stop && this.awaitingIdle) {
            this.awaitingIdle = false;
            this.finishTurn(stop);
        }
    }

    private applySessionMeta(payload: unknown): void {
        const tier = readAntigravityTier(payload);
        if (tier) {
            const tierChanged = JSON.stringify(this.quota.tier ?? null) !== JSON.stringify(tier);
            this.quota.tier = tier;
            if (!this.quota.upgradeUri && tier.upgradeUri) {
                this.quota.upgradeUri = tier.upgradeUri;
            }
            if (tierChanged) {
                this.saveCachedQuota();
            }
        }
        const record = asRecord(payload);
        const modes = asRecord(record.modes);
        if (Array.isArray(modes.availableModes)) {
            this.modes = modes.availableModes.map((item) => {
                const mode = asRecord(item);
                const description = typeof mode.description === "string" && mode.description.trim()
                    ? mode.description.trim()
                    : undefined;
                return { id: String(mode.id ?? ""), name: String(mode.name ?? mode.id ?? ""), description };
            }).filter((item) => item.id);
            this.currentModeId = String(modes.currentModeId ?? this.currentModeId);
        }
        if (Array.isArray(record.configOptions)) {
            const seen = new Set<string>();
            const next: ConfigOptionView[] = [];
            for (const item of record.configOptions) {
                const option = asRecord(item);
                if (option.type && option.type !== "select") {
                    continue;
                }
                const choices = flattenOptions(option.options);
                if (!choices.length || typeof option.id !== "string") {
                    continue;
                }
                const category = typeof option.category === "string" ? option.category : undefined;
                if (option.id === "mode" || category === "mode") {
                    if (!this.modes.length) {
                        this.modes = choices.map((choice) => ({
                            id: choice.value,
                            name: choice.name,
                            description: choice.description,
                        }));
                    }
                    if (typeof option.currentValue === "string" && option.currentValue) {
                        this.currentModeId = option.currentValue;
                    }
                    continue;
                }
                if (seen.has(option.id)) {
                    continue;
                }
                seen.add(option.id);
                next.push({
                    id: option.id,
                    name: String(option.name ?? option.id),
                    category,
                    current: String(option.currentValue ?? choices[0].value),
                    options: choices,
                });
            }
            this.options = next;
        }
    }

    private scheduleCursorWarmup(delayMs = 800): void {
        if (this.disposed) {
            return;
        }
        if (this.cursorWarmTimer) {
            clearTimeout(this.cursorWarmTimer);
        }
        this.cursorWarmTimer = setTimeout(() => {
            this.cursorWarmTimer = undefined;
            if (!this.disposed) {
                void this.warmCursorConversations(false);
            }
        }, delayMs);
    }

    private warmCursorConversations(force = false): Promise<CursorCache> {
        const userDir = this.settings.cursorDataDir || "";
        const folders = workspacePaths();
        const key = [userDir, ...folders].join("\0");
        if (!force && this.cursorCache && this.cursorCache.key === key) {
            return Promise.resolve(this.cursorCache);
        }
        if (!force && this.cursorWarmPromise && this.cursorWarmKey === key) {
            return this.cursorWarmPromise;
        }
        this.cursorWarmKey = key;
        const run = (async (): Promise<CursorCache> => {
            try {
                const result = await this.cursorScanner.discover({
                    userDir: userDir || undefined,
                    workspacePaths: folders,
                    all: true,
                });
                for (const warning of result.warnings) {
                    this.output.appendLine(warning);
                }
                const cache: CursorCache = {
                    key,
                    conversations: result.conversations,
                    warnings: result.warnings,
                    fetchedAt: Date.now(),
                };
                if (!this.disposed && [this.settings.cursorDataDir || "", ...workspacePaths()].join("\0") === key) {
                    this.cursorCache = cache;
                }
                return cache;
            } catch (error) {
                return {
                    key,
                    conversations: [],
                    warnings: [errorMessage(error)],
                    fetchedAt: Date.now(),
                };
            }
        })().finally(() => {
            if (this.cursorWarmPromise === run) {
                this.cursorWarmPromise = undefined;
            }
        });
        this.cursorWarmPromise = run;
        return run;
    }

    private async pickConversation(): Promise<CursorConversationSummary | undefined> {
        const quickPick = vscode.window.createQuickPick<CursorPickItem>();
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        const refreshButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon("refresh"),
            tooltip: "刷新 Cursor 对话列表",
        };
        quickPick.buttons = [refreshButton];

        let showAll = false;
        let closed = false;
        let settled = false;
        let latestCache: CursorCache | undefined;

        const applyCache = (cache: CursorCache): void => {
            if (closed) {
                return;
            }
            latestCache = cache;
            const workspaceItems = cache.conversations.filter((item) => item.inWorkspace);
            if (!showAll && !workspaceItems.length && cache.conversations.length) {
                showAll = true;
            }
            const visible = showAll ? cache.conversations : workspaceItems;
            const picks: CursorPickItem[] = visible.map((item) => ({
                label: item.title,
                description: [item.mode, formatTime(item.updatedAt)].filter(Boolean).join(" · "),
                detail: `${item.source === "composer" ? "Cursor 对话" : "Agent 记录"}${item.project ? ` · ${item.project}` : ""}${item.inWorkspace ? "" : " · 其他项目"}`,
                summary: item,
            }));
            if (!showAll && cache.conversations.length > workspaceItems.length) {
                picks.push({
                    label: "$(list-selection) 显示其他项目的对话",
                    description: `共 ${cache.conversations.length} 条`,
                    toggleAll: true,
                });
            } else if (showAll && workspaceItems.length > 0) {
                picks.push({
                    label: "$(folder) 仅显示当前工作区对话",
                    description: `${workspaceItems.length} 条`,
                    toggleWorkspace: true,
                });
            }
            quickPick.busy = false;
            quickPick.title = showAll ? "引入 Cursor 对话（本机）" : "引入 Cursor 对话";
            quickPick.placeholder = picks.length
                ? "选择要引入的 Cursor 对话（可输入过滤）"
                : (cache.warnings[0] ?? "没有找到 Cursor 对话");
            quickPick.items = picks;
        };

        return new Promise<CursorConversationSummary | undefined>((resolve) => {
            const finish = (result: CursorConversationSummary | undefined): void => {
                if (settled) {
                    return;
                }
                settled = true;
                closed = true;
                quickPick.dispose();
                resolve(result);
            };

            quickPick.onDidTriggerButton(async (button) => {
                if (button !== refreshButton || closed) {
                    return;
                }
                quickPick.busy = true;
                quickPick.placeholder = "正在刷新 Cursor 对话...";
                const fresh = await this.warmCursorConversations(true);
                applyCache(fresh);
            });

            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (!selected) {
                    return;
                }
                if (selected.toggleAll) {
                    showAll = true;
                    quickPick.value = "";
                    if (latestCache) {
                        applyCache(latestCache);
                    }
                    return;
                }
                if (selected.toggleWorkspace) {
                    showAll = false;
                    quickPick.value = "";
                    if (latestCache) {
                        applyCache(latestCache);
                    }
                    return;
                }
                if (selected.summary) {
                    finish(selected.summary);
                }
            });

            quickPick.onDidHide(() => {
                finish(undefined);
            });

            const key = [this.settings.cursorDataDir || "", ...workspacePaths()].join("\0");
            if (this.cursorCache && this.cursorCache.key === key) {
                applyCache(this.cursorCache);
                quickPick.show();
                return;
            }

            quickPick.title = "引入 Cursor 对话";
            quickPick.placeholder = "正在后台读取 Cursor 对话...";
            quickPick.busy = true;
            quickPick.items = [];
            quickPick.show();
            void this.warmCursorConversations(false).then((cache) => {
                applyCache(cache);
            });
        });
    }

    private async current(): Promise<ChatRecord> {
        if (this.active) {
            return this.active;
        }
        const id = this.store.activeId();
        if (id) {
            const existing = await this.store.get(id);
            if (existing) {
                this.active = existing;
                return existing;
            }
        }
        const chat = this.store.create();
        this.active = chat;
        await this.store.save(chat);
        return chat;
    }

    private targetChat(): ChatRecord | undefined {
        if (this.streamingChatId) {
            return this.store.peek(this.streamingChatId) ?? this.active;
        }
        return this.active;
    }

    private addMessage(chat: ChatRecord, message: StoredMessage): void {
        chat.messages.push(message);
        chat.updatedAt = Date.now();
        this.queueDelta(chat, message);
        this.scheduleSave(chat);
    }

    private appendText(chat: ChatRecord, id: string, role: StoredMessage["role"], text: string, title?: string): void {
        if (!text) {
            return;
        }
        const last = chat.messages.at(-1);
        if (last && (last.id === id || last.id.startsWith(`${id}#`))) {
            last.text += text;
            this.queueDelta(chat, last);
            this.scheduleSave(chat);
            return;
        }
        const nextId = chat.messages.some((item) => item.id === id) ? `${id}#${chat.messages.length}` : id;
        this.upsertMessage(chat, { id: nextId, role, text, title });
    }

    private appendThought(chat: ChatRecord, id: string, text: string): void {
        if (!text) {
            return;
        }
        const last = chat.messages.at(-1);
        if (last && last.role === "thought" && (last.id === id || last.id.startsWith(`${id}#`)) && last.status !== "completed") {
            last.text += text;
            last.status = "in_progress";
            this.queueDelta(chat, last);
            this.scheduleSave(chat);
            return;
        }
        this.finalizeActiveThoughts(chat);
        const nextId = chat.messages.some((item) => item.id === id) ? `${id}#${chat.messages.length}` : id;
        this.upsertMessage(chat, {
            id: nextId,
            role: "thought",
            title: "思考",
            status: "in_progress",
            startedAt: Date.now(),
            text,
        });
    }

    private finalizeActiveThoughts(chat: ChatRecord, status: "completed" | "cancelled" | "failed" = "completed"): void {
        const now = Date.now();
        for (const message of chat.messages) {
            if (message.role === "thought" && (message.status === "in_progress" || message.status === "pending")) {
                message.status = status;
                if (!message.finishedAt) {
                    message.finishedAt = now;
                }
                this.queueDelta(chat, message);
            }
        }
    }

    private finalizeActiveMessages(chat: ChatRecord, status: "completed" | "cancelled" | "failed"): void {
        const now = Date.now();
        for (const message of chat.messages) {
            if ((message.role === "thought" || message.role === "tool") && (message.status === "in_progress" || message.status === "pending")) {
                message.status = status;
                if (!message.finishedAt) {
                    message.finishedAt = now;
                }
                this.queueDelta(chat, message);
            }
        }
    }

    private upsertTool(chat: ChatRecord, update: Record<string, unknown>, fresh: boolean): void {
        const toolCallId = String(update.toolCallId ?? randomUUID());
        const id = `tool:${toolCallId}`;
        const existing = chat.messages.find((item) => item.id === id);
        const rawTitle = typeof update.title === "string" && update.title.trim() ? update.title.trim() : undefined;
        const nextStatus = typeof update.status === "string" ? update.status : (existing?.status ?? (fresh ? "in_progress" : undefined));
        const diffs = extractDiffs(update.content);
        const finalDiffs = diffs.length ? diffs.map((d) => ({ ...d, path: toDisplayPath(d.path) })) : existing?.diffs;
        const body = toolBody(update, finalDiffs);
        const mergedText = body.hasBody || fresh ? clip(body.text, 20000) : existing?.text ?? "";
        const kind = inferToolKind(update, existing?.kind, rawTitle, finalDiffs, mergedText);
        const formatted = formatToolSummary(kind, rawTitle ?? existing?.title ?? String(update.name ?? "工具"), update.rawInput, finalDiffs, mergedText, existing, body.exitCode);
        const now = Date.now();
        const startedAt = existing?.startedAt ?? now;
        const finished = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";
        const finishedAt = finished ? (existing?.finishedAt ?? now) : undefined;
        const message: StoredMessage = {
            id,
            role: "tool",
            kind,
            title: formatted.title,
            detail: formatted.detail,
            filePath: formatted.filePath ?? existing?.filePath,
            line: formatted.line ?? existing?.line,
            status: nextStatus,
            diffs: finalDiffs,
            startedAt,
            finishedAt,
            text: formatted.text,
        };
        this.upsertMessage(chat, message);
    }

    private upsertMessage(chat: ChatRecord, message: StoredMessage): void {
        const index = chat.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) {
            chat.messages[index] = { ...chat.messages[index], ...message };
            this.queueDelta(chat, chat.messages[index]);
        } else {
            chat.messages.push(message);
            this.queueDelta(chat, message);
        }
        chat.updatedAt = Date.now();
        this.scheduleSave(chat);
    }

    private queueDelta(chat: ChatRecord, message: StoredMessage): void {
        if (this.active?.id !== chat.id) {
            return;
        }
        this.pendingDeltas.set(message.id, message);
        if (!this.deltaTimer) {
            this.deltaTimer = setTimeout(() => this.flushDeltas(), 40);
        }
    }

    private clearPendingDeltas(): void {
        if (this.deltaTimer) {
            clearTimeout(this.deltaTimer);
            this.deltaTimer = undefined;
        }
        this.pendingDeltas.clear();
    }

    private flushDeltas(): void {
        this.deltaTimer = undefined;
        for (const message of this.pendingDeltas.values()) {
            this.post({ type: "delta", message });
        }
        this.pendingDeltas.clear();
    }

    private scheduleSave(chat: ChatRecord): void {
        if (this.deletedIds.has(chat.id)) {
            return;
        }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveChat = chat;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            const target = this.saveChat;
            this.saveChat = undefined;
            if (target && !this.deletedIds.has(target.id)) {
                void this.store.save(target);
            }
        }, 400);
    }

    private async flushSave(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        const pending = this.saveChat;
        this.saveChat = undefined;
        if (pending && !this.deletedIds.has(pending.id)) {
            await this.store.save(pending);
        }
        if (this.active && this.active.id !== pending?.id && !this.deletedIds.has(this.active.id)) {
            await this.store.save(this.active);
        }
    }

    private stopProcess(): void {
        const current = this.connection;
        this.connection = undefined;
        this.initialized = false;
        this.activeSessionId = undefined;
        this.cancelAllElicitations();
        this.tools.dispose();
        current?.dispose();
    }

    private requireConnection(): AcpConnection {
        if (!this.connection) {
            throw new Error("反重力尚未连接");
        }
        return this.connection;
    }

    private markAuthenticated(): void {
        this.hasAuthenticatedInSession = true;
        if (!this.hasEverAuthenticated) {
            this.hasEverAuthenticated = true;
            void this.context.globalState.update(AUTH_CONFIRMED_KEY, true);
        }
    }

    private handleAuthFailure(): void {
        if (this.hasAuthenticatedInSession) {
            this.status = "error";
            this.statusText = "登录状态暂时异常，请在设置中重连或重新登录";
            this.pushStatus();
            return;
        }
        if (this.hasEverAuthenticated) {
            this.hasEverAuthenticated = false;
            void this.context.globalState.update(AUTH_CONFIRMED_KEY, false);
        }
        this.status = "auth";
        this.statusText = "需要登录反重力";
        this.ensureFallbackAuth();
        this.pushStatus();
    }

    private ensureFallbackAuth(): void {
        if (this.authMethods.length) {
            return;
        }
        this.authMethods = [{ id: "oauth-personal", name: "Log in with Google" }];
    }

    private activeUsageText(): string {
        const stats = this.active?.tokenStats;
        if (!stats) {
            return "";
        }
        if (stats.contextSize > 0) {
            return formatUsage(stats.contextUsed, stats.contextSize);
        }
        if (stats.total.totalTokens > 0) {
            return `${formatTokenCount(stats.total.totalTokens)} tok`;
        }
        return "";
    }

    private recordContextUsage(chat: ChatRecord, used: number, size: number): void {
        const stats = ensureChatTokenStats(chat);
        stats.contextUsed = Math.max(0, Math.round(used));
        stats.contextSize = Math.max(0, Math.round(size));
        stats.updatedAt = Date.now();
        this.scheduleSave(chat);
    }

    private recordTurnUsage(chat: ChatRecord, turnUsage: TokenUsage): void {
        const stats = ensureChatTokenStats(chat);
        stats.total = mergeTokenUsage(stats.total, turnUsage);
        stats.lastTurn = turnUsage;
        stats.turns += 1;
        if (stats.contextUsed === 0 && turnUsage.totalTokens > 0) {
            stats.contextUsed = turnUsage.totalTokens;
        }
        stats.updatedAt = Date.now();
        if (this.status === "ready" && this.active?.id === chat.id) {
            this.statusText = this.readyLabel();
        }
        this.scheduleSave(chat);
        this.pushStatus();
    }

    private loadCachedQuota(): QuotaStateView {
        const raw = asRecord(this.context.globalState.get(CACHED_QUOTA_KEY));
        const fetchedAt = typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : undefined;
        const description = typeof raw.description === "string" && raw.description ? raw.description : undefined;
        const remainingCredits = typeof raw.remainingCredits === "number" && Number.isFinite(raw.remainingCredits)
            ? raw.remainingCredits
            : undefined;
        const upgradeUri = typeof raw.upgradeUri === "string" && raw.upgradeUri ? raw.upgradeUri : undefined;
        const rawTier = asRecord(raw.tier);
        const tier: AccountTierView | undefined = typeof rawTier.name === "string" && rawTier.name
            ? {
                id: typeof rawTier.id === "string" ? rawTier.id : "",
                name: rawTier.name,
                upgradeUri: typeof rawTier.upgradeUri === "string" && rawTier.upgradeUri ? rawTier.upgradeUri : undefined,
            }
            : undefined;
        const groups: QuotaGroupView[] = [];
        if (Array.isArray(raw.groups)) {
            for (const entry of raw.groups) {
                const g = asRecord(entry);
                const name = typeof g.name === "string" ? g.name : "";
                if (!name) {
                    continue;
                }
                const buckets: QuotaBucketView[] = [];
                if (Array.isArray(g.buckets)) {
                    for (const bEntry of g.buckets) {
                        const b = asRecord(bEntry);
                        const bName = typeof b.name === "string" ? b.name : "";
                        const bId = typeof b.id === "string" ? b.id : bName;
                        const remainingFraction = typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)
                            ? Math.min(1, Math.max(0, b.remainingFraction))
                            : 0;
                        if (!bName && !bId) {
                            continue;
                        }
                        buckets.push({
                            id: bId || bName,
                            name: bName || bId,
                            window: typeof b.window === "string" ? b.window : "",
                            remainingFraction,
                            resetTime: typeof b.resetTime === "string" && b.resetTime ? b.resetTime : undefined,
                            description: typeof b.description === "string" && b.description ? b.description : undefined,
                        });
                    }
                }
                groups.push({
                    name,
                    description: typeof g.description === "string" && g.description ? g.description : undefined,
                    buckets,
                });
            }
        }
        return {
            loading: false,
            fetchedAt,
            tier,
            description,
            groups,
            remainingCredits,
            upgradeUri,
        };
    }

    private saveCachedQuota(): void {
        if (!this.quota.fetchedAt && !this.quota.groups.length && !this.quota.tier) {
            return;
        }
        void this.context.globalState.update(CACHED_QUOTA_KEY, {
            fetchedAt: this.quota.fetchedAt,
            tier: this.quota.tier,
            description: this.quota.description,
            groups: this.quota.groups,
            remainingCredits: this.quota.remainingCredits,
            upgradeUri: this.quota.upgradeUri,
        });
    }

    private scheduleInitialQuotaWarmup(): void {
        if (
            this.disposed
            || this.initialQuotaWarmed
            || this.quota.fetchedAt
            || this.quota.groups.length
            || this.quotaPromise
            || this.status !== "ready"
        ) {
            return;
        }
        this.initialQuotaWarmed = true;
        this.quotaWarmTimer = setTimeout(() => {
            this.quotaWarmTimer = undefined;
            if (!this.disposed && this.status === "ready" && !this.quota.fetchedAt && !this.quotaPromise) {
                void this.refreshQuota(false);
            }
        }, 2000);
    }

    private async refreshQuota(force = false): Promise<void> {
        if (this.quotaPromise) {
            await this.quotaPromise;
            return;
        }
        if (!force && (this.quota.fetchedAt || this.quota.groups.length) && !this.quota.error) {
            return;
        }
        if (this.status === "auth") {
            this.quota = {
                ...this.quota,
                loading: false,
                error: "请先登录反重力后再查看剩余用量",
            };
            this.pushStatus();
            return;
        }
        const run = this.runQuotaFetch().finally(() => {
            this.quotaPromise = undefined;
        });
        this.quotaPromise = run;
        await run;
    }

    private enqueueQuotaCli<T>(task: () => Promise<T>): Promise<T> {
        const run = this.quotaCliChain.then(task, task);
        this.quotaCliChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async runQuotaFetch(): Promise<void> {
        this.quota = {
            ...this.quota,
            loading: true,
            error: undefined,
        };
        this.pushStatus();
        try {
            const network = this.network();
            let binary = this.settings.binaryPath || this.runtimeBinary;
            if (!binary) {
                const info = await this.runtime.ensure({
                    proxy: network.proxy,
                    noProxy: network.noProxy,
                    binaryPath: this.settings.binaryPath,
                });
                binary = info.binary;
                this.runtimeBinary = info.binary;
                this.runtimeLabel = info.managed ? `内置 ${info.version}` : "自定义路径";
            }
            const apiKey = await this.context.secrets.get(API_KEY_SECRET) || await this.context.secrets.get(LEGACY_API_KEY_SECRET);
            const cwd = workspaceCwd();
            const env = agentEnv(this.settings, apiKey);
            const usage = await this.enqueueQuotaCli(() => fetchUsageQuota({ binary, cwd, env }));
            if (this.disposed) {
                return;
            }
            const fetchedAt = Date.now();
            this.quota = {
                ...this.quota,
                loading: false,
                fetchedAt,
                error: undefined,
                description: usage.description,
                groups: usage.groups,
                upgradeUri: this.quota.upgradeUri ?? this.quota.tier?.upgradeUri,
            };
            this.saveCachedQuota();
            this.pushStatus();
            void this.enqueueQuotaCli(() => fetchCreditsQuota({ binary, cwd, env }).catch(() => undefined))
                .then((credits) => {
                    if (!credits || this.disposed || this.quota.fetchedAt !== fetchedAt) {
                        return;
                    }
                    if (credits.remainingCredits === undefined && !credits.upgradeUri) {
                        return;
                    }
                    this.quota = {
                        ...this.quota,
                        remainingCredits: credits.remainingCredits ?? this.quota.remainingCredits,
                        upgradeUri: credits.upgradeUri ?? this.quota.upgradeUri,
                    };
                    this.saveCachedQuota();
                    this.pushStatus();
                });
        } catch (error) {
            if (this.disposed) {
                return;
            }
            const message = withNetworkHint(error);
            this.quota = {
                ...this.quota,
                loading: false,
                error: message,
            };
            this.output.appendLine(`查询剩余用量失败：${message}`);
            this.pushStatus();
        }
    }

    private readyLabel(): string {
        const skip = this.isSkipPermissions() ? "跳过权限" : "";
        return [this.runtimeLabel, skip, this.proxyLabel()].filter(Boolean).join(" · ");
    }

    private network(): { proxy: string; noProxy: string } {
        return resolveProxy(this.settings.proxy, process.env, this.settings.noProxy);
    }

    private proxyLabel(): string {
        const { proxy } = this.network();
        if (!proxy) {
            return "";
        }
        const short = redactProxy(proxy).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
        return `代理 ${short}`;
    }

    private retitle(chat: ChatRecord, outgoing: Outgoing): void {
        if (chat.imported || (chat.title !== "新对话" && chat.title !== "未命名对话")) {
            return;
        }
        chat.title = titleFrom(outgoing.text || outgoing.attachments[0]?.fileName || "选中内容");
    }

    private async openLink(href: string): Promise<void> {
        if (/^https?:\/\//i.test(href)) {
            await vscode.env.openExternal(vscode.Uri.parse(href));
            return;
        }
        if (/^file:\/\//i.test(href)) {
            try {
                const parsed = vscode.Uri.parse(href);
                const lineMatch = /^L(\d+)(?:-L?\d+)?$/i.exec(parsed.fragment || "");
                const cleanUri = parsed.with({ fragment: "" });
                const doc = await vscode.workspace.openTextDocument(cleanUri);
                const editor = await vscode.window.showTextDocument(doc, { preview: true });
                if (lineMatch) {
                    const line = Math.max(0, Number.parseInt(lineMatch[1], 10) - 1);
                    const pos = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            } catch {
                // Ignore broken local links
            }
            return;
        }
        if (href.trim()) {
            await this.openFile(href);
        }
    }

    private async openFile(rawPath: string, rawLine?: number): Promise<void> {
        const trimmed = rawPath.trim();
        if (!trimmed) {
            return;
        }
        if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
            await this.openLink(trimmed);
            return;
        }
        let target = trimmed.replace(/^\/([A-Za-z]:[\\/])/, "$1");
        let lineNum = typeof rawLine === "number" && rawLine > 0 ? Math.floor(rawLine) : undefined;
        const suffixMatch = /^(.*?):(\d+)(?:-\d+)?(?::\d+)?$/.exec(target) || /^(.*?)#L(\d+)(?:-L?\d+)?$/i.exec(target);
        if (suffixMatch && suffixMatch[1] && !/^[A-Za-z]$/.test(suffixMatch[1])) {
            target = suffixMatch[1];
            if (!lineNum) {
                lineNum = Number.parseInt(suffixMatch[2], 10);
            }
        }

        const resolvedUri = await this.resolveLocalFileUri(target);
        if (!resolvedUri) {
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(resolvedUri);
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            if (lineNum && lineNum > 0) {
                const lineIndex = Math.min(Math.max(0, lineNum - 1), Math.max(0, doc.lineCount - 1));
                const pos = new vscode.Position(lineIndex, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        } catch {
            // Ignore unreadable or binary files if openTextDocument rejects
        }
    }

    private async revealPath(rawPath: string): Promise<void> {
        const trimmed = rawPath.trim().replace(/^\/([A-Za-z]:[\\/])/, "$1");
        if (!trimmed) {
            return;
        }
        const uri = /^file:\/\//i.test(trimmed)
            ? vscode.Uri.parse(trimmed)
            : await this.resolveLocalEntryUri(trimmed, true);
        if (!uri) {
            return;
        }
        try {
            await vscode.commands.executeCommand("revealInExplorer", uri);
        } catch {
            // Ignore if explorer reveal fails
        }
    }

    private async resolveLocalFileUri(target: string): Promise<vscode.Uri | undefined> {
        return this.resolveLocalEntryUri(target, false);
    }

    private async resolveLocalEntryUri(target: string, allowDirectory: boolean): Promise<vscode.Uri | undefined> {
        const candidates: string[] = [];
        const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");
        if (path.isAbsolute(target)) {
            candidates.push(target);
        }
        for (const root of workspacePaths()) {
            candidates.push(path.resolve(root, target));
            const rootName = path.basename(root);
            if (rootName && normalized.startsWith(`${rootName}/`)) {
                candidates.push(path.resolve(root, normalized.slice(rootName.length + 1)));
            }
        }
        for (const candidate of candidates) {
            try {
                const stat = await fs.stat(candidate);
                if (stat.isFile() || (allowDirectory && stat.isDirectory())) {
                    return vscode.Uri.file(candidate);
                }
            } catch {
                // Continue probing next candidate
            }
        }
        if (allowDirectory) {
            return undefined;
        }
        const cleanPattern = normalized.replace(/^\/+/, "");
        if (cleanPattern && !cleanPattern.includes("..")) {
            try {
                const matches = await vscode.workspace.findFiles(cleanPattern, "**/node_modules/**", 1);
                if (matches.length) {
                    return matches[0];
                }
                if (!cleanPattern.includes("/")) {
                    const deep = await vscode.workspace.findFiles(`**/${cleanPattern}`, "**/node_modules/**", 1);
                    if (deep.length) {
                        return deep[0];
                    }
                }
            } catch {
                // Ignore invalid glob patterns
            }
        }
        return undefined;
    }

    private viewState(): ViewState {
        const chat = this.active;
        const skip = this.isSkipPermissions();
        const modes = this.modes.length
            ? [
                ...this.modes,
                {
                    id: SKIP_PERMISSIONS_MODE_ID,
                    name: "跳过权限",
                    description: "启用 --dangerously-skip-permissions，自动批准所有工具、编辑与命令",
                },
            ]
            : [];
        const cfg = vscode.workspace.getConfiguration("magy");
        const explicitProxy = normalizeProxy(String(cfg.get("proxy", "") ?? ""));
        return {
            chats: this.store.list(),
            activeId: chat?.id ?? "",
            messages: chat?.messages ?? [],
            attachments: this.draft,
            status: this.status,
            statusText: this.statusText,
            runtimeLabel: this.runtimeLabel,
            proxy: this.proxyLabel(),
            proxyUrl: this.network().proxy,
            usageText: this.activeUsageText(),
            busy: this.busy,
            modes,
            currentModeId: skip && modes.length ? SKIP_PERMISSIONS_MODE_ID : this.currentModeId,
            options: this.options,
            authMethods: this.authMethods,
            permission: this.permission,
            elicitation: this.elicitationQueue[0]?.view,
            commands: withBuiltinCommands(this.commands),
            tokenStats: chat?.tokenStats,
            quota: this.quota,
            settings: {
                proxy: explicitProxy,
                effectiveProxy: this.network().proxy,
                noProxy: this.settings.noProxy,
                dangerouslySkipPermissions: this.settings.dangerouslySkipPermissions,
                sandbox: this.settings.sandbox,
                binaryPath: this.settings.binaryPath,
                cursorDataDir: this.settings.cursorDataDir,
                fontSize: this.settings.fontSize,
            },
        };
    }

    private syncViewTitle(): void {
        if (!this.view) {
            return;
        }
        const title = this.active?.title?.trim() || "新对话";
        if (this.view.title !== title) {
            this.view.title = title;
        }
    }

    private postSnapshot(): void {
        this.syncViewTitle();
        this.flushDeltas();
        this.post({ type: "snapshot", state: this.viewState() });
    }

    private pushStatus(): void {
        this.syncViewTitle();
        const state = this.viewState();
        this.post({
            type: "status",
            state: {
                ...state,
                messages: [],
            },
        });
    }

    private post(message: HostMessage): void {
        void this.webview?.postMessage(message);
    }

    private async focus(): Promise<void> {
        try {
            await vscode.commands.executeCommand("magy.chat.focus");
        } catch (error) {
            this.output.appendLine(withNetworkHint(error));
        }
    }

    private fail(message: string): void {
        if (this.disposed) {
            return;
        }
        const target = this.streamingChatId ? (this.store.peek(this.streamingChatId) ?? this.active) : this.active;
        if (target) {
            this.finalizeActiveMessages(target, "failed");
            this.scheduleSave(target);
        }
        this.busy = false;
        this.awaitingIdle = false;
        this.streamingChatId = undefined;
        this.queue.length = 0;
        this.status = "error";
        this.statusText = message;
        this.permission = undefined;
        this.cancelAllElicitations();
        this.ensureFallbackAuth();
        this.pushStatus();
        this.output.appendLine(message);
    }
}

function pickAutoApproveOption(options: unknown[]): string | null {
    const list = options.map((item) => {
        const record = asRecord(item);
        return {
            id: String(record.optionId ?? record.id ?? ""),
            kind: String(record.kind ?? ""),
        };
    }).filter((item) => item.id);
    if (!list.length) {
        return null;
    }
    const allowAlways = list.find((item) => item.kind === "allow_always");
    if (allowAlways) {
        return allowAlways.id;
    }
    const allowOnce = list.find((item) => item.kind === "allow_once");
    if (allowOnce) {
        return allowOnce.id;
    }
    const nonReject = list.find((item) => !/reject|deny|cancel/i.test(item.kind) && !/reject|deny|cancel/i.test(item.id));
    return (nonReject ?? list[0]).id;
}

function googleOnly(methods: AuthMethodView[]): AuthMethodView[] {
    const google = methods.find((method) => method.id === "oauth-personal" || /google/i.test(method.name));
    return google ? [google] : [];
}

function fromTranscript(message: TranscriptMessage): StoredMessage {
    return blankMessage(message.role, message.text, { title: message.title, imported: true });
}

function userMessage(outgoing: Outgoing): StoredMessage {
    return blankMessage("user", outgoing.text, {
        attachments: outgoing.attachments.length ? outgoing.attachments : undefined,
    });
}

function attachmentKey(attachment: CodeAttachment): string {
    return `${attachment.kind ?? "selection"}:${attachment.relativePath}:${attachment.startLine}:${attachment.endLine}:${attachment.text}`;
}

function toTranscript(message: StoredMessage): TranscriptMessage {
    return { role: message.role, text: message.text, title: message.title };
}

function toolBody(update: Record<string, unknown>, diffs?: ToolDiff[]): { text: string; hasBody: boolean; exitCode?: number } {
    const parts: string[] = [];
    let exitCode: number | undefined;
    const content = contentTextWithoutDiff(update.content).trim();
    if (content) {
        parts.push(content);
    }
    if (!content && !diffs?.length && Array.isArray(update.locations)) {
        const paths = update.locations.map((item) => asRecord(item).path).filter((item): item is string => typeof item === "string");
        if (paths.length) {
            parts.push(paths.map(toDisplayPath).join("\n"));
        }
    }
    if (!content && !diffs?.length && update.rawInput) {
        const cmdLine = extractCommandInput(update.rawInput);
        if (cmdLine) {
            parts.push(`$ ${cmdLine}`);
        } else {
            parts.push(clip(JSON.stringify(update.rawInput, null, 2), 1500));
        }
    }
    if (update.rawOutput !== undefined) {
        const extracted = unwrapRawOutput(update.rawOutput);
        if (extracted.exitCode !== undefined) {
            exitCode = extracted.exitCode;
        }
        if (extracted.text) {
            const joined = parts.join("\n");
            if (!joined.includes(extracted.text)) {
                parts.push(clip(extracted.text, 4000));
            }
        }
    }
    return { text: parts.join("\n"), hasBody: parts.length > 0 || Boolean(diffs?.length), exitCode };
}

function extractCommandInput(rawInput: unknown): string {
    const input = asRecord(rawInput);
    for (const key of ["CommandLine", "commandLine", "command", "cmd", "script"]) {
        const value = input[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}

function unwrapRawOutput(rawOutput: unknown): { text: string; exitCode?: number } {
    if (rawOutput === undefined || rawOutput === null) {
        return { text: "" };
    }
    let obj: Record<string, unknown> | undefined;
    if (typeof rawOutput === "string") {
        const trimmed = rawOutput.trim();
        if (!trimmed || trimmed === "undefined") {
            return { text: "" };
        }
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    obj = parsed as Record<string, unknown>;
                }
            } catch {
                // Keep raw string
            }
        }
        if (!obj) {
            return { text: rawOutput.replace(/\r\n/g, "\n").trimEnd() };
        }
    } else if (typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
        obj = rawOutput as Record<string, unknown>;
    }
    if (obj) {
        const exitRaw = obj.exitCode ?? obj.exit_code ?? obj.code;
        const exitCode = typeof exitRaw === "number" && Number.isFinite(exitRaw) ? exitRaw : undefined;
        const chunks: string[] = [];
        for (const key of ["stdout", "output", "content", "text", "result"]) {
            const val = obj[key];
            if (typeof val === "string" && val.trim()) {
                chunks.push(val.replace(/\r\n/g, "\n").trimEnd());
            }
        }
        if (typeof obj.stderr === "string" && obj.stderr.trim()) {
            chunks.push(obj.stderr.replace(/\r\n/g, "\n").trimEnd());
        }
        if (chunks.length) {
            return { text: chunks.join("\n"), exitCode };
        }
        if (Object.keys(obj).every((k) => k === "exitCode" || k === "exit_code" || k === "code")) {
            return { text: "", exitCode };
        }
    }
    const serialized = JSON.stringify(rawOutput, null, 2);
    return { text: serialized && serialized !== "undefined" ? serialized : "" };
}

function contentTextWithoutDiff(content: unknown): string {
    if (Array.isArray(content)) {
        return content.filter((item) => asRecord(item).type !== "diff").map((item) => contentText(item)).join("");
    }
    if (asRecord(content).type === "diff") {
        return "";
    }
    return contentText(content);
}

function toDisplayPath(raw: string): string {
    const cleaned = raw.replace(/^\/([A-Za-z]:[\\/])/, "$1");
    const roots = workspacePaths();
    for (const root of roots) {
        const rel = path.relative(path.resolve(root), path.resolve(cleaned));
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
            return rel.replace(/\\/g, "/");
        }
    }
    return cleaned.replace(/\\/g, "/");
}

function inferToolKind(
    update: Record<string, unknown>,
    existingKind: string | undefined,
    rawTitle: string | undefined,
    diffs: ToolDiff[] | undefined,
    text: string,
): string {
    if (typeof update.kind === "string" && update.kind && update.kind !== "other") {
        return update.kind;
    }
    if (diffs?.length) {
        return "edit";
    }
    if (existingKind && existingKind !== "other") {
        return existingKind;
    }
    const title = rawTitle || "";
    if (/^File\s+/i.test(title) || /^Read\b/i.test(title)) {
        return "read";
    }
    if (/^(Glob|Grep|Find|Search)\b/i.test(title)) {
        return "search";
    }
    if (/^(Shell|Bash|PowerShell|Command|Run\s+command)\b/i.test(title) || /^Created At:/m.test(text) || /^Command exited/m.test(text)) {
        return "execute";
    }
    if (typeof update.kind === "string" && update.kind) {
        return update.kind;
    }
    return "tool";
}

function formatToolSummary(
    kind: string,
    rawTitle: string,
    rawInput: unknown,
    diffs: ToolDiff[] | undefined,
    bodyText: string,
    existing?: StoredMessage,
    rawExitCode?: number,
): { title: string; detail?: string; text: string; filePath?: string; line?: number } {
    const input = asRecord(rawInput);
    if (kind === "edit" && diffs?.length) {
        const first = diffs[0];
        const name = path.basename(first.path) || first.path;
        const extra = diffs.length > 1 ? ` 等 ${diffs.length} 个文件` : "";
        let add = 0;
        let del = 0;
        for (const d of diffs) {
            const counts = countDiffLines(d.oldText, d.newText);
            add += counts.add;
            del += counts.del;
        }
        const stat = (add || del) ? `+${add} -${del}` : undefined;
        return {
            title: `编辑 ${name}${extra}`,
            detail: stat || toDisplayPath(first.path),
            text: bodyText,
            filePath: toDisplayPath(first.path),
        };
    }

    if (kind === "read") {
        const fileMatch = /^File\s+(.+)$/i.exec(rawTitle);
        const pathCandidate = fileMatch?.[1] || (typeof input.Path === "string" ? input.Path : "") || (typeof input.path === "string" ? input.path : "");
        if (pathCandidate) {
            const rel = toDisplayPath(pathCandidate);
            const name = path.basename(rel) || rel;
            const startLine = Number(input.StartLine ?? input.startLine ?? input.line ?? 0);
            const endLine = Number(input.EndLine ?? input.endLine ?? 0);
            const range = startLine && endLine ? `:${startLine}-${endLine}` : startLine ? `:${startLine}` : "";
            const stripped = stripRedundantPathJson(bodyText, pathCandidate);
            return {
                title: `读取 ${name}${range}`,
                detail: rel !== name ? rel : (existing?.detail || undefined),
                text: stripped,
                filePath: rel,
                line: startLine > 0 ? startLine : undefined,
            };
        }
    }

    if (kind === "execute") {
        const cleanedRawTitle = rawTitle.replace(/^Run\s+command\s+/i, "").trim();
        const inputCmd = extractCommandInput(rawInput);
        const cmd = inputCmd || (cleanedRawTitle && !/^运行命令|^执行命令/.test(cleanedRawTitle)
            ? cleanedRawTitle
            : (existing?.title && !/^运行命令|^执行命令/.test(existing.title) ? existing.title : ""));
        const parsed = parseCommandOutput(bodyText);
        const exitCode = parsed.exitCode ?? rawExitCode;
        const compactCmd = cmd.replace(/\s+/g, " ").trim();
        const detailParts: string[] = [];
        if (exitCode !== undefined) {
            detailParts.push(`退出 ${exitCode}`);
        }
        if (parsed.durationSec !== undefined) {
            detailParts.push(`${parsed.durationSec}s`);
        }
        let cleanBody = bodyText;
        if (parsed.output !== undefined) {
            cleanBody = cmd ? `$ ${cmd}\n\n${parsed.output}` : parsed.output;
        } else if (cmd && bodyText && !bodyText.startsWith("$ ")) {
            cleanBody = `$ ${cmd}\n\n${bodyText}`;
        } else if (cmd && !bodyText) {
            cleanBody = `$ ${cmd}`;
        }
        return {
            title: compactCmd || "运行命令",
            detail: detailParts.length ? detailParts.join(" · ") : undefined,
            text: cleanBody,
        };
    }

    return {
        title: /^ask_question$/i.test(rawTitle) ? "交互式问答" : rawTitle,
        detail: existing?.detail,
        text: bodyText,
    };
}

function stripRedundantPathJson(text: string, pathCandidate: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return "";
    }
    const lines = trimmed.split(/\r?\n/);
    const first = lines[0]?.trim() || "";
    const rest = lines.slice(1).join("\n").trim();
    const jsonCandidate = first === pathCandidate || first.startsWith("/") ? rest : trimmed;
    if (jsonCandidate.startsWith("{") && jsonCandidate.endsWith("}")) {
        try {
            const parsed = asRecord(JSON.parse(jsonCandidate));
            const keys = Object.keys(parsed);
            if (keys.length && keys.every((k) => k === "Path" || k === "StartLine" || k === "EndLine" || k === "path" || k === "line" || k === "limit")) {
                return "";
            }
        } catch {
            // Keep original text if not simple metadata JSON
        }
    }
    return text;
}

function parseCommandOutput(text: string): { exitCode?: number; durationSec?: string; output?: string } {
    if (!text) {
        return {};
    }
    const createdMatch = /^Created At:\s*(.+)$/m.exec(text);
    const completedMatch = /^Completed At:\s*(.+)$/m.exec(text);
    const exitMatch = /^Command exited with code (-?\d+)\.?$/m.exec(text);
    const outMarker = /\r?\nCommand output:\r?\n([\s\S]*)$/.exec(text);
    if (!createdMatch && !completedMatch && !exitMatch && !outMarker) {
        return {};
    }
    let durationSec: string | undefined;
    if (createdMatch && completedMatch) {
        const start = Date.parse(createdMatch[1].trim());
        const end = Date.parse(completedMatch[1].trim());
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            const sec = (end - start) / 1000;
            durationSec = sec < 10 ? sec.toFixed(1) : String(Math.round(sec));
        }
    }
    const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
    const output = outMarker ? outMarker[1].replace(/^\r?\n+/, "").trimEnd() : "";
    return { exitCode, durationSec, output };
}

function ensureChatTokenStats(chat: ChatRecord): ChatTokenStats {
    if (!chat.tokenStats) {
        chat.tokenStats = {
            contextUsed: 0,
            contextSize: 0,
            total: emptyTokenUsage(),
            turns: 0,
        };
    }
    return chat.tokenStats;
}

function withBuiltinCommands(commands: CommandView[]): CommandView[] {
    if (commands.some((item) => item.name.toLowerCase() === "usage")) {
        return commands;
    }
    return [...commands, BUILTIN_USAGE_COMMAND];
}

function formatTokenCount(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (n >= 100_000) {
        return `${Math.round(n / 1_000)}k`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return String(Math.max(0, Math.round(n)));
}

function formatUsage(used: number, size: number): string {
    const pct = Math.min(100, Math.round((used / size) * 100));
    return `${formatTokenCount(used)}/${formatTokenCount(size)} (${pct}%)`;
}

function stopLabel(stopReason: string): string {
    switch (stopReason) {
        case "cancelled":
            return "已取消";
        case "max_tokens":
            return "达到输出长度上限";
        case "max_requests":
        case "max_turn_requests":
            return "达到请求次数上限";
        case "refusal":
            return "模型拒绝了该请求";
        default:
            return "";
    }
}

function formatTime(value: number): string {
    if (!value) {
        return "";
    }
    return new Date(value).toLocaleString();
}

function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = randomUUID().replace(/-/g, "");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview", "ui.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat-ui.css"));
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}' ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}?v=${Date.now()}">
<title>MAGY</title>
</head>
<body>
<header class="bar">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span class="brand-name">MAGY</span>
  </div>
  <div class="bar-actions">
    <button id="history" class="tool" type="button" title="历史对话"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5.81836 6.72729V14H13.0911" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 24C4 35.0457 12.9543 44 24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C16.598 4 10.1351 8.02111 6.67677 13.9981" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.005 12L24.0038 24.0088L32.4832 32.4882" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>历史</span></button>
    <button id="import" class="tool" type="button" title="引入 Cursor 对话"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 30L10 6H38L43 30" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 30H14.9091L16.7273 36H31.2727L33.0909 30H43V43H5V30Z" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/><path d="M18 20L24 26L30 20" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 26V14" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>引入</span></button>
    <button id="create" class="tool" type="button" title="新对话"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24.0605 10L24.0239 38" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 24L38 24" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>新建</span></button>
    <button id="usage" class="tool" type="button" title="剩余用量与 Token 统计"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M6 42H42" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="10" y="24" width="6" height="12" rx="1" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/><rect x="21" y="14" width="6" height="22" rx="1" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/><rect x="32" y="8" width="6" height="28" rx="1" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/></svg><span>用量</span></button>
    <button id="settings" class="tool" type="button" title="设置"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/><path d="M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/></svg><span>设置</span></button>
  </div>
</header>
<div id="history-panel" hidden></div>
<div id="settings-panel" hidden></div>
<div id="usage-panel" hidden></div>
<main id="messages"></main>
<button id="scroll-bottom" class="scroll-bottom" type="button" hidden title="回到底部" aria-label="回到底部"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 10V36" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 25L24 37L36 25" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<footer>
  <div id="elicitation" class="card" hidden></div>
  <div id="permission" class="card" hidden></div>
  <div id="auth" class="card" hidden></div>
  <div id="slash" hidden></div>
  <div class="composer">
    <div id="chips" class="chips" hidden></div>
    <textarea id="input" rows="2" placeholder="输入任务，Enter 发送"></textarea>
    <div class="composer-bar">
      <div id="selectors"></div>
      <button id="send" type="button">发送</button>
    </div>
  </div>
  <div id="status-row" class="status-row">
    <button id="statusline" class="status" type="button" data-state="connecting">等待连接</button>
    <button id="usage-pill" class="usage-pill" type="button" hidden></button>
  </div>
</footer>
<script nonce="${nonce}" src="${script}?v=${Date.now()}"></script>
</body>
</html>`;
}
