import * as path from "node:path";
import * as vscode from "vscode";
import { AgyRuntime } from "./agent/runtime";
import { ChatController } from "./chat/controller";
import { ChatStore } from "./chat/store";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel("MAGY");
    const storage = context.storageUri ?? context.globalStorageUri;
    const store = new ChatStore(path.join(storage.fsPath, "chats"));
    await store.load();
    const runtime = new AgyRuntime(path.join(context.globalStorageUri.fsPath, "runtime"), (line) => output.appendLine(line));
    const controller = new ChatController(context, output, store, runtime);
    const provider: vscode.WebviewViewProvider = {
        resolveWebviewView(webviewView) {
            controller.attach(webviewView, context.extensionUri);
            webviewView.onDidDispose(() => controller.detach(webviewView.webview));
        },
    };
    context.subscriptions.push(
        output,
        controller,
        vscode.window.registerWebviewViewProvider("magy.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand("magy.focus", () => vscode.commands.executeCommand("magy.chat.focus")),
        vscode.commands.registerCommand("magy.showHistory", () => controller.toggleHistory()),
        vscode.commands.registerCommand("magy.newChat", () => controller.newChat()),
        vscode.commands.registerCommand("magy.importCursorChat", () => controller.importCursor()),
        vscode.commands.registerCommand("magy.addSelection", () => controller.addSelection()),
        vscode.commands.registerCommand("magy.addPath", (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            const targets = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
            return controller.addPaths(targets);
        }),
        vscode.commands.registerCommand("magy.installRuntime", () => controller.installRuntime()),
        vscode.commands.registerCommand("magy.setApiKey", () => controller.setApiKey()),
        vscode.commands.registerCommand("magy.toggleSkipPermissions", () => controller.toggleSkipPermissions()),
        vscode.commands.registerCommand("magy.openSettings", () => controller.toggleSettings()),
        vscode.commands.registerCommand("magy.showUsage", () => controller.toggleUsage()),
        vscode.commands.registerCommand("magy.moveView", async () => {
            await vscode.commands.executeCommand("magy.chat.focus");
            try {
                await vscode.commands.executeCommand("workbench.action.moveFocusedView", "magy.chat");
            } catch {
                await vscode.commands.executeCommand("workbench.action.moveView");
            }
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("magy") || event.affectsConfiguration("agy") || event.affectsConfiguration("http.proxy") || event.affectsConfiguration("http.proxySupport") || event.affectsConfiguration("http.noProxy")) {
                controller.onSettingsChanged();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => controller.onWorkspaceFoldersChanged()),
    );
}

export function deactivate(): void {}
