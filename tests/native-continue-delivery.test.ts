import assert from "node:assert/strict";
import test from "node:test";
import { NotionClient } from "../src/notion-client.js";
import { createKeepAwakeSupervisor } from "../src/server.js";
import type { NotionConfig } from "../src/config.js";
const BASE = Math.floor(Date.now() / 1000) * 1000;
type Mode = "seed" | "accepted" | "pending" | "empty" | "finished";
async function fixture() {
  let mode: Mode = "seed", now = BASE, failReads = false, reads = 0;
  const requests: any[] = [], records: Record<string, any> = {}, controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const thread: any = { messages: [], updated_time: BASE, current_inference_id: null, data: {} };
  const put = (step: any) => { records[step.id] = { id: step.id, step, created_time: BASE }; if (!thread.messages.includes(step.id)) thread.messages.push(step.id); };
  const accept = () => { thread.current_inference_id = requests.at(-1).traceId; thread.updated_time = BASE + 200500; };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", date: new Date(now).toUTCString() } });
  const mock: typeof fetch = async (input, init) => {
    const endpoint = String(input).split("/").at(-1), body = JSON.parse(String(init?.body));
    if (endpoint === "runInferenceTranscript") {
      thread.id = body.threadId;
      if (mode === "seed") {
        for (const step of body.transcript) put(step);
        return new Response(JSON.stringify({ type: "agent-inference", id: "answer", value: [{ type: "text", content: "Ready" }], finishedAt: BASE }) + "\n");
      }
      requests.push(body);
      if (mode === "accepted") accept();
      if (mode === "finished") {
        thread.current_inference_id = null;
        thread.data.last_turn_outcome = { status: "completed", inference_id: body.traceId, completed_time: BASE + 201500, step_count: 4, final_step_id: "final" };
      }
      if (mode === "empty" || mode === "finished") return new Response("");
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }));
    }
    if (endpoint === "syncRecordValuesMain") {
      if (failReads) throw new Error("metadata temporarily unavailable");
      if (body.requests[0]?.pointer?.table === "thread_message") reads++;
      const maps: any = { thread: {}, thread_message: {} };
      for (const { pointer: { table, id } } of body.requests) {
        if (table === "thread") maps.thread[id] = { value: thread };
        else if (records[id]) maps.thread_message[id] = { value: records[id] };
      }
      return json({ recordMap: maps });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const client = new NotionClient({
    apiBase: ["https:", "", "example.test", "api/v3"].join("/"), defaultModel: "test-model", requestTimeoutMs: 5000,
    defaultWebSearch: false, defaultWorkspaceSearch: false, defaultReadOnly: false,
    account: { tokenV2: "test-token", userId: "11111111-1111-4111-8111-111111111111", userName: "Test", userEmail: "test@example.com", spaceId: "22222222-2222-4222-8222-222222222222", spaceName: "Test", spaceViewId: "33333333-3333-4333-8333-333333333333", timezone: "UTC", clientVersion: "test", browserId: "44444444-4444-4444-8444-444444444444", deviceId: "55555555-5555-4555-8555-555555555555" }
  } as NotionConfig, mock);
  client.keepAwakeDefaults = () => ({ enabled: true, interrupt: false, autoContinue: true, idleMs: 120000, pollMs: 3600000, cooldownMs: 60000, maxNudges: 4, deadlineMs: 3600000 });
  const initial = await client.chat({ prompt: "seed" });
  const close = (count = 100, workflowSteps = 409, state = "streaming") => {
    for (let i = 0; i < count; i++) put({ id: `iteration-${i}`, type: "agent-inference", traceId: "old-execution", value: [{ type: "tool_use" }], finishedAt: BASE });
    put({ id: "last-tool", type: "agent-tool-result", traceId: "old-execution", state });
    thread.data.last_turn_outcome = { status: "completed", inference_id: "old-execution", completed_time: BASE, step_count: workflowSteps, final_step_id: "last-tool" };
  };
  return { client, id: initial.conversationId, requests, records, thread, put, accept, close, reads: () => reads,
    mode: (value: Mode) => { mode = value; }, advance: () => { now = BASE + 200000; }, readFailure: (value: boolean) => { failReads = value; },
    cleanup: () => { for (const controller of controllers) controller.close(); }
  };
}

test("native delivery requires its own persisted trace and adds no user message", async () => {
  const f = await fixture();
  try {
    const count = f.thread.messages.length; f.mode("accepted"); f.advance();
    assert.deepEqual(await f.client.sendChatContinue(f.id, undefined, 50), { acceptedAt: BASE + 200500 });
    assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].transcript, []); assert.equal(f.requests[0].createThread, false);
    assert.equal(f.requests[0].isPartialTranscript, true); assert.equal(f.thread.messages.length, count);
    assert.equal("confirmToolStepIds" in f.requests[0], false);
  } finally { f.cleanup(); }
});
test("native delivery does not treat another execution or an enqueued job as acceptance", async () => {
  const f = await fixture();
  try {
    f.mode("pending"); f.thread.current_inference_id = "someone-else";
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 2), /not yet confirmed/);
    assert.equal(f.requests.length, 1);
    f.accept();
    await f.client.sendChatContinue(f.id, undefined, 2);
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});
test("concurrent native delivery checks share one submission", async () => {
  const f = await fixture();
  try {
    f.mode("accepted");
    const receipts = await Promise.all([f.client.sendChatContinue(f.id), f.client.sendChatContinue(f.id)]);
    assert.equal(f.requests.length, 1); assert.deepEqual(receipts[0], receipts[1]);
  } finally { f.cleanup(); }
});
test("a matching completed outcome acknowledges native delivery even if its stream is empty", async () => {
  const f = await fixture();
  try { f.mode("finished"); assert.deepEqual(await f.client.sendChatContinue(f.id, undefined, 50), { acceptedAt: BASE + 201500 }); }
  finally { f.cleanup(); }
});
test("an empty stream without a matching receipt is a rejected native delivery", async () => {
  const f = await fixture();
  try {
    f.mode("empty");
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 1000), /no answer text|rejected/);
    assert.equal(f.requests.length, 1);
    f.mode("accepted"); await f.client.sendChatContinue(f.id, undefined, 50); assert.equal(f.requests.length, 2);
  } finally { f.cleanup(); }
});
test("failed acknowledgment reads retain native identity until absence is verified", async () => {
  const f = await fixture();
  try {
    f.mode("empty"); f.readFailure(true);
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 2), /not yet confirmed/);
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 2), /not yet confirmed/);
    assert.equal(f.requests.length, 1);
    f.readFailure(false);
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 1000), /no answer text|rejected/);
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});
test("cancelled native delivery cannot enqueue a request", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  try { await assert.rejects(f.client.sendChatContinue(f.id, controller.signal), { name: "AbortError" }); assert.equal(f.requests.length, 0); }
  finally { f.cleanup(); }
});
test("native continuation state counts one turn across executions and resets on a new turn", async () => {
  const f = await fixture();
  try {
    f.close(99); assert.equal(await f.client.nativeContinuationState(f.id), false);
    f.put({ id: "resumed-iteration", type: "agent-inference", traceId: "resumed-execution", value: [{ type: "tool_use" }] });
    assert.equal(await f.client.nativeContinuationState(f.id), true);
    f.put({ id: "next-user-turn", type: "user", value: [["a new instruction"]] });
    f.put({ id: "fresh-iteration", type: "agent-inference", traceId: "fresh-execution", value: [{ type: "tool_use" }] });
    assert.equal(await f.client.nativeContinuationState(f.id), false);
  } finally { f.cleanup(); }
});
test("production watchdog uses native Continue below the legacy 2000-effect threshold", async () => {
  const f = await fixture(); f.close(); f.mode("accepted"); const supervisor = createKeepAwakeSupervisor(f.client);
  try {
    const watch = await supervisor.start({ conversationId: f.id }); f.advance();
    const result = await supervisor.tick(watch.keepAliveId);
    assert.equal(result.decision.action, "continue"); assert.equal(result.keepAlive?.continueCount, 1); assert.equal(result.keepAlive?.nudgeCount, 0);
    assert.equal(result.keepAlive?.anchorTime, BASE + 200500); assert.deepEqual(f.requests[0].transcript, []);
  } finally { supervisor.stopAll(); f.cleanup(); }
});
test("native rejection does not burn the production Continue budget", async () => {
  const f = await fixture(); f.close(); f.mode("empty"); const supervisor = createKeepAwakeSupervisor(f.client);
  try {
    const watch = await supervisor.start({ conversationId: f.id }); f.advance(); const result = await supervisor.tick(watch.keepAliveId);
    assert.equal(result.decision.action, "continue"); assert.equal(result.keepAlive?.continueCount, 0); assert.equal(result.keepAlive?.nudgeCount, 0);
    assert.match(result.keepAlive?.lastError ?? "", /no answer text|rejected/);
  } finally { supervisor.stopAll(); f.cleanup(); }
});
for (const condition of ["disabled", "permission"] as const) test(`native ${condition} confirmation is not automatically approved`, async () => {
  const f = await fixture(); f.close(100, 409, condition === "permission" ? "awaiting_permission" : "streaming"); f.mode("accepted");
  const supervisor = createKeepAwakeSupervisor(f.client);
  try {
    const watch = await supervisor.start({ conversationId: f.id, autoContinue: condition !== "disabled" }); f.advance();
    const result = await supervisor.tick(watch.keepAliveId); assert.equal(result.decision.action, "wait"); assert.equal(f.requests.length, 0);
    assert.equal(result.keepAlive?.status, "watching");
  } finally { supervisor.stopAll(); f.cleanup(); }
});
test("a below-limit native run overrides an inflated legacy workflow count", async () => {
  const f = await fixture(); f.close(99, 4000); let nudges = 0;
  f.client.sendChatNudge = async () => { nudges++; return { acceptedAt: BASE + 200500 }; };
  const supervisor = createKeepAwakeSupervisor(f.client);
  try {
    const watch = await supervisor.start({ conversationId: f.id }); f.advance(); const result = await supervisor.tick(watch.keepAliveId);
    assert.equal(result.decision.action, "nudge"); assert.equal(nudges, 1); assert.equal(f.requests.length, 0);
  } finally { supervisor.stopAll(); f.cleanup(); }
});
test("native Continue rejects new threads and attachments before any inference request", async () => {
  const f = await fixture();
  try {
    f.mode("accepted");
    await assert.rejects(f.client.chat({ prompt: "unused", _continueTraceId: "trace" }), /existing thread/);
    await assert.rejects(f.client.chat({ prompt: "unused", conversationId: f.id, _continueTraceId: "trace", attachments: [{ name: "extra", url: "attachment:test" }] } as any), /without new attachments/);
    assert.equal(f.requests.length, 0);
  } finally { f.cleanup(); }
});
test("native Continue does not fall through to the unverified Agent Service transport", async () => {
  const f = await fixture();
  try {
    (f.client as any).sessions.get(f.id).transport = "agent_service";
    f.mode("accepted");
    await assert.rejects(f.client.sendChatContinue(f.id, undefined, 1000), /only supported for inference-transcript/);
    assert.equal(f.requests.length, 0);
  } finally { f.cleanup(); }
});
test("native evidence stops reading once the turn cannot be under the limit", async () => {
  const f = await fixture();
  try {
    f.close(300);
    const before = f.reads();
    assert.equal(await f.client.nativeContinuationState(f.id), true);
    const used = f.reads() - before;
    assert.ok(used <= 3, `expected a bounded scan, used ${used} reads`);
  } finally { f.cleanup(); }
});
