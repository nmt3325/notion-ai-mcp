import assert from "node:assert/strict";
import test from "node:test";
import {
  KeepAliveStore,
  KeepAwakeSupervisor,
  isStepLimitConfirmation,
  isUnfinishedFinalStep,
} from "../src/keep-awake.js";
import type { KeepAwakeRuntime } from "../src/keep-awake.js";
import type { FinalStepShape, ThreadSignals } from "../src/types.js";
const BASE = Date.now();
const ID = "22222222-2222-4222-8222-222222222222";
const defaults = {
  enabled: true,
  interrupt: false,
  autoContinue: true,
  idleMs: 120000,
  pollMs: 3600000,
  cooldownMs: 60000,
  maxNudges: 4,
  deadlineMs: 3600000,
};
const signal = (extra: Partial<ThreadSignals> = {}): ThreadSignals => ({
  threadId: ID,
  updatedTime: BASE,
  serverNow: BASE,
  messageCount: 4,
  lastTurnOutcome: null,
  credits: null,
  currentInferenceId: "",
  leaseExpiration: null,
  ...extra,
});
const closed = (extra: Partial<ThreadSignals> = {}): ThreadSignals =>
  signal({
    updatedTime: BASE + 1000,
    serverNow: BASE + 200000,
    lastTurnOutcome: {
      status: "completed",
      completedTime: BASE + 1000,
      stepCount: 35,
      inferenceId: "i",
      finalStepId: "s",
    },
    ...extra,
  });
const answer: FinalStepShape = {
  stepId: "s",
  type: "agent-inference",
  state: "",
  hasAnswerText: true,
  finishedAt: BASE + 1000,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function box(extra: Partial<KeepAwakeRuntime> = {}) {
  let current = signal();
  const sent: string[] = [];
  const supervisor = new KeepAwakeSupervisor(
    new KeepAliveStore(null),
    {
      readSignals: async () => current,
      sendNudge: async (_, p) => {
        sent.push(p);
      },
      ...extra,
    },
    defaults,
  );
  return {
    supervisor,
    sent,
    set: (s: ThreadSignals) => {
      current = s;
    },
  };
}

test("concurrent starts reuse a single watcher", async () => {
  const gate = deferred();
  const b = box({
    readSignals: async () => {
      await gate.promise;
      return signal();
    },
  });
  try {
    const a = b.supervisor.start({ conversationId: ID }),
      c = b.supervisor.start({ conversationId: ID });
    gate.resolve();
    const [x, y] = await Promise.all([a, c]);
    assert.equal(x.keepAliveId, y.keepAliveId);
    assert.equal(b.supervisor.list().length, 1);
  } finally {
    b.supervisor.stopAll();
  }
});
test("timer and manual checks share a single delivery", async () => {
  const gate = deferred();
  let paused = false;
  const b = box({
    readSignals: async () => {
      if (paused) await gate.promise;
      return signal({ serverNow: paused ? BASE + 200000 : BASE });
    },
  });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    paused = true;
    const a = b.supervisor.tick(w.keepAliveId),
      c = b.supervisor.tick(w.keepAliveId);
    gate.resolve();
    await Promise.all([a, c]);
    assert.equal(b.sent.length, 1);
    assert.equal(b.supervisor.list()[0]?.nudgeCount, 1);
  } finally {
    b.supervisor.stopAll();
  }
});
test("stopping during a read prevents a late nudge", async () => {
  const gate = deferred();
  let paused = false;
  const b = box({
    readSignals: async () => {
      if (paused) await gate.promise;
      return signal({ serverNow: paused ? BASE + 200000 : BASE });
    },
  });
  const w = await b.supervisor.start({ conversationId: ID });
  paused = true;
  const checking = b.supervisor.tick(w.keepAliveId);
  b.supervisor.stop(w.keepAliveId);
  gate.resolve();
  await checking;
  assert.equal(b.sent.length, 0);
  assert.equal(b.supervisor.list()[0]?.status, "stopped");
});
for (const mode of ["missing", "failed"]) {
  test(`a ${mode} final-step read is not a confirmed completion`, async () => {
    const b = box({
      readFinalStep: async () => {
        if (mode === "failed") throw new Error("temporary read error");
        return null;
      },
    });
    try {
      const w = await b.supervisor.start({ conversationId: ID });
      b.set(closed());
      const r = await b.supervisor.tick(w.keepAliveId);
      assert.equal(r.decision.action, "wait");
      assert.equal(r.keepAlive?.status, "watching");
      assert.equal(b.sent.length, 0);
    } finally {
      b.supervisor.stopAll();
    }
  });
}
test("autoContinue=false still nudges an ordinary unfinished stop", async () => {
  const b = box({
    readFinalStep: async () => ({
      ...answer,
      type: "agent-tool-result",
      state: "streaming",
      hasAnswerText: false,
      finishedAt: null,
    }),
  });
  try {
    const w = await b.supervisor.start({
      conversationId: ID,
      autoContinue: false,
    });
    b.set(closed());
    const r = await b.supervisor.tick(w.keepAliveId);
    assert.equal(r.decision.action, "nudge");
    assert.equal(r.keepAlive?.nudgeCount, 1);
  } finally {
    b.supervisor.stopAll();
  }
});
test("a newer user message supersedes a stale completion", async () => {
  const b = box({ readFinalStep: async () => answer });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    b.set(
      closed({
        updatedTime: BASE + 50000,
        lastUserMessageTime: BASE + 50000,
      } as Partial<ThreadSignals>),
    );
    const r = await b.supervisor.tick(w.keepAliveId);
    assert.equal(r.decision.action, "nudge");
    assert.equal(r.keepAlive?.status, "watching");
  } finally {
    b.supervisor.stopAll();
  }
});
test("an active newer inference cannot be closed by an older outcome", async () => {
  const b = box({ readFinalStep: async () => answer });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    b.set(
      closed({
        updatedTime: BASE + 199000,
        currentInferenceId: "new-inference",
      }),
    );
    assert.equal(
      (await b.supervisor.tick(w.keepAliveId)).decision.action,
      "wait",
    );
    assert.equal(b.supervisor.list()[0]?.status, "watching");
  } finally {
    b.supervisor.stopAll();
  }
});
test("successful delivery reanchors to the accepted user step", async () => {
  const b = box({ sendNudge: async () => ({ acceptedAt: BASE + 200500 }) });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    b.set(signal({ serverNow: BASE + 200000 }));
    const r = await b.supervisor.tick(w.keepAliveId);
    assert.equal(r.keepAlive?.anchorTime, BASE + 200500);
    assert.equal(r.keepAlive?.lastNudgeAt, BASE + 200500);
  } finally {
    b.supervisor.stopAll();
  }
});
test("tool-use commentary is not a terminal answer", () => {
  assert.equal(
    isUnfinishedFinalStep({ ...answer, hasToolUse: true } as FinalStepShape),
    true,
  );
  assert.equal(
    isUnfinishedFinalStep({ ...answer, state: "streaming", finishedAt: null }),
    true,
  );
  assert.equal(isUnfinishedFinalStep(answer), false);
});
test("ordinary approval questions are not step-limit confirmations", () => {
  for (const text of [
    "続行しますか？",
    "この共有設定で続行してよろしいですか？",
    "Should I keep going?",
    "These steps describe how to keep going?",
    "ステップ1を終えました。続行しますか？",
  ])
    assert.equal(isStepLimitConfirmation(text), false, text);
  assert.equal(
    isStepLimitConfirmation(
      "This task is taking a lot of steps. Please confirm you want the agent to keep going.",
    ),
    true,
  );
});

test("fresh heartbeat during the final-step probe prevents an obsolete nudge", async () => {
  const b = box({
    readFinalStep: async () => {
      b.set(
        signal({
          updatedTime: BASE + 200000,
          serverNow: BASE + 200000,
          currentInferenceId: "resumed",
        }),
      );
      return {
        ...answer,
        type: "agent-tool-result",
        state: "streaming",
        hasAnswerText: false,
        finishedAt: null,
      };
    },
  });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    b.set(closed());
    assert.equal(
      (await b.supervisor.tick(w.keepAliveId)).decision.action,
      "wait",
    );
    assert.equal(b.sent.length, 0);
  } finally {
    b.supervisor.stopAll();
  }
});

test("deadline expiration during preflight prevents delivery", async () => {
  let reads = 0;
  const b = box({
    readSignals: async () =>
      signal({ serverNow: BASE + [0, 200000, 400000][Math.min(reads++, 2)]! }),
  });
  try {
    const w = await b.supervisor.start({
      conversationId: ID,
      deadlineMs: 300000,
    });
    const result = await b.supervisor.tick(w.keepAliveId);
    assert.deepEqual(result.decision, { action: "stop", reason: "deadline" });
    assert.equal(b.sent.length, 0);
  } finally {
    b.supervisor.stopAll();
  }
});

test("a pending permission is not step-limit consent even after many steps", async () => {
  const b = box({
    readFinalStep: async () => ({
      ...answer,
      type: "agent-tool-result",
      state: "pending",
      hasAnswerText: false,
      finishedAt: null,
    }),
  });
  try {
    const w = await b.supervisor.start({ conversationId: ID });
    const state = closed();
    state.lastTurnOutcome!.stepCount = 3000;
    b.set(state);
    const result = await b.supervisor.tick(w.keepAliveId);
    assert.deepEqual(result.decision, {
      action: "wait",
      reason: "awaiting_confirmation",
    });
    assert.equal(b.sent.length, 0);
  } finally {
    b.supervisor.stopAll();
  }
});
