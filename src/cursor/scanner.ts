import * as path from "node:path";
import { Worker } from "node:worker_threads";
import {
    discoverCursorConversations,
    loadCursorConversation,
    type CursorConversationSummary,
    type DiscoverOptions,
    type DiscoverResult,
} from "./discover";
import type { TranscriptMessage } from "./parse";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface WorkerResponse {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
}

const IDLE_TIMEOUT_MS = 30_000;

/** Runs read-only Cursor SQLite/transcript scans on a background worker thread. */
export class CursorScanner {
    private worker: Worker | undefined;
    private workerDisabled = false;
    private disposed = false;
    private nextId = 1;
    private idleTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pending = new Map<number, PendingRequest>();

    async discover(options: DiscoverOptions): Promise<DiscoverResult> {
        if (!this.disposed && !this.workerDisabled) {
            try {
                return await this.request<DiscoverResult>({ action: "discover", options });
            } catch (error) {
                if (this.disposed) {
                    throw error;
                }
            }
        }
        return discoverCursorConversations(options);
    }

    async load(summary: CursorConversationSummary, userDir?: string): Promise<{ title: string; messages: TranscriptMessage[] }> {
        if (!this.disposed && !this.workerDisabled) {
            try {
                return await this.request<{ title: string; messages: TranscriptMessage[] }>({
                    action: "load",
                    summary,
                    userDir,
                });
            } catch (error) {
                if (this.disposed) {
                    throw error;
                }
            }
        }
        return loadCursorConversation(summary, userDir);
    }

    dispose(): void {
        this.disposed = true;
        this.clearIdleTimer();
        this.rejectAll(new Error("扫描器已释放"));
        this.terminateWorker();
    }

    private request<T>(payload: { action: "discover"; options: DiscoverOptions } | { action: "load"; summary: CursorConversationSummary; userDir?: string }): Promise<T> {
        this.clearIdleTimer();
        const worker = this.ensureWorker();
        const id = this.nextId;
        this.nextId += 1;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
            });
            try {
                worker.postMessage({ id, ...payload });
            } catch (error) {
                this.pending.delete(id);
                this.scheduleIdleShutdown();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }
        let worker: Worker;
        try {
            worker = new Worker(path.join(__dirname, "worker.js"));
        } catch (error) {
            this.workerDisabled = true;
            throw error;
        }
        this.worker = worker;
        worker.on("message", (msg: WorkerResponse) => {
            if (!msg || typeof msg.id !== "number") {
                return;
            }
            const entry = this.pending.get(msg.id);
            if (!entry) {
                return;
            }
            this.pending.delete(msg.id);
            if (!this.pending.size) {
                this.scheduleIdleShutdown();
            }
            if (msg.ok) {
                entry.resolve(msg.result);
            } else {
                entry.reject(new Error(msg.error || "Cursor 后台扫描失败"));
            }
        });
        worker.on("error", (error) => {
            if (this.worker === worker) {
                this.worker = undefined;
            }
            this.clearIdleTimer();
            this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        });
        worker.on("exit", (code) => {
            if (this.worker === worker) {
                this.worker = undefined;
            }
            this.clearIdleTimer();
            if (this.pending.size > 0) {
                this.rejectAll(new Error(`Cursor 扫描线程退出 (${code})`));
            }
        });
        return worker;
    }

    private rejectAll(error: Error): void {
        for (const entry of this.pending.values()) {
            entry.reject(error);
        }
        this.pending.clear();
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private scheduleIdleShutdown(): void {
        if (this.disposed || this.pending.size > 0) {
            return;
        }
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (!this.pending.size) {
                this.terminateWorker();
            }
        }, IDLE_TIMEOUT_MS);
        this.idleTimer.unref?.();
    }

    private terminateWorker(): void {
        const worker = this.worker;
        this.worker = undefined;
        if (worker) {
            void worker.terminate();
        }
    }
}
