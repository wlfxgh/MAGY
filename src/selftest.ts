import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isAuthError, RpcError } from "./acp/connection";
import { FrameDecoder } from "./acp/framer";
import { flattenOptions, mergeTokenUsage, readAntigravityTier, readPromptUsage } from "./acp/content";
import { buildElicitationResponse, parseElicitationRequest } from "./acp/elicitation";
import { createAbortError, downloadVerified, fetchManifest, isAbortError } from "./agent/download";
import { AgyRuntime } from "./agent/runtime";
import { parseCreditsCommandOutput, parseUsageCommandOutput } from "./agent/quota";
import { displayLineRange, formatAttachedPrompt } from "./chat/prompt";
import { ChatStore } from "./chat/store";
import { assertReadOnlySql, discoverCursorConversations, loadCursorConversation } from "./cursor/discover";
import { CursorScanner } from "./cursor/scanner";
import { buildContinuation, cleanUserText, messagesFromComposer, parseTranscript, titleFrom } from "./cursor/parse";
import { cursorProjectKey, pathsEqual } from "./cursor/paths";
import { bypassesProxy, countDiffLines, normalizeProxy, resolveProxy } from "./util";

test("cursor project key matches the local folder encoding", () => {
    assert.equal(cursorProjectKey("c:\\workspace\\demo-project"), "c-workspace-demo-project");
    assert.equal(cursorProjectKey("/Users/dev/demo_app"), "Users-dev-demo-app");
});

test("proxy value gets a scheme when missing", () => {
    assert.equal(normalizeProxy("127.0.0.1:7890"), "http://127.0.0.1:7890");
    assert.equal(normalizeProxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
    assert.equal(normalizeProxy("  "), "");
});

test("configured proxy covers downloads and ignores a different environment proxy", () => {
    const resolved = resolveProxy("127.0.0.1:7890", { HTTPS_PROXY: "http://env.example:1" }, "localhost,127.0.0.1");
    assert.equal(resolved.proxy, "http://127.0.0.1:7890");
    assert.equal(resolved.noProxy, "localhost,127.0.0.1");
    assert.equal(resolveProxy("", { HTTPS_PROXY: "http://env.example:1" }, "localhost").proxy, "http://env.example:1");
    assert.equal(bypassesProxy("127.0.0.1", resolved.noProxy), true);
    assert.equal(bypassesProxy("storage.googleapis.com", resolved.noProxy), false);
});

test("cursor import rejects statements that would write", () => {
    assert.doesNotThrow(() => assertReadOnlySql("SELECT value FROM cursorDiskKV WHERE key = ?"));
    assert.doesNotThrow(() => assertReadOnlySql("SELECT json_extract(value, '$.createdAt') AS createdAt, json_extract(value, '$.lastUpdatedAt') AS updatedAt FROM cursorDiskKV"));
    assert.throws(() => assertReadOnlySql("UPDATE cursorDiskKV SET value = 1"));
    assert.throws(() => assertReadOnlySql("SELECT 1; DELETE FROM cursorDiskKV"));
});

test("editor selection becomes a file reference in the prompt", () => {
    assert.deepEqual(displayLineRange(9, 11, 0), { startLine: 10, endLine: 11 });
    assert.deepEqual(displayLineRange(9, 23, 5), { startLine: 10, endLine: 24 });
    const prompt = formatAttachedPrompt("解释这段", [{
        id: "1",
        fileName: "controller.ts",
        relativePath: "src/chat/controller.ts",
        languageId: "typescript",
        startLine: 10,
        endLine: 12,
        text: "const value = 1;\n",
    }]);
    assert.match(prompt, /src\/chat\/controller\.ts/);
    assert.match(prompt, /第 10–12 行/);
    assert.match(prompt, /解释这段/);
});

test("transcript parser keeps the user query and tool call", () => {
    const raw = [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<timestamp>Monday</timestamp>\n<user_query>\nhello world\n</user_query>" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { path: "src/a.ts" } }] } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");
    const messages = parseTranscript(raw);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].text, "hello world");
    assert.equal(messages[1].text, "hi");
    assert.equal(messages[2].title, "Read");
    assert.equal(messages[2].text, "src/a.ts");
});

test("composer bubbles use text, thinking and tool names", () => {
    const messages = messagesFromComposer({
        name: "修复缓存",
        fullConversationHeadersOnly: [
            { bubbleId: "u1", type: 1 },
            { bubbleId: "a1", type: 2 },
        ],
    }, new Map([
        ["u1", { type: 1, text: "为什么缓存没有失效？" }],
        ["a1", { type: 2, text: "键里少了语言。", thinking: { text: "先看键" }, toolFormerData: { name: "read_file_v2", params: { path: "src/cache.ts" } } }],
    ]));
    assert.equal(messages[0].text, "为什么缓存没有失效？");
    assert.equal(messages[1].role, "thought");
    assert.equal(messages[2].text, "键里少了语言。");
    assert.equal(messages[3].title, "read_file_v2");
    assert.equal(titleFrom(messages[0].text), "为什么缓存没有失效？");
    assert.equal(cleanUserText("<user_query>继续</user_query>"), "继续");
});

test("continuation keeps the latest messages inside the budget", () => {
    const text = buildContinuation("标题", [
        { role: "user", text: "早期问题 ".repeat(500) },
        { role: "assistant", text: "最新结论" },
    ], 80);
    assert.match(text, /最新结论/);
    assert.match(text, /已省略/);
});

test("config options accept flat and grouped lists", () => {
    const choices = flattenOptions([
        { value: "low", name: "Low" },
        { name: "Gemini", options: [{ value: "pro", name: "Pro" }] },
    ]);
    assert.deepEqual(choices.map((item) => item.value), ["low", "pro"]);
});

test("frame decoder reads newline json and content length frames", () => {
    const decoder = new FrameDecoder();
    const first = decoder.push(Buffer.from('{"jsonrpc":"2.0","method":"session/update"}\n'));
    assert.equal((first[0] as { method: string }).method, "session/update");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const second = decoder.push(framed);
    assert.equal((second[0] as { id: number }).id, 1);
});

test("chat store remove deletes file and index entry cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "magy-store-"));
    try {
        const store = new ChatStore(root);
        await store.load();
        const first = store.create({ title: "第一个" });
        await store.save(first);
        const second = store.create({ title: "第二个" });
        await store.save(second);
        assert.equal(store.list().length, 2);
        await store.remove(second.id);
        assert.equal(store.list().length, 1);
        assert.equal(store.list()[0].id, first.id);
        assert.equal(await store.get(second.id), undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("readPromptUsage and mergeTokenUsage normalize camelCase, snake_case and accumulate", () => {
    const camel = readPromptUsage({
        stopReason: "end_turn",
        usage: {
            inputTokens: 10787,
            outputTokens: 22,
            cachedReadTokens: 1200,
            cachedWriteTokens: 0,
            thoughtTokens: 20,
            totalTokens: 10809,
        },
    });
    assert.deepEqual(camel, {
        inputTokens: 10787,
        outputTokens: 22,
        cachedReadTokens: 1200,
        cachedWriteTokens: 0,
        thoughtTokens: 20,
        totalTokens: 10809,
    });

    const snake = readPromptUsage({
        usage: {
            input_tokens: 500,
            output_tokens: 150,
            cache_read_tokens: 80,
            thinking_tokens: 40,
        },
    });
    assert.deepEqual(snake, {
        inputTokens: 500,
        outputTokens: 150,
        cachedReadTokens: 80,
        cachedWriteTokens: 0,
        thoughtTokens: 40,
        totalTokens: 650,
    });

    assert.equal(readPromptUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), undefined);
    assert.equal(readPromptUsage({}), undefined);

    const merged = mergeTokenUsage(camel!, snake!);
    assert.deepEqual(merged, {
        inputTokens: 11287,
        outputTokens: 172,
        cachedReadTokens: 1280,
        cachedWriteTokens: 0,
        thoughtTokens: 60,
        totalTokens: 11459,
    });
});

test("readAntigravityTier extracts tier metadata safely", () => {
    const tier = readAntigravityTier({
        _meta: {
            antigravity: {
                tier: {
                    id: "g1-pro-tier",
                    name: "Google AI Pro",
                    upgradeUri: "https://antigravity.google/g1-upgrade",
                },
            },
        },
    });
    assert.deepEqual(tier, {
        id: "g1-pro-tier",
        name: "Google AI Pro",
        upgradeUri: "https://antigravity.google/g1-upgrade",
    });
    assert.equal(readAntigravityTier({}), undefined);
});

test("parseUsageCommandOutput handles JSON, epoch-0 filtering, TSV fallback and errors", () => {
    const jsonOut = JSON.stringify({
        status: "SUCCESS",
        command: {
            name: "usage",
            data: {
                description: "Quota desc",
                groups: [
                    {
                        name: "Gemini Models",
                        description: "Models within this group: Gemini 4 Neon",
                        buckets: [
                            {
                                id: "gemini-5h",
                                name: "Five Hour Limit Remaining",
                                window: "5h",
                                remaining_fraction: 0.65,
                                reset_time: "2026-11-27T06:28:36Z",
                            },
                            {
                                id: "3p-5h",
                                name: "Five Hour Limit Remaining",
                                window: "5h",
                                remaining_fraction: 1,
                                reset_time: "1970-01-01T00:00:00Z",
                            },
                        ],
                    },
                ],
            },
        },
    });
    const parsed = parseUsageCommandOutput(`Fetching...\n${jsonOut}`);
    assert.equal(parsed.description, "Quota desc");
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].buckets[0].remainingFraction, 0.65);
    assert.equal(parsed.groups[0].buckets[0].resetTime, "2026-11-27T06:28:36Z");
    assert.equal(parsed.groups[0].buckets[1].remainingFraction, 1);
    assert.equal(parsed.groups[0].buckets[1].resetTime, undefined);

    const tsvFallback = parseUsageCommandOutput(JSON.stringify({
        status: "SUCCESS",
        response: "Gemini Models\tFive Hour Limit Remaining\t82%\t2026-11-27T08:00:00Z\nGemini Models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z\n",
        command: { name: "usage", data: {} },
    }));
    assert.equal(tsvFallback.groups.length, 1);
    assert.equal(tsvFallback.groups[0].buckets[0].window, "5h");
    assert.equal(tsvFallback.groups[0].buckets[0].remainingFraction, 0.82);
    assert.equal(tsvFallback.groups[0].buckets[1].window, "weekly");
    assert.equal(tsvFallback.groups[0].buckets[1].resetTime, undefined);

    assert.throws(() => parseUsageCommandOutput(JSON.stringify({ status: "ERROR", error: "unauthenticated" })), /unauthenticated/);
});

test("parseCreditsCommandOutput extracts remaining credits and upgrade uri", () => {
    const parsed = parseCreditsCommandOutput(JSON.stringify({
        status: "SUCCESS",
        command: {
            name: "credits",
            data: {
                remaining_credits: 42,
                upgrade_uri: "https://antigravity.google/g1-upgrade",
            },
        },
    }));
    assert.equal(parsed.remainingCredits, 42);
    assert.equal(parsed.upgradeUri, "https://antigravity.google/g1-upgrade");
});

test("chat store persists tokenStats and exposes totalTokens in ChatMeta", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "magy-token-store-"));
    try {
        const store = new ChatStore(root);
        await store.load();
        const chat = store.create({ title: "Token 统计测试" });
        chat.tokenStats = {
            contextUsed: 10809,
            contextSize: 1048576,
            total: {
                inputTokens: 10787,
                outputTokens: 22,
                cachedReadTokens: 0,
                cachedWriteTokens: 0,
                thoughtTokens: 20,
                totalTokens: 10809,
            },
            lastTurn: {
                inputTokens: 10787,
                outputTokens: 22,
                cachedReadTokens: 0,
                cachedWriteTokens: 0,
                thoughtTokens: 20,
                totalTokens: 10809,
            },
            turns: 1,
            updatedAt: Date.now(),
        };
        await store.save(chat);

        const reloaded = new ChatStore(root);
        await reloaded.load();
        const metas = reloaded.list();
        assert.equal(metas[0].totalTokens, 10809);
        const restored = await reloaded.get(chat.id);
        assert.equal(restored?.tokenStats?.contextUsed, 10809);
        assert.equal(restored?.tokenStats?.turns, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("countDiffLines computes accurate line additions and deletions", () => {
    assert.deepEqual(countDiffLines("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;\nconst c = 4;"), { add: 2, del: 1 });
    assert.deepEqual(countDiffLines("", "line1\nline2"), { add: 2, del: 0 });
    assert.deepEqual(countDiffLines("line1\nline2", ""), { add: 0, del: 2 });
    assert.deepEqual(countDiffLines("a\nb\nc", "a\nx\nc"), { add: 1, del: 1 });
    assert.deepEqual(countDiffLines("same\nline", "same\nline"), { add: 0, del: 0 });
});

test("cursor discover and load use range queries, composerHeaders and worker_threads cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "magy-cursor-db-"));
    const sqlite = await import("node:sqlite") as typeof import("node:sqlite");
    const scanner = new CursorScanner();
    try {
        const userDir = path.join(root, "User");
        const globalDir = path.join(userDir, "globalStorage");
        const wsStorageId = "ws-hash-1";
        const wsDir = path.join(userDir, "workspaceStorage", wsStorageId);
        const projectsDir = path.join(root, "projects");
        const wsPath = path.join(root, "demo-project");
        fs.mkdirSync(globalDir, { recursive: true });
        fs.mkdirSync(wsDir, { recursive: true });
        fs.mkdirSync(projectsDir, { recursive: true });
        fs.mkdirSync(wsPath, { recursive: true });

        const wsUri = `file:///${wsPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
        fs.writeFileSync(path.join(wsDir, "workspace.json"), JSON.stringify({ folder: wsUri }), "utf8");

        const dbPath = path.join(globalDir, "state.vscdb");
        const db = new sqlite.DatabaseSync(dbPath);
        try {
            db.exec(`
                CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
                CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
                CREATE TABLE composerHeaders (
                    composerId TEXT PRIMARY KEY,
                    workspaceId TEXT,
                    createdAt INTEGER,
                    lastUpdatedAt INTEGER,
                    isArchived INTEGER,
                    isSubagent INTEGER,
                    recency INTEGER,
                    checkpointAt INTEGER,
                    subagentTypeName TEXT,
                    value TEXT
                );
            `);

            const insertKv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
            const insertHeader = db.prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value) VALUES (?, ?, ?, ?, ?, ?)");

            insertHeader.run(
                "comp-a",
                wsStorageId,
                1000,
                3000,
                0,
                JSON.stringify({ composerId: "comp-a", name: "工作区测试对话", unifiedMode: "agent", createdAt: 1000, lastUpdatedAt: 3000 }),
            );
            insertHeader.run(
                "comp-sub",
                wsStorageId,
                1000,
                2500,
                1,
                JSON.stringify({ composerId: "comp-sub", name: "子代理不应出现", unifiedMode: "agent" }),
            );
            insertHeader.run(
                "task-hidden",
                wsStorageId,
                1000,
                2600,
                0,
                JSON.stringify({ composerId: "task-hidden", name: "任务记录不应出现" }),
            );
            insertKv.run(
                "composerData:comp-a",
                JSON.stringify({
                    name: "工作区测试对话",
                    lastUpdatedAt: 3000,
                    unifiedMode: "agent",
                    workspaceIdentifier: { id: wsStorageId, uri: { fsPath: wsPath } },
                    fullConversationHeadersOnly: [
                        { bubbleId: "b1", type: 1 },
                        { bubbleId: "b2", type: 2 },
                    ],
                }),
            );
            insertKv.run("bubbleId:comp-a:b1", JSON.stringify({ type: 1, text: "帮我看下这个问题" }));
            insertKv.run("bubbleId:comp-a:b2", JSON.stringify({ type: 2, text: "已经查到原因了" }));
            insertKv.run(
                "composerData:comp-a-extra",
                JSON.stringify({
                    name: "其他项目对话",
                    lastUpdatedAt: 2000,
                    unifiedMode: "chat",
                    workspaceIdentifier: { uri: { fsPath: path.join(root, "other-project") } },
                }),
            );
            insertKv.run("bubbleId:comp-a-extra:b9", JSON.stringify({ type: 1, text: "不应混入 comp-a" }));
        } finally {
            db.close();
        }

        const direct = await discoverCursorConversations({
            userDir,
            projectsDir,
            workspacePaths: [wsPath],
            all: true,
        });
        assert.deepEqual(direct.conversations.map((item) => item.id), ["comp-a", "comp-a-extra"]);
        assert.equal(direct.conversations[0].inWorkspace, true);
        assert.equal(pathsEqual(direct.conversations[0].project ?? "", wsPath), true);
        assert.equal(direct.conversations[1].inWorkspace, false);

        const loadedDirect = await loadCursorConversation(direct.conversations[0], userDir);
        assert.equal(loadedDirect.messages.length, 2);
        assert.equal(loadedDirect.messages[0].text, "帮我看下这个问题");
        assert.equal(loadedDirect.messages[1].text, "已经查到原因了");

        const viaWorker = await scanner.discover({
            userDir,
            projectsDir,
            workspacePaths: [wsPath],
            all: true,
        });
        assert.deepEqual(viaWorker.conversations.map((item) => item.id), ["comp-a", "comp-a-extra"]);

        const loadedWorker = await scanner.load(viaWorker.conversations[0], userDir);
        assert.equal(loadedWorker.messages.length, 2);
        assert.equal(loadedWorker.messages[0].text, "帮我看下这个问题");
    } finally {
        scanner.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("elicitation parser pairs _other fields, handles enums, and builds valid ACP responses", () => {
    const view = parseElicitationRequest("req-1", {
        mode: "form",
        message: "The agent has 2 questions.",
        requestedSchema: {
            type: "object",
            required: ["q1", "confirm"],
            properties: {
                q1: {
                    type: "string",
                    title: "Preferred DB?",
                    oneOf: [
                        { const: "1", title: "(Recommended) PostgreSQL" },
                        { const: "2", title: "SQLite" },
                    ],
                },
                q1_other: {
                    type: "string",
                    title: "Other",
                    description: "Optional free-form answer to: Preferred DB?",
                },
                q2: {
                    type: "array",
                    title: "Features?",
                    items: {
                        anyOf: [
                            { const: "a", title: "Auth" },
                            { const: "b", title: "Cache（推荐）" },
                        ],
                    },
                },
                q2_other: {
                    type: "string",
                    title: "Other",
                },
                mode_enum: {
                    type: "string",
                    title: "Mode",
                    enum: ["fast", "safe"],
                    enumNames: ["Fast Mode", "Safe Mode"],
                },
                port: {
                    type: "integer",
                    title: "Port",
                    minimum: 1,
                    maximum: 65535,
                    default: 8080,
                },
                confirm: {
                    type: "boolean",
                    title: "Confirm changes",
                    default: true,
                },
            },
        },
    });

    assert.equal(view.title, "请回答以下问题");
    assert.equal(view.message, "共 5 个问题");
    assert.equal(view.fields.length, 5);
    assert.equal(view.fields[0].kind, "single");
    assert.equal(view.fields[0].otherKey, "q1_other");
    assert.equal(view.fields[0].required, true);
    assert.deepEqual(view.fields[0].options?.[0], { value: "1", label: "PostgreSQL", recommended: true });
    assert.equal(view.fields[1].kind, "multi");
    assert.equal(view.fields[1].otherKey, "q2_other");
    assert.deepEqual(view.fields[1].options?.[1], { value: "b", label: "Cache", recommended: true });
    assert.deepEqual(view.fields[2].options, [
        { value: "fast", label: "Fast Mode" },
        { value: "safe", label: "Safe Mode" },
    ]);
    assert.equal(view.fields[3].kind, "number");
    assert.equal(view.fields[3].integer, true);
    assert.equal(view.fields[4].kind, "boolean");

    // When only q1_other is filled, q1 should be omitted cleanly while keeping q1_other
    const freeformResp = buildElicitationResponse(view, "accept", {
        q1: "",
        q1_other: "DuckDB",
        q2: ["a"],
        q2_other: "Tracing",
        mode_enum: "safe",
        port: "3000.9",
        confirm: false,
    });
    assert.deepEqual(freeformResp, {
        action: "accept",
        content: {
            q1_other: "DuckDB",
            q2: ["a"],
            q2_other: "Tracing",
            mode_enum: "safe",
            port: 3000,
            confirm: false,
        },
    });

    assert.deepEqual(buildElicitationResponse(view, "decline"), { action: "decline" });
    assert.deepEqual(buildElicitationResponse(view, "cancel"), { action: "cancel" });

    const urlView = parseElicitationRequest("req-url", {
        mode: "url",
        message: "Open browser to authorize",
        url: "https://example.com/oauth",
    });
    assert.equal(urlView.mode, "url");
    assert.equal(urlView.url, "https://example.com/oauth");
});

test("isAuthError distinguishes real authentication errors from transport/timeout failures", () => {
    assert.equal(isAuthError(new RpcError(-32000, "Authentication required")), true);
    assert.equal(isAuthError(new RpcError(-32000, "")), true);
    assert.equal(isAuthError(new RpcError(-32001, "auth_required")), true);
    assert.equal(isAuthError(new Error("You are not logged into Antigravity")), true);
    assert.equal(isAuthError(new RpcError(-32000, "proxyconnect tcp: connection refused")), false);
    assert.equal(isAuthError(new RpcError(-32000, "context deadline exceeded")), false);
    assert.equal(isAuthError(new RpcError(-32603, "internal error")), false);
});

test("download abort helpers and pre-aborted signals cancel immediately", async () => {
    assert.equal(isAbortError(createAbortError()), true);
    assert.equal(isAbortError(new Error("other")), false);
    assert.equal(normalizeProxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
    assert.equal(normalizeProxy("127.0.0.1:10000"), "http://127.0.0.1:10000");

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => fetchManifest({ signal: controller.signal }),
        (error: unknown) => isAbortError(error),
    );
    await assert.rejects(
        () => downloadVerified("https://example.com/agy.tar.gz", path.join(os.tmpdir(), "magy-unused.bin"), "00", { signal: controller.signal }),
        (error: unknown) => isAbortError(error),
    );
});

test("AgyRuntime.inspectInstalled detects missing and installed binaries accurately", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "magy-rt-"));
    try {
        const runtime = new AgyRuntime(root, () => undefined);
        assert.equal(await runtime.inspectInstalled(), undefined);
        assert.equal(await runtime.inspectInstalled(path.join(root, "missing.exe")), undefined);

        const binDir = path.join(root, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const binPath = path.join(binDir, process.platform === "win32" ? "agy.exe" : "agy");
        fs.writeFileSync(binPath, "stub", "utf8");
        fs.writeFileSync(path.join(root, "VERSION"), "1.5.18\n", "utf8");

        const detected = await runtime.inspectInstalled();
        assert.deepEqual(detected, { binary: binPath, version: "1.5.18", managed: true });

        const customPath = path.join(root, "custom-agy");
        fs.writeFileSync(customPath, "custom", "utf8");
        assert.deepEqual(await runtime.inspectInstalled(customPath), {
            binary: customPath,
            version: "自定义",
            managed: false,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
