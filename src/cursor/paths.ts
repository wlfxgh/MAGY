import * as os from "node:os";
import * as path from "node:path";

export function cursorProjectKey(fsPath: string, replaceUnderscore = true): string {
    let normalized = fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const drive = /^([A-Za-z]):(.*)$/.exec(normalized);
    if (drive) {
        normalized = `${drive[1].toLowerCase()}${drive[2]}`;
    }
    if (normalized.startsWith("/")) {
        normalized = normalized.slice(1);
    }
    return normalized.replace(replaceUnderscore ? /[/_]/g : /\//g, "-");
}

export function cursorProjectKeys(fsPath: string): string[] {
    const primary = cursorProjectKey(fsPath, true);
    const secondary = cursorProjectKey(fsPath, false);
    return primary === secondary ? [primary] : [primary, secondary];
}

export function defaultCursorUserDir(): string {
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appData, "Cursor", "User");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
    }
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configHome, "Cursor", "User");
}

export function defaultCursorProjectsDir(): string {
    const root = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor");
    return path.join(root, "projects");
}

export function pathsEqual(left: string, right: string): boolean {
    const normalize = (value: string) => path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return normalize(left) === normalize(right);
}
