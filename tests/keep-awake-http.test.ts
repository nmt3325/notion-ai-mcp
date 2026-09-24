import assert from "node:assert/strict";
import test from "node:test";
import type { NotionClient } from "../src/notion-client.js";
import { createRemoteMcpHttpServer, originAllowed } from "../src/http-server.js";
import { resolveKeepAwakeRoute } from "../src/keep-awake-http.js";

const bearerToken = "test-only-not-a-secret-bearer-token-0000000000000000";
const conversationId = "11111111-1111-4111-8111-111111111111";

/** A client that answers every read the watchdog performs, without touching Notion. */
function fakeClient(): NotionClient {
  return {
    startWebConfirmations: () => undefined,
    stopWebConfirmations: () => undefined,
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false }),
    listChatJobs: () => [],
    chatStatePath: () => null,
    chatStateError: () => null,
    keepAwakeDefaults: () => ({
      interrupt: true,
      idleMs: 120_000,
      pollMs: 30_000,
      cooldownMs: 60_000,
      maxNudges: 40,
      deadlineMs: 10_800_000,
      enabled: true,
      autoContinue: true,
      maxContinues: 10
    }),
    keepAliveStatePath: () => null,
    threadSignals: async (threadId: string) => ({
      threadId,
      updatedTime: Date.now(),
      serverNow: Date.now(),
      messageCount: 2,
      lastTurnOutcome: null,
      credits: null,
      currentInferenceId: "",
      leaseExpiration: null,
      lastUserMessageTime: Date.now()
    }),
    sendChatNudge: async () => ({ acceptedAt: Date.now() }),
    sendChatContinue: async () => ({ acceptedAt: Date.now() }),
    nativeContinuationState: async () => null,
    finalStepShape: async () => null,
    interruptTurn: async (threadId: string) => ({ threadId, cleared: false, inferenceId: "" }),
    getConversation: async (id: string) => ({ id, title: "Fixture", type: "workflow", createdAt: null, updatedAt: null, messages: [] })
  } as unknown as NotionClient;
}

test("keep-awake routes are resolved by method and shape", () => {
  assert.equal(resolveKeepAwakeRoute("GET", "/mcp"), null);
  assert.deepEqual(resolveKeepAwakeRoute("GET", "/keep-awake"), { kind: "route", route: { action: "list" } });
  assert.deepEqual(resolveKeepAwakeRoute("POST", "/keep-awake/"), { kind: "route", route: { action: "start" } });
  assert.deepEqual(resolveKeepAwakeRoute("POST", "/keep-awake/stop-all"), { kind: "route", route: { action: "stopAll" } });
  assert.deepEqual(resolveKeepAwakeRoute("POST", "/keep-awake/ka_1/kick"), { kind: "route", route: { action: "kick", keepAliveId: "ka_1" } });
  assert.deepEqual(resolveKeepAwakeRoute("DELETE", "/keep-awake"), { kind: "method_not_allowed", allow: "GET, POST, OPTIONS" });
  assert.deepEqual(resolveKeepAwakeRoute("POST", "/keep-awake/ka_1/burn"), { kind: "not_found" });
});

test("only configured browser origins may read a response", () => {
  const allowed = ["https://www.notion.so", "chrome-extension://*"];
  assert.equal(originAllowed("https://www.notion.so", allowed), true);
  assert.equal(originAllowed("chrome-extension://abcdefghijklmnop", allowed), true);
  assert.equal(originAllowed("https://notion.so.example.com", allowed), false);
  assert.equal(originAllowed("", allowed), false);
  assert.equal(originAllowed("https://anything.example", ["*"]), true);
});

test("a browser can arm, list, check and stop a watchdog over HTTP", async () => {
  const remote = createRemoteMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    bearerToken,
    sessionTtlMs: 60_000,
    maxSessions: 5,
    allowedOrigins: ["https://www.notion.so"],
    clientFactory: fakeClient,
    logger: () => undefined
  });
  const address = await remote.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" };

  try {
    const unauthorized = await fetch(`${base}/keep-awake`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

    // The panel runs on the Notion page, so the browser preflights before it may read anything.
    const preflight = await fetch(`${base}/keep-awake`, {
      method: "OPTIONS",
      headers: { origin: "https://www.notion.so", "access-control-request-method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://www.notion.so");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const refused = await fetch(`${base}/keep-awake`, {
      method: "OPTIONS",
      headers: { origin: "https://phishing.example", "access-control-request-method": "POST" }
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("access-control-allow-origin"), null);

    const rejected = await fetch(`${base}/keep-awake`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationId: "not-a-uuid" })
    });
    assert.equal(rejected.status, 400);
    const rejectedBody = (await rejected.json()) as { code: string; issues: Array<{ path: string }> };
    assert.equal(rejectedBody.code, "invalid_request");
    assert.equal(rejectedBody.issues[0]?.path, "conversationId");

    const started = await fetch(`${base}/keep-awake`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversationId, idleSeconds: 90, deadlineMinutes: 30, maxNudges: 5 })
    });
    assert.equal(started.status, 201);
    const startedBody = (await started.json()) as {
      keepAlive: { keepAliveId: string; status: string; idleMs: number; maxNudges: number; doneToken: string };
      defaults: { idleSeconds: number; deadlineMinutes: number };
    };
    assert.equal(startedBody.keepAlive.status, "watching");
    assert.equal(startedBody.keepAlive.idleMs, 90_000);
    assert.equal(startedBody.keepAlive.maxNudges, 5);
    assert.match(startedBody.keepAlive.doneToken, /^DONE::KA-[0-9a-f]{12}$/);
    // The form in the extension is prefilled from these, so they travel in the units it shows.
    assert.equal(startedBody.defaults.idleSeconds, 120);
    assert.equal(startedBody.defaults.deadlineMinutes, 180);
    const keepAliveId = startedBody.keepAlive.keepAliveId;

    const listed = await fetch(`${base}/keep-awake?status=watching&limit=10`, { headers: auth });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { keepAlives: Array<{ keepAliveId: string }>; serverNow: number };
    assert.equal(listedBody.keepAlives.length, 1);
    assert.equal(listedBody.keepAlives[0]?.keepAliveId, keepAliveId);
    assert.ok(listedBody.serverNow > 0);

    // check has no body, and an empty one must not read as a malformed request.
    const checked = await fetch(`${base}/keep-awake/${keepAliveId}/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}` }
    });
    assert.equal(checked.status, 200);
    const checkedBody = (await checked.json()) as {
      decision: { action: string; reason: string };
      keepAlive: { status: string };
    };
    assert.equal(checkedBody.keepAlive.status, "watching");
    assert.equal(checkedBody.decision.action, "wait");
    assert.ok(checkedBody.decision.reason.length > 0);

    const missing = await fetch(`${base}/keep-awake/ka_missing/stop`, { method: "POST", headers: auth });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, "not_found");

    const stopped = await fetch(`${base}/keep-awake/${keepAliveId}/stop`, { method: "POST", headers: auth });
    assert.equal(stopped.status, 200);
    assert.equal(((await stopped.json()) as { keepAlive: { status: string } }).keepAlive.status, "stopped");
  } finally {
    await fetch(`${base}/keep-awake/stop-all`, { method: "POST", headers: auth }).catch(() => undefined);
    await remote.close();
  }
});
