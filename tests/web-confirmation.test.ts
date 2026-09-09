import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWebConfirmationRequest, DEFAULT_WEB_CONFIRMATION, isPendingWebConfirmation, WebConfirmationHttpError, WebConfirmationSupervisor, type WebConfirmationRuntime } from "../src/web-confirmation.js";
import { NotionClient } from "../src/notion-client.js";
import type { NotionConfig } from "../src/config.js";
import { createRemoteMcpHttpServer } from "../src/http-server.js";

type Json = Record<string, any>;
const scope = { spaceId: "space-a", userId: "user" };
const otherScope = { spaceId: "space-b", userId: "user" };
const reply = { text: "Completed", inputTokens: 2, outputTokens: 3, eventTypes: { "agent-inference": 1 } };
const pending = (id = "web", traceId = "initial", agentStepId = "inference"): Json => ({
  id, type: "agent-tool-result", state: "confirmation:requested", traceId, agentStepId,
  toolName: "callFunction", moduleInfo: { type: "web" }, requestedConfirmation: true,
  input: { function: "connections.web.loadPage", namespace: "connections", connectionName: "web", name: "loadPage", args: { url: "https://example.test/test?secret=do-not-log" } },
  pendingConfirmations: [{ type: "urlSafety", urls: ["https://example.test/test?secret=do-not-log"] }]
});
function fixture() {
  const threads = new Map<string, Json>(), records = new Map<string, Json>(), calls: Json[] = [], reads: Json[] = [], logs: string[] = [];
  let scopes = [scope], pageSize = 100, failReads = false;
  let handler: ((body: Json) => Promise<typeof reply>) | undefined;
  const add = (id: string, spaceId = scope.spaceId) => {
    const config = { id: `${id}-config`, type: "config", value: { type: "workflow", useReadOnlyMode: true } };
    const context = { id: `${id}-context`, type: "context", value: { spaceId } };
    const inference = { id: `${id}-inference`, type: "agent-inference", traceId: `${id}-initial`, value: [] };
    const step = pending(`${id}-web`, `${id}-initial`, inference.id);
    for (const value of [config, context, inference, step]) records.set(value.id, { id: value.id, step: value, parent_id: id, space_id: spaceId });
    const thread = { id, version: 1, type: "workflow", alive: true, space_id: spaceId, messages: [config.id, context.id, inference.id, step.id], data: { last_turn_outcome: { status: "requires_action", inference_id: `${id}-initial`, final_step_id: step.id } } };
    threads.set(id, thread); return thread;
  };
  const apply = (body: Json) => {
    for (const id of body.confirmToolStepIds) records.get(id)!.step.state = "applied";
    const thread = threads.get(body.threadId)!;
    thread.data.last_turn_outcome = { status: "completed", inference_id: body.traceId, final_step_id: body.confirmToolStepIds.at(-1) };
    thread.version++;
  };
  const runtime: WebConfirmationRuntime = {
    scopes: async () => scopes,
    post: async (context, endpoint, body: Json) => {
      reads.push({ context, endpoint, body });
      if (failReads) throw new Error("transport secret must not be logged");
      if (endpoint === "getInferenceTranscriptsForUser") {
        const all = [...threads.values()].filter(t => t.space_id === context.spaceId), offset = Number(body.cursor ?? 0), rows = all.slice(offset, offset + pageSize);
        return { transcripts: rows.map(t => ({ id: t.id })), recordMap: { thread: Object.fromEntries(rows.map(t => [t.id, { value: { value: structuredClone(t) } }])) }, hasMore: offset + pageSize < all.length, nextCursor: String(offset + pageSize) };
      }
      assert.equal(endpoint, "syncRecordValuesMain");
      const maps: Json = { thread: {}, thread_message: {} };
      for (const { pointer } of body.requests) {
        assert.equal(pointer.spaceId, context.spaceId);
        const record = pointer.table === "thread" ? threads.get(pointer.id) : records.get(pointer.id);
        if (record) maps[pointer.table][pointer.id] = { value: { value: structuredClone(record) } };
      }
      return { recordMap: maps };
    },
    confirm: async (context, body: Json, signal) => {
      signal.throwIfAborted();
      assert.equal(context.spaceId, threads.get(body.threadId)!.space_id);
      calls.push(body);
      if (handler) return handler(body);
      apply(body); return reply;
    }
  };
  const create = (stateFilePath?: string) => new WebConfirmationSupervisor(runtime, { ...DEFAULT_WEB_CONFIRMATION, ...(stateFilePath ? { stateFilePath } : {}) }, value => logs.push(value));
  return { runtime, threads, records, calls, reads, logs, add, apply, create,
    setScopes: (value: typeof scopes) => { scopes = value; }, setPageSize: (value: number) => { pageSize = value; },
    setHandler: (value: typeof handler) => { handler = value; }, setFailReads: (value: boolean) => { failReads = value; }
  };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), "asynchronous confirmation should have completed");
}

test("only the current built-in Web URL safety permission is eligible", () => {
  assert.equal(isPendingWebConfirmation(pending()), true);
  for (const step of [
    { ...pending(), state: "applied" }, { ...pending(), type: "agent-inference" },
    { ...pending(), moduleInfo: { type: "mcpServer" } },
    { ...pending(), input: { ...pending().input, function: "connections.notion.deletePages" } },
    { ...pending(), pendingConfirmations: [] },
    { ...pending(), pendingConfirmations: [...pending().pendingConfirmations, { type: "write" }] },
    { ...pending(), pendingConfirmations: [{ type: "urlSafety", urls: ["javascript:alert(1)"] }] },
    { ...pending(), pendingConfirmations: [{ type: "urlSafety", urls: ["https://user:secret@example.test/"] }] }
  ]) assert.equal(isPendingWebConfirmation(step), false);
});

test("native approval preserves stored config and context and adds no user turn", () => {
  const config = [{ id: "c", type: "config", value: { useReadOnlyMode: true } }, { id: "x", type: "context", value: {} }];
  const body = buildWebConfirmationRequest(scope, "thread", config, [pending()], "trace");
  assert.deepEqual(body.confirmToolStepIds, ["web"]);
  assert.deepEqual(body.transcript, [...config, pending()]);
  assert.equal(body.createThread, false);
  assert.equal((body.transcript as Json[]).some(s => s.type === "user"), false);
  assert.throws(() => buildWebConfirmationRequest(scope, "thread", config, [{ ...pending(), state: "applied" }], "trace"));
});

test("native approval handles a browser-created thread and concurrent callers only once", async () => {
  const f = fixture(); f.add("browser-thread"); const supervisor = f.create();
  const results = await Promise.all(Array.from({ length: 8 }, () => supervisor.resume(scope, "browser-thread", "browser-thread-initial")));
  assert.equal(f.calls.length, 1);
  assert.ok(results.every(result => result?.text === "Completed"));
  await supervisor.resume(scope, "browser-thread");
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.join(" ").includes("do-not-log"), false);
  supervisor.stop();
});

test("all workspace pages and threads are discovered without a chat tool call", async () => {
  const f = fixture(); f.add("a1"); f.add("a2"); f.add("b1", otherScope.spaceId); f.setScopes([scope, otherScope]); f.setPageSize(1);
  const supervisor = f.create(); supervisor.start(); supervisor.start();
  await until(() => f.calls.length === 3);
  assert.deepEqual(new Set(f.calls.map(call => call.threadId)), new Set(["a1", "a2", "b1"]));
  assert.ok(f.reads.some(read => read.endpoint === "getInferenceTranscriptsForUser" && read.body.cursor === "1"));
  assert.equal(f.logs.filter(line => line.startsWith("enabled")).length, 1);
  supervisor.stop();
});

test("one long-running confirmation stream does not block another thread", async () => {
  const f = fixture(); f.add("long"); f.add("other");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setHandler(async body => { if (body.threadId === "long") await gate; f.apply(body); return reply; });
  const supervisor = f.create(); await supervisor.tick();
  await until(() => f.calls.length === 2);
  assert.equal(f.records.get("other-web")!.step.state, "applied");
  release(); await supervisor.resume(scope, "long"); supervisor.stop();
});

test("a second URL on the same host is a new independently confirmed step", async () => {
  const f = fixture(); const thread = f.add("chain");
  f.setHandler(async body => {
    f.apply(body);
    if (f.calls.length === 1) {
      const inference = { id: "second-inference", type: "agent-inference", value: [] };
      const step = pending("second-web", body.traceId, inference.id);
      step.input.args.url = "https://example.test/another";
      step.pendingConfirmations[0].urls = ["https://example.test/another"];
      for (const s of [inference, step]) { f.records.set(s.id, { step: s }); thread.messages.push(s.id); }
      thread.data.last_turn_outcome = { status: "requires_action", inference_id: body.traceId, final_step_id: step.id };
    }
    return reply;
  });
  const supervisor = f.create(); await supervisor.resume(scope, "chain");
  assert.deepEqual(f.calls.map(call => call.confirmToolStepIds), [["chain-web"], ["second-web"]]);
  supervisor.stop();
});

test("unknown network delivery is journaled across restart without duplicate approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-confirmation-"));
  try {
    const file = join(directory, "pending.json"), f = fixture(); f.add("uncertain");
    f.setHandler(async () => { throw new Error("connection closed after submission"); });
    const first = f.create(file); await assert.rejects(first.resume(scope, "uncertain")); first.stop();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").includes("https://"), false);
    const second = f.create(file); await second.resume(scope, "uncertain");
    assert.equal(f.calls.length, 1); second.stop();
    f.records.get("uncertain-web")!.step.state = "applied";
    const third = f.create(file); await third.resume(scope, "uncertain");
    assert.equal(f.calls.length, 1); third.stop();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("explicit rejection can be retried after restart, unlike an ambiguous 5xx", async () => {
  for (const status of [429, 503]) {
    const directory = mkdtempSync(join(tmpdir(), "web-confirmation-status-"));
    try {
      const file = join(directory, "pending.json"), f = fixture(); f.add("retry");
      f.setHandler(async () => { throw new WebConfirmationHttpError(status); });
      const first = f.create(file); await assert.rejects(first.resume(scope, "retry")); first.stop();
      f.setHandler(undefined);
      const next = f.create(file); await next.resume(scope, "retry"); next.stop();
      assert.equal(f.calls.length, status === 429 ? 2 : 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("completed, cross-workspace, and superseded confirmations are not approved", async () => {
  for (const modify of [
    (thread: Json) => { thread.data.last_turn_outcome.status = "completed"; },
    (thread: Json) => { thread.space_id = "different-space"; },
    (thread: Json) => { thread.current_inference_id = "another-live-turn"; },
    (thread: Json) => { thread.messages.push("new-user-message"); }
  ]) {
    const f = fixture(), thread = f.add("stale"); modify(thread);
    const supervisor = f.create(); await supervisor.resume(scope, "stale");
    assert.equal(f.calls.length, 0); supervisor.stop();
  }
});

test("disabled and stopped supervisors cannot submit later confirmations", async () => {
  const f = fixture(); f.add("stop");
  const disabled = new WebConfirmationSupervisor(f.runtime, { ...DEFAULT_WEB_CONFIRMATION, enabled: false });
  disabled.start(); await disabled.tick(); await disabled.resume(scope, "stop");
  assert.equal(f.calls.length, 0); disabled.stop();
  const supervisor = f.create(); supervisor.stop(); await supervisor.tick(); await supervisor.resume(scope, "stop");
  assert.equal(f.calls.length, 0);
});

test("a shutdown while discovery is in flight never grants a permission", async () => {
  const f = fixture(); f.add("race"); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const supervisor = new WebConfirmationSupervisor({ ...f.runtime, scopes: async () => { await gate; return [scope]; } }, { ...DEFAULT_WEB_CONFIRMATION }, () => undefined);
  const work = supervisor.tick(); supervisor.stop(); release(); await work;
  assert.equal(f.calls.length, 0);
});

test("native client uses scope-pinned headers and does not switch the active workspace", async () => {
  const f = fixture(); f.add("remote", otherScope.spaceId);
  const config = {
    apiBase: "https://notion.test/api/v3", defaultModel: "test", requestTimeoutMs: 1000,
    defaultWebSearch: true, defaultWorkspaceSearch: true, defaultReadOnly: false,
    webConfirmation: { ...DEFAULT_WEB_CONFIRMATION },
    account: { tokenV2: "test", userId: "user", userName: "Test", userEmail: "test@example.test", spaceId: scope.spaceId, spaceViewId: "view", spaceName: "Test", timezone: "UTC", browserId: "browser", deviceId: "device", clientVersion: "test" }
  } as NotionConfig;
  const mock: typeof fetch = async (url, init) => {
    const endpoint = String(url).split("/").at(-1)!;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-notion-space-id"), otherScope.spaceId);
    const body = JSON.parse(String(init?.body));
    if (endpoint === "runInferenceTranscript") {
      await f.runtime.confirm(otherScope, body, init?.signal as AbortSignal);
      return new Response(JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "Native completed" }] }) + "\n");
    }
    return new Response(JSON.stringify(await f.runtime.post(otherScope, endpoint, body, init?.signal as AbortSignal)));
  };
  const client = new NotionClient(config, mock);
  const result = await client.webConfirmationSupervisor(() => undefined).resume(otherScope, "remote");
  assert.equal(result?.text, "Native completed");
  assert.equal((await client.account()).spaceId, scope.spaceId);
  client.stopWebConfirmations();
});

test("HTTP startup owns one shared client and stops it on shutdown before any MCP session", async () => {
  let creates = 0, starts = 0, stops = 0;
  const client = { startWebConfirmations() { starts++; }, stopWebConfirmations() { stops++; } } as unknown as NotionClient;
  const remote = createRemoteMcpHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp", bearerToken: "x".repeat(40), sessionTtlMs: 300000, maxSessions: 20, logger: () => undefined, clientFactory: () => { creates++; return client; } });
  await remote.listen(); remote.startWebConfirmations(); remote.startWebConfirmations();
  assert.equal(creates, 1); assert.equal(starts, 2); assert.equal(remote.sessionCount(), 0);
  await remote.close(); assert.equal(stops, 1);
});

test("a human change between fresh reads prevents automatic approval", async () => {
  const f = fixture(); const thread = f.add("changed"); const post = f.runtime.post;
  let threadReads = 0;
  f.runtime.post = async (context, endpoint, body: Json, signal) => {
    if (body.requests?.some((r: Json) => r.pointer.table === "thread") && ++threadReads === 2) {
      thread.data.last_turn_outcome.status = "completed"; thread.version++;
      f.records.get("changed-web")!.step.state = "applied";
    }
    return post(context, endpoint, body, signal);
  };
  const supervisor = f.create();
  assert.equal(await supervisor.resume(scope, "changed"), null);
  assert.equal(f.calls.length, 0); supervisor.stop();
});

test("a parallel non-Web confirmation is never included in the approval", async () => {
  const f = fixture(); const thread = f.add("mixed");
  const nonWeb = { ...pending("mixed-write", "mixed-initial", "mixed-inference"), moduleInfo: { type: "mcpServer" }, pendingConfirmations: [{ type: "write" }] };
  f.records.set(nonWeb.id, { id: nonWeb.id, step: nonWeb, parent_id: "mixed", space_id: scope.spaceId });
  thread.messages.push(nonWeb.id); thread.data.last_turn_outcome.final_step_id = nonWeb.id;
  const supervisor = f.create(); await supervisor.resume(scope, "mixed");
  assert.deepEqual(f.calls[0]!.confirmToolStepIds, ["mixed-web"]);
  assert.equal(nonWeb.state, "confirmation:requested"); supervisor.stop();
});

test("chat recovers an empty permission stream using its original workspace after a switch", async () => {
  const f = fixture();
  const config = {
    apiBase: "https://notion.test/api/v3", defaultModel: "test", requestTimeoutMs: 1000, maxWorkspaceRetries: 0,
    defaultWebSearch: true, defaultWorkspaceSearch: true, defaultReadOnly: false,
    webConfirmation: { ...DEFAULT_WEB_CONFIRMATION },
    account: { tokenV2: "test", userId: "user", userName: "Test", userEmail: "test@example.test", spaceId: scope.spaceId, spaceViewId: "view", spaceName: "Test", timezone: "UTC", browserId: "browser", deviceId: "device", clientVersion: "test" }
  } as NotionConfig;
  const mock: typeof fetch = async (url, init) => {
    const endpoint = String(url).split("/").at(-1)!, body = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get("x-notion-space-id"), scope.spaceId);
    if (endpoint === "runInferenceTranscript" && !body.confirmToolStepIds) {
      const thread = f.add(body.threadId);
      thread.data.last_turn_outcome.inference_id = body.traceId;
      const tool = f.records.get(`${body.threadId}-web`)!.step;
      tool.traceId = body.traceId;
      f.records.get(`${body.threadId}-inference`)!.step.traceId = body.traceId;
      config.account.spaceId = otherScope.spaceId;
      return new Response(JSON.stringify(tool) + "\n");
    }
    if (endpoint === "runInferenceTranscript") {
      await f.runtime.confirm(scope, body, init?.signal as AbortSignal);
      return new Response(JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "Recovered answer" }] }) + "\n");
    }
    return new Response(JSON.stringify(await f.runtime.post(scope, endpoint, body, init?.signal as AbortSignal)));
  };
  const client = new NotionClient(config, mock);
  client.webConfirmationSupervisor(() => undefined);
  try {
    const result = await client.chat({ prompt: "Fetch the requested example" });
    assert.equal(result.text, "Recovered answer"); assert.equal(f.calls.length, 1);
    assert.equal((await client.account()).spaceId, otherScope.spaceId);
  } finally { client.stopWebConfirmations(); }
});
