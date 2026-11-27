import { parentPort } from "node:worker_threads";
import { discoverCursorConversations, loadCursorConversation, type CursorConversationSummary, type DiscoverOptions } from "./discover";
import { errorMessage } from "../util";

type WorkerRequest =
    | { id: number; action: "discover"; options: DiscoverOptions }
    | { id: number; action: "load"; summary: CursorConversationSummary; userDir?: string };

const port = parentPort;
if (port) {
    port.on("message", (msg: WorkerRequest) => {
        void handleRequest(msg).then((result) => {
            port.postMessage({ id: msg.id, ok: true, result });
        }, (error: unknown) => {
            port.postMessage({ id: msg.id, ok: false, error: errorMessage(error) });
        });
    });
}

async function handleRequest(msg: WorkerRequest): Promise<unknown> {
    if (msg.action === "discover") {
        return discoverCursorConversations(msg.options);
    }
    return loadCursorConversation(msg.summary, msg.userDir);
}
