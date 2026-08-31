import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContinue, buildNudge, decideKeepAwake, isLockedError, isStepLimitConfirmation, KeepAliveStore, KeepAwakeSupervisor, leaseState, MIN_IDLE_MS, parseConfirmationPatterns } from "../src/keep-awake.js";
import type { KeepAwakeDefaults } from "../src/keep-awake.js";
import type { ThreadSignals } from "../src/types.js";

const CONVERSATION = "22222222-2222-4222-8222-222222222222";
/** A real updated_time from a live thread, so the arithmetic in these tests is the arithmetic in production. */
const BASE = 1_788_140_086_830;
const IDLE = MIN_IDLE_MS;
const COOLDOWN = 60_000;

function signals(input: { updatedTime: number | null; serverNow: number; outcome?: { status: string; completedTime: number | null } | undefined; lease?: { inferenceId: string; expiration: number | null } | undefined }): ThreadSignals {
  return {
    threadId: CONVERSATION,
    updatedTime: input.updatedTime,
    serverNow: input.serverNow,
    messageCount: 11,
    credits: null,
    currentInferenceId: input.lease?.inferenceId ?? "",
    leaseExpiration: input.lease?.expiration ?? null,
    lastTurnOutcome: input.outcome
      ? { status: input.outcome.status, completedTime: input.outcome.completedTime, stepCount: 35, inferenceId: "inference-1", finalStepId: "step-1" }
      : null
  };
}

function decide(input: {
  now: number;
  signals: ThreadSignals | null;
  anchorTime?: number;
  lastNudgeAt?: number | null;
  nudgeCount?: number;
  maxNudges?: number;
  deadlineAt?: number;
  awaitingConfirmation?: boolean;
  continueCount?: number;
  maxContinues?: number;
  lastContinueAt?: number | null;
}) {
  return decideKeepAwake({
    now: input.now,
    anchorTime: input.anchorTime ?? BASE,
    signals: input.signals,
    lastNudgeAt: input.lastNudgeAt ?? null,
    nudgeCount: input.nudgeCount ?? 0,
    idleMs: IDLE,
    cooldownMs: COOLDOWN,
    maxNudges: input.maxNudges ?? 40,
    deadlineAt: input.deadlineAt ?? BASE + 3_600_000,
    awaitingConfirmation: input.awaitingConfirmation ?? false,
    continueCount: input.continueCount ?? 0,
    maxContinues: input.maxContinues ?? 10,
    lastContinueAt: input.lastContinueAt ?? null
  });
}

test("a heartbeat inside the idle window is left alone", () => {
  // Healthy turns really do go quiet for 10-20s between steps, so this must not count as a stall.
  const decision = decide({ now: BASE + 40_000, signals: signals({ updatedTime: BASE + 20_000, serverNow: BASE + 40_000 }) });
  assert.deepEqual(decision, { action: "wait", reason: "healthy" });
});

test("a heartbeat frozen past the idle window is nudged", () => {
  const decision = decide({ now: BASE + 200_000, signals: signals({ updatedTime: BASE, serverNow: BASE + 200_000 }) });
  assert.equal(decision.action, "nudge");
  assert.equal(decision.action === "nudge" ? decision.idleMs : 0, 200_000);
});

test("a turn that closed at or after the anchor stops the watchdog instead of nudging it", () => {
  // The heartbeat is frozen for far longer than the idle window, but the freeze is the AI waiting for
  // the user. Without this rule the watchdog would nudge a finished chat forever.
  const decision = decide({
    now: BASE + 600_000,
    signals: signals({ updatedTime: BASE + 5_000, serverNow: BASE + 600_000, outcome: { status: "completed", completedTime: BASE + 5_000 } })
  });
  assert.deepEqual(decision, { action: "stop", reason: "turn_completed" });
});

test("an outcome left over from the previous turn does not stop the watchdog", () => {
  // last_turn_outcome keeps only the newest closed turn, so a stale completion is exactly what a
  // turn that died mid-flight looks like. Measured on a live thread: updated_time moved 17.8 minutes
  // past completed_time while the turn was still running.
  const decision = decide({
    now: BASE + 200_000,
    anchorTime: BASE,
    signals: signals({ updatedTime: BASE, serverNow: BASE + 200_000, outcome: { status: "completed", completedTime: BASE - 1_066_668 } })
  });
  assert.equal(decision.action, "nudge");
});

test("an outcome that is not completed never counts as a clean finish", () => {
  const decision = decide({
    now: BASE + 200_000,
    signals: signals({ updatedTime: BASE, serverNow: BASE + 200_000, outcome: { status: "failed", completedTime: BASE + 5_000 } })
  });
  assert.equal(decision.action, "nudge");
});

test("the cooldown suppresses back-to-back nudges", () => {
  const decision = decide({
    now: BASE + 200_000,
    lastNudgeAt: BASE + 180_000,
    nudgeCount: 1,
    signals: signals({ updatedTime: BASE, serverNow: BASE + 200_000 })
  });
  assert.deepEqual(decision, { action: "wait", reason: "cooldown" });
});

test("the nudge budget and the deadline both stop the watchdog", () => {
  const exhausted = decide({ now: BASE + 200_000, nudgeCount: 3, maxNudges: 3, signals: signals({ updatedTime: BASE, serverNow: BASE + 200_000 }) });
  assert.deepEqual(exhausted, { action: "stop", reason: "max_nudges" });
  const expired = decide({ now: BASE + 4_000_000, deadlineAt: BASE + 3_600_000, signals: null });
  assert.deepEqual(expired, { action: "stop", reason: "deadline" });
});

test("a read that failed is never treated as silence", () => {
  assert.deepEqual(decide({ now: BASE + 600_000, signals: null }), { action: "wait", reason: "signals_unavailable" });
  assert.deepEqual(
    decide({ now: BASE + 600_000, signals: signals({ updatedTime: null, serverNow: BASE + 600_000 }) }),
    { action: "wait", reason: "signals_unavailable" }
  );
});

test("the nudge text carries the counter, the done token and no question for the user", () => {
  const first = buildNudge({ nudgeCount: 1, maxNudges: 40, idleMs: 150_000, language: "ja", doneToken: "DONE::KA-7f3a" });
  assert.match(first, /\[KEEP-AWAKE 1\/40\]/);
  assert.match(first, /DONE::KA-7f3a/);
  const stalled = buildNudge({ nudgeCount: 4, maxNudges: 40, idleMs: 150_000, language: "en" });
  assert.match(stalled, /STALLED/);
  assert.match(stalled, /Never ask the user/);
  const last = buildNudge({ nudgeCount: 40, maxNudges: 40, idleMs: 150_000, language: "en" });
  assert.match(last, /FINAL/);
  const custom = buildNudge({ nudgeCount: 2, maxNudges: 9, idleMs: 1_000, language: "ja", custom: "resume the build" });
  assert.equal(custom, "[KEEP-AWAKE 2/9] resume the build");
});

const DEFAULTS: KeepAwakeDefaults = { interrupt: false, idleMs: IDLE, pollMs: 30_000, cooldownMs: COOLDOWN, maxNudges: 3, deadlineMs: 3_600_000, enabled: true };

function harness(initial: ThreadSignals) {
  let current = initial;
  let clock = initial.serverNow;
  const sent: string[] = [];
  const store = new KeepAliveStore(null);
  const supervisor = new KeepAwakeSupervisor(store, {
    readSignals: async () => current,
    sendNudge: async (_conversationId, prompt) => { sent.push(prompt); },
    now: () => clock
  }, DEFAULTS);
  return {
    supervisor,
    sent,
    advance(next: ThreadSignals): void { current = next; clock = next.serverNow; }
  };
}

test("the supervisor nudges a dead turn once per cooldown and stops when the turn closes", async () => {
  const box = harness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION, doneToken: "DONE::KA-1" });
  assert.equal(record.status, "watching");
  assert.equal(record.anchorTime, BASE);

  box.advance(signals({ updatedTime: BASE + 25_000, serverNow: BASE + 40_000 }));
  assert.equal((await box.supervisor.tick(record.keepAliveId)).decision.action, "wait");
  assert.equal(box.sent.length, 0);

  box.advance(signals({ updatedTime: BASE + 25_000, serverNow: BASE + 200_000 }));
  assert.equal((await box.supervisor.tick(record.keepAliveId)).decision.action, "nudge");
  assert.equal(box.sent.length, 1);
  assert.match(box.sent[0] ?? "", /\[KEEP-AWAKE 1\/3\]/);
  assert.match(box.sent[0] ?? "", /DONE::KA-1/);

  box.advance(signals({ updatedTime: BASE + 25_000, serverNow: BASE + 210_000 }));
  assert.equal((await box.supervisor.tick(record.keepAliveId)).decision.action, "wait");
  assert.equal(box.sent.length, 1);

  // The nudge landed and the resumed turn closed cleanly. The heartbeat is stale again, so only the
  // outcome check can tell this apart from another stall.
  box.advance(signals({ updatedTime: BASE + 380_000, serverNow: BASE + 600_000, outcome: { status: "completed", completedTime: BASE + 380_000 } }));
  const closed = await box.supervisor.tick(record.keepAliveId);
  assert.equal(closed.decision.action, "stop");
  assert.equal(closed.keepAlive?.status, "completed");
  assert.equal(closed.keepAlive?.stopReason, "turn_completed");
  assert.equal(box.sent.length, 1);
  box.supervisor.stopAll();
});

test("a kick re-anchors the watchdog and clears the cooldown", async () => {
  const box = harness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + 200_000 }));
  await box.supervisor.tick(record.keepAliveId);
  assert.equal(box.sent.length, 1);

  box.advance(signals({ updatedTime: BASE + 300_000, serverNow: BASE + 300_000 }));
  const kicked = await box.supervisor.kick(record.keepAliveId);
  assert.equal(kicked?.anchorTime, BASE + 300_000);
  assert.equal(kicked?.lastNudgeAt, undefined);

  // A completion from before the new anchor must no longer end the watch.
  box.advance(signals({ updatedTime: BASE + 300_000, serverNow: BASE + 500_000, outcome: { status: "completed", completedTime: BASE + 100_000 } }));
  assert.equal((await box.supervisor.tick(record.keepAliveId)).decision.action, "nudge");
  assert.equal(box.sent.length, 2);
  box.supervisor.stopAll();
});

test("starting twice on one conversation reuses the live watchdog", async () => {
  const box = harness(signals({ updatedTime: BASE, serverNow: BASE }));
  const first = await box.supervisor.start({ conversationId: CONVERSATION });
  const second = await box.supervisor.start({ conversationId: CONVERSATION });
  assert.equal(second.keepAliveId, first.keepAliveId);
  assert.equal(box.supervisor.list({ status: "watching" }).length, 1);
  box.supervisor.stopAll();
});

test("a watchdog is persisted and a live one is orphaned after a restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "notion-ai-mcp-keepalive-"));
  try {
    const path = join(directory, "keep-alives.json");
    const store = new KeepAliveStore(path);
    const created = store.create({
      conversationId: CONVERSATION,
      anchorTime: BASE,
      createdAt: BASE,
      deadlineAt: BASE + 3_600_000,
      idleMs: IDLE,
      pollMs: 30_000,
      cooldownMs: COOLDOWN,
      maxNudges: 5,
      language: "ja",
      doneToken: "DONE::KA-2"
    });
    assert.equal(created.status, "watching");
    const reloaded = new KeepAliveStore(path).get(created.keepAliveId);
    assert.equal(reloaded?.status, "orphaned");
    assert.equal(reloaded?.doneToken, "DONE::KA-2");
    assert.equal(reloaded?.anchorTime, BASE);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

/**
 * A harness whose runtime can clear a lease and can refuse the first send the way Notion does for a
 * thread that is still leased: HTTP 200 with an empty stream, surfaced as an error by the client.
 */
function interruptHarness(initial: ThreadSignals, options: { failFirstSend?: boolean; interruptEnabled?: boolean } = {}) {
  let current = initial;
  let clock = initial.serverNow;
  const sent: string[] = [];
  const interrupted: string[] = [];
  let sends = 0;
  const store = new KeepAliveStore(null);
  const supervisor = new KeepAwakeSupervisor(store, {
    readSignals: async () => current,
    sendNudge: async (_conversationId, prompt) => {
      sends += 1;
      if (options.failFirstSend && sends === 1) {
        throw new Error("Notion AI streamed no answer text (workspace w; stream events: no events). Notion rejected the resumed thread state because the thread still holds an inference lease.");
      }
      sent.push(prompt);
    },
    interrupt: async (conversationId) => { interrupted.push(conversationId); return true; },
    now: () => clock
  }, { ...DEFAULTS, interrupt: options.interruptEnabled !== false });
  return {
    supervisor,
    sent,
    interrupted,
    advance(next: ThreadSignals): void { current = next; clock = next.serverNow; }
  };
}

test("the lease is read from the thread record rather than guessed from the heartbeat", () => {
  // current_inference_id is first-hand evidence that a turn is still checked out, which the heartbeat
  // alone cannot tell apart from a turn that died.
  const at = { updatedTime: BASE, serverNow: BASE + 200_000 };
  assert.equal(leaseState(signals(at)), "free");
  assert.equal(leaseState(signals({ ...at, lease: { inferenceId: "inference-9", expiration: null } })), "held");
  assert.equal(leaseState(signals({ ...at, lease: { inferenceId: "inference-9", expiration: BASE + 300_000 } })), "held");
  assert.equal(leaseState(signals({ ...at, lease: { inferenceId: "inference-9", expiration: BASE + 100_000 } })), "stale");
});

test("the empty-stream refusal Notion returns for a leased thread is recognised", () => {
  assert.equal(isLockedError("Notion AI streamed no answer text (workspace w; stream events: no events)."), true);
  assert.equal(isLockedError("Notion rejected the resumed thread state because the thread still holds an inference lease."), true);
  assert.equal(isLockedError("fetch failed"), false);
});

test("a stalled turn that still holds its lease is interrupted before the nudge is sent", async () => {
  const box = interruptHarness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + 200_000, lease: { inferenceId: "inference-9", expiration: null } }));
  const outcome = await box.supervisor.tick(record.keepAliveId);
  assert.equal(outcome.decision.action, "nudge");
  assert.deepEqual(box.interrupted, [CONVERSATION]);
  assert.equal(box.sent.length, 1);
  assert.equal(outcome.keepAlive?.nudgeCount, 1);
  box.supervisor.stopAll();
});

test("a stalled turn whose lease is already gone is nudged without an interrupt", async () => {
  const box = interruptHarness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + 200_000 }));
  await box.supervisor.tick(record.keepAliveId);
  assert.deepEqual(box.interrupted, []);
  assert.equal(box.sent.length, 1);
  box.supervisor.stopAll();
});

test("a nudge refused as an empty stream is retried once behind an interrupt", async () => {
  // The lease can be taken between the read and the send, and a refused nudge writes no step, so the
  // retry cannot duplicate work.
  const box = interruptHarness(signals({ updatedTime: BASE, serverNow: BASE }), { failFirstSend: true });
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + 200_000 }));
  const outcome = await box.supervisor.tick(record.keepAliveId);
  assert.deepEqual(box.interrupted, [CONVERSATION]);
  assert.equal(box.sent.length, 1);
  assert.equal(outcome.keepAlive?.nudgeCount, 1);
  box.supervisor.stopAll();
});

test("interrupting can be switched off, and a refused nudge keeps its budget", async () => {
  const box = interruptHarness(signals({ updatedTime: BASE, serverNow: BASE }), { failFirstSend: true, interruptEnabled: false });
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + 200_000, lease: { inferenceId: "inference-9", expiration: null } }));
  const outcome = await box.supervisor.tick(record.keepAliveId);
  assert.deepEqual(box.interrupted, []);
  assert.equal(box.sent.length, 0);
  assert.equal(outcome.keepAlive?.nudgeCount, 0);
  assert.match(outcome.keepAlive?.lastError ?? "", /no events/);
  box.supervisor.stopAll();
});

test("resume adopts watchdogs orphaned by a restart and expires the ones whose deadline passed", () => {
  const directory = mkdtempSync(join(tmpdir(), "keep-awake-resume-"));
  const file = join(directory, "keep-alives.json");
  const now = Date.now();
  const entry = (keepAliveId: string, deadlineAt: number): Record<string, unknown> => ({
    keepAliveId,
    conversationId: CONVERSATION,
    status: "watching",
    anchorTime: now,
    createdAt: now,
    deadlineAt,
    idleMs: IDLE,
    pollMs: 30_000,
    cooldownMs: COOLDOWN,
    maxNudges: 4,
    nudgeCount: 0,
    language: "ja"
  });
  try {
    writeFileSync(file, JSON.stringify({ version: 1, keepAlives: [entry("alive", now + 3_600_000), entry("late", now - 1)] }));
    const store = new KeepAliveStore(file);
    // A registry a dead process left behind must never claim its watchdogs are still polling.
    assert.equal(store.get("alive")?.status, "orphaned");
    const defaults: KeepAwakeDefaults = { interrupt: false, idleMs: IDLE, pollMs: 30_000, cooldownMs: COOLDOWN, maxNudges: 4, deadlineMs: 3_600_000, enabled: true };
    const supervisor = new KeepAwakeSupervisor(store, {
      readSignals: async () => { throw new Error("resume must not read the thread"); },
      sendNudge: async () => { throw new Error("resume must not nudge"); },
      now: () => now
    }, defaults);
    assert.deepEqual(supervisor.resume().map((record) => record.keepAliveId), ["alive"]);
    assert.equal(store.get("alive")?.status, "watching");
    assert.equal(store.get("late")?.status, "expired");
    // Resuming twice must not hand the same watchdog to a second polling loop.
    assert.deepEqual(supervisor.resume(), []);
    supervisor.stopAll();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The exact prompt Notion shows when a long agent turn asks permission to spend more steps. */
const STEP_LIMIT_PROMPT = "This task is taking a lot of steps. Please confirm you want the agent to keep going.";
/** DEFAULTS plus the confirmation settings, so the continue path runs on the shipped numbers. */
const CONTINUE_DEFAULTS: KeepAwakeDefaults = { ...DEFAULTS, autoContinue: true, maxContinues: 2, continueCooldownMs: 15_000, confirmGraceMs: 10_000 };

/** A harness whose runtime can also hand back the newest user-visible text, like the real client. */
function continueHarness(initial: ThreadSignals) {
  let current = initial;
  let clock = initial.serverNow;
  let tail = "";
  const sent: string[] = [];
  const store = new KeepAliveStore(null);
  const supervisor = new KeepAwakeSupervisor(store, {
    readSignals: async () => current,
    sendNudge: async (_conversationId, prompt) => { sent.push(prompt); },
    readTail: async () => tail,
    now: () => clock
  }, CONTINUE_DEFAULTS);
  return {
    supervisor,
    sent,
    setTail(next: string): void { tail = next; },
    advance(next: ThreadSignals): void { current = next; clock = next.serverNow; }
  };
}

test("the step-limit prompt is recognised and ordinary answers are not", () => {
  assert.equal(isStepLimitConfirmation(STEP_LIMIT_PROMPT), true);
  assert.equal(isStepLimitConfirmation("23件目: 改善 / 50件\n\nこのタスクはステップ数が多くなっています。続行を承認してください。"), true);
  // A finished answer that merely talks about steps must not be mistaken for the prompt.
  assert.equal(isStepLimitConfirmation("Done. I searched 40 keywords in a lot of steps and wrote the summary."), false);
  assert.equal(isStepLimitConfirmation(""), false);
  // The prompt is always the tail; the same words buried under a long answer belong to an old turn.
  assert.equal(isStepLimitConfirmation(`${STEP_LIMIT_PROMPT}\n\n${"x".repeat(500)}`), false);
  assert.equal(isStepLimitConfirmation("Shall I proceed with the rollout?", parseConfirmationPatterns("Shall I proceed")), true);
});

test("a step-limit confirmation is answered instead of ending the watch", () => {
  // Notion closes the turn when it asks, which without this rule reads exactly like a clean finish.
  const decision = decide({
    now: BASE + 60_000,
    signals: signals({ updatedTime: BASE + 20_000, serverNow: BASE + 60_000, outcome: { status: "completed", completedTime: BASE + 20_000 } }),
    awaitingConfirmation: true
  });
  assert.deepEqual(decision, { action: "continue", reason: "awaiting_confirmation" });
});

test("the confirmation answer waits out a grace window, its own cooldown and its own budget", () => {
  const fresh = decide({ now: BASE + 5_000, signals: signals({ updatedTime: BASE + 2_000, serverNow: BASE + 5_000 }), awaitingConfirmation: true });
  assert.deepEqual(fresh, { action: "wait", reason: "confirm_grace" });
  const cooling = decide({ now: BASE + 60_000, signals: signals({ updatedTime: BASE, serverNow: BASE + 60_000 }), awaitingConfirmation: true, lastContinueAt: BASE + 55_000 });
  assert.deepEqual(cooling, { action: "wait", reason: "cooldown" });
  const spent = decide({ now: BASE + 60_000, signals: signals({ updatedTime: BASE, serverNow: BASE + 60_000 }), awaitingConfirmation: true, continueCount: 2, maxContinues: 2 });
  assert.deepEqual(spent, { action: "stop", reason: "max_continues" });
});

test("the continue text confirms and nothing else", () => {
  const ja = buildContinue({ continueCount: 1, maxContinues: 10, language: "ja", doneToken: "DONE::KA-9" });
  assert.match(ja, /\[KEEP-AWAKE CONTINUE 1\/10\]/);
  assert.match(ja, /DONE::KA-9/);
  const en = buildContinue({ continueCount: 3, maxContinues: 3, language: "en" });
  assert.match(en, /\[KEEP-AWAKE CONTINUE 3\/3\] Continue\./);
  assert.doesNotMatch(en, /nudge/i);
});

test("the supervisor answers the prompt and keeps its nudge budget intact", async () => {
  const box = continueHarness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION, doneToken: "DONE::KA-9" });
  box.setTail(STEP_LIMIT_PROMPT);
  box.advance(signals({ updatedTime: BASE + 20_000, serverNow: BASE + 40_000, outcome: { status: "completed", completedTime: BASE + 20_000 } }));
  const answered = await box.supervisor.tick(record.keepAliveId);
  assert.equal(answered.decision.action, "continue");
  assert.equal(answered.keepAlive?.status, "watching");
  assert.equal(answered.keepAlive?.continueCount, 1);
  assert.equal(answered.keepAlive?.nudgeCount, 0);
  assert.match(box.sent[0] ?? "", /\[KEEP-AWAKE CONTINUE 1\/2\]/);

  // Once the resumed turn closes for real, the ordinary completion rule ends the watch.
  box.setTail("40件目: まとめ / 50件。以上で全て完了です。");
  box.advance(signals({ updatedTime: BASE + 300_000, serverNow: BASE + 400_000, outcome: { status: "completed", completedTime: BASE + 300_000 } }));
  const closed = await box.supervisor.tick(record.keepAliveId);
  assert.equal(closed.decision.action, "stop");
  assert.equal(closed.keepAlive?.stopReason, "turn_completed");
  assert.equal(box.sent.length, 1);
  box.supervisor.stopAll();
});

test("auto-continue can be switched off per watchdog", async () => {
  const box = continueHarness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION, autoContinue: false });
  box.setTail(STEP_LIMIT_PROMPT);
  box.advance(signals({ updatedTime: BASE + 20_000, serverNow: BASE + 40_000, outcome: { status: "completed", completedTime: BASE + 20_000 } }));
  const outcome = await box.supervisor.tick(record.keepAliveId);
  assert.equal(outcome.decision.action, "stop");
  assert.equal(outcome.keepAlive?.stopReason, "turn_completed");
  assert.equal(box.sent.length, 0);
  box.supervisor.stopAll();
});

test("a stall with no confirmation prompt still gets the ordinary nudge", async () => {
  // The button and its prompt always arrive together, so text that is not the prompt means there is
  // no button: the four ordinary signals decide alone and a frozen turn is nudged as before.
  const box = continueHarness(signals({ updatedTime: BASE, serverNow: BASE }));
  const record = await box.supervisor.start({ conversationId: CONVERSATION });
  box.setTail("31\u4ef6\u76ee: \u30c9\u30ad\u30e5\u30e1\u30f3\u30c8 / 50\u4ef6");
  box.advance(signals({ updatedTime: BASE, serverNow: BASE + IDLE + 30_000 }));
  const nudged = await box.supervisor.tick(record.keepAliveId);
  assert.equal(nudged.decision.action, "nudge");
  assert.equal(nudged.keepAlive?.nudgeCount, 1);
  assert.equal(nudged.keepAlive?.continueCount, 0);
  assert.match(box.sent[0] ?? "", /\[KEEP-AWAKE 1\/3\]/);
  box.supervisor.stopAll();
});
