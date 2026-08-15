import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatStateStore } from "../src/chat-jobs.js";
import type { ChatSession } from "../src/types.js";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";

function start(store: ChatStateStore, conversationId = CONVERSATION, prompt = "Hello"): string {
  return store.createJob({ conversationId, model: "mock-model", reasoningEffort: "high", prompt, turn: 1, transport: "inference_transcript" }).jobId;
}

function withStateFile(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "notion-ai-mcp-state-"));
  try { run(join(directory, "state.json")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("a job records the prompt, then settles as completed or failed", () => {
  const store = new ChatStateStore(null);
  const jobId = start(store);
  const running = store.job(jobId);
  assert.equal(running?.status, "running");
  assert.equal(running?.promptPreview, "Hello");
  assert.equal(running?.reasoningEffort, "high");
  assert.equal(store.list({ status: "running" }).length, 1);

  const completed = store.complete(jobId, { text: "Answer", usage: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.text, "Answer");
  assert.equal(store.latestForConversation(CONVERSATION)?.jobId, jobId);
  assert.equal(store.list({ status: "running" }).length, 0);

  const failedId = start(store, "22222222-2222-4222-8222-222222222222", "Second");
  assert.equal(store.fail(failedId, "boom")?.error, "boom");
  assert.equal(store.job(failedId)?.status, "failed");
});

test("a retargeted job follows the conversation the answer really landed in", () => {
  const store = new ChatStateStore(null);
  const jobId = start(store);
  const moved = "33333333-3333-4333-8333-333333333333";
  store.retarget(jobId, moved);
  assert.equal(store.job(jobId)?.conversationId, moved);
  assert.equal(store.latestForConversation(moved)?.jobId, jobId);
});

test("wait resolves the moment the answer arrives", async () => {
  const store = new ChatStateStore(null);
  const jobId = start(store);
  setTimeout(() => { store.complete(jobId, { text: "Late answer" }); }, 20);
  const settled = await store.wait(jobId, 5000);
  assert.equal(settled?.status, "completed");
  assert.equal(settled?.text, "Late answer");
});

test("wait hands back the running snapshot when the client budget runs out", async () => {
  const store = new ChatStateStore(null);
  const jobId = start(store);
  // wait() unrefs its timer so a shutdown is never blocked, so the test holds the loop open itself.
  const keepAlive = setInterval(() => undefined, 5);
  const pending = await store.wait(jobId, 20);
  clearInterval(keepAlive);
  assert.equal(pending?.status, "running");
  assert.equal(await store.wait("missing-job", 20), null);
  // The generation keeps running, so the answer is still collectable afterwards.
  assert.equal(store.complete(jobId, { text: "Answer" })?.status, "completed");
});

test("jobs and sessions survive a restart, and interrupted jobs become orphaned", () => {
  withStateFile((path) => {
    const first = new ChatStateStore(path);
    const finished = start(first, CONVERSATION, "Finished prompt");
    first.complete(finished, { text: "Persisted answer" });
    const interrupted = start(first, "44444444-4444-4444-8444-444444444444", "Interrupted prompt");
    const session: ChatSession = {
      threadId: CONVERSATION,
      configId: "55555555-5555-4555-8555-555555555555",
      contextId: "66666666-6666-4666-8666-666666666666",
      originalDatetime: "2026-08-15T00:00:00.000Z",
      model: "mock-model",
      reasoningEffort: "high",
      updatedConfigIds: [],
      turnCount: 2,
      transport: "inference_transcript"
    };
    first.saveSession(session);
    assert.equal(first.persistError(), null);

    const restarted = new ChatStateStore(path);
    assert.equal(restarted.job(finished)?.text, "Persisted answer");
    // A job still running when the process died can never resolve, so it must not stay "running".
    assert.equal(restarted.job(interrupted)?.status, "orphaned");
    assert.deepEqual(restarted.sessions(), [session]);
    assert.equal(restarted.statePath(), path);
  });
});

test("a store without a state file keeps everything in memory", () => {
  const store = new ChatStateStore(null);
  const jobId = start(store);
  assert.equal(store.statePath(), null);
  assert.equal(store.persistError(), null);
  assert.equal(store.job(jobId)?.status, "running");
});
