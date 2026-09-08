import assert from "node:assert/strict";
import test from "node:test";
import { NotionClient } from "../src/notion-client.js";
import { createKeepAwakeSupervisor } from "../src/server.js";
import type { NotionConfig } from "../src/config.js";
const BASE = Math.floor(Date.now() / 1000) * 1000;
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
const account = {
  tokenV2: "test-token",
  userId: "11111111-1111-4111-8111-111111111111",
  userName: "Test",
  userEmail: "test@example.com",
  spaceId: "22222222-2222-4222-8222-222222222222",
  spaceName: "Test",
  spaceViewId: "33333333-3333-4333-8333-333333333333",
  timezone: "UTC",
  clientVersion: "test",
  browserId: "44444444-4444-4444-8444-444444444444",
  deviceId: "55555555-5555-4555-8555-555555555555",
};
type Mode = "seed" | "locked" | "http-error" | "accepted" | "pending";
async function fixture() {
  let now = BASE,
    mode: Mode = "seed",
    runs = 0,
    threadId = "",
    lastStep: any;
  const records: Record<string, any> = {};
  const readBatches: string[][] = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const thread: any = {
    messages: [],
    updated_time: BASE,
    current_inference_id: null,
    data: {},
  };
  const json = (value: any) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        "content-type": "application/json",
        date: new Date(now).toUTCString(),
      },
    });
  const persist = () => {
    records[lastStep.id] = { step: lastStep, created_time: BASE + 200500 };
    if (!thread.messages.includes(lastStep.id))
      thread.messages.push(lastStep.id);
    thread.updated_time = BASE + 200500;
    thread.current_inference_id = "new-inference";
  };
  const mock: typeof fetch = async (input, init) => {
    const endpoint = String(input).split("/").at(-1);
    const body = JSON.parse(String(init?.body));
    if (endpoint === "runInferenceTranscript") {
      threadId = body.threadId;
      thread.id = threadId;
      lastStep = body.transcript.find((s: any) => s.type === "user");
      if (mode === "seed") {
        records[lastStep.id] = { step: lastStep, created_time: BASE };
        thread.messages.push(lastStep.id);
        return new Response(
          JSON.stringify({
            type: "agent-inference",
            id: "answer",
            value: [{ type: "text", content: "Ready" }],
            finishedAt: BASE,
          }) + "\n",
          { status: 200 },
        );
      }
      runs++;
      if (mode === "locked") return new Response("", { status: 200 });
      if (mode === "http-error")
        return new Response("temporary unavailable", { status: 503 });
      if (mode === "accepted") persist();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controllers.push(c);
          },
        }),
        { status: 200 },
      );
    }
    if (endpoint === "syncRecordValuesMain") {
      const maps: any = { thread: {}, thread_message: {} };
      const ids: string[] = [];
      for (const req of body.requests) {
        const { table, id } = req.pointer;
        if (table === "thread") maps.thread[id] = { value: thread };
        else {
          ids.push(id);
          if (records[id]) maps.thread_message[id] = { value: records[id] };
        }
      }
      if (ids.length) readBatches.push(ids);
      return json({ recordMap: maps });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const client = new NotionClient(
    {
      apiBase: ["https:", "", "example.test", "api/v3"].join("/"),
      defaultModel: "test-model",
      requestTimeoutMs: 5000,
      defaultWebSearch: false,
      defaultWorkspaceSearch: false,
      defaultReadOnly: false,
      account: { ...account },
    } as NotionConfig,
    mock,
  );
  client.keepAwakeDefaults = () => ({ ...defaults });
  const initial = await client.chat({ prompt: "seed" });
  return {
    client,
    thread,
    records,
    readBatches,
    id: initial.conversationId,
    runs: () => runs,
    mode: (m: Mode) => {
      mode = m;
    },
    advance: () => {
      now = BASE + 200000;
    },
    persist,
    cleanup: () => {
      for (const c of controllers) c.close();
    },
  };
}
for (const mode of ["locked", "http-error"] as const)
  test(`production watchdog surfaces asynchronous ${mode} rejection without burning budget`, async () => {
    const f = await fixture();
    const s = createKeepAwakeSupervisor(f.client);
    try {
      const w = await s.start({ conversationId: f.id });
      f.mode(mode);
      f.advance();
      const result = await s.tick(w.keepAliveId);
      assert.equal(result.keepAlive?.nudgeCount, 0);
      assert.match(
        result.keepAlive?.lastError ?? "",
        mode === "locked" ? /no events/ : /503/,
      );
      assert.equal(f.runs(), 1);
    } finally {
      s.stopAll();
      f.cleanup();
    }
  });
test("production watchdog acknowledges the exact persisted user step while generation is still running", async () => {
  const f = await fixture();
  const s = createKeepAwakeSupervisor(f.client);
  try {
    const w = await s.start({ conversationId: f.id });
    f.mode("accepted");
    f.advance();
    const result = await s.tick(w.keepAliveId);
    assert.equal(result.keepAlive?.nudgeCount, 1);
    assert.equal(result.keepAlive?.anchorTime, BASE + 200500);
    assert.equal(f.client.listChatJobs()[0]?.status, "running");
    assert.equal(f.runs(), 1);
  } finally {
    s.stopAll();
    f.cleanup();
  }
});
test("ambiguous delivery retries observe the original job instead of resending", async () => {
  const f = await fixture();
  try {
    f.mode("pending");
    await assert.rejects(
      f.client.sendChatNudge(f.id, "resume", undefined, 20),
      /not yet confirmed/,
    );
    assert.equal(f.runs(), 1);
    f.persist();
    const receipt = await f.client.sendChatNudge(f.id, "resume", undefined, 20);
    assert.equal(receipt.acceptedAt, BASE + 200500);
    assert.equal(f.runs(), 1);
  } finally {
    f.cleanup();
  }
});
test("a locked send retries only after the rejected job is observed and the lease is cleared", async () => {
  const f = await fixture();
  let interrupts = 0;
  f.client.keepAwakeDefaults = () => ({ ...defaults, interrupt: true });
  f.client.interruptTurn = async () => {
    interrupts++;
    f.mode("accepted");
    return {
      threadId: f.id,
      cleared: true,
      inferenceId: "stale",
      leaseExpiration: null,
    };
  };
  const s = createKeepAwakeSupervisor(f.client);
  try {
    const w = await s.start({ conversationId: f.id });
    f.mode("locked");
    f.advance();
    const result = await s.tick(w.keepAliveId);
    assert.equal(f.runs(), 2);
    assert.equal(interrupts, 1);
    assert.equal(result.keepAlive?.nudgeCount, 1);
    assert.equal(result.keepAlive?.lastError, undefined);
  } finally {
    s.stopAll();
    f.cleanup();
  }
});
test("watchdog user anchors scan only appended steps after the initial read", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.client.threadSignals(f.id, { includeUserMessage: true }))
        .lastUserMessageTime,
      BASE,
    );
    f.readBatches.length = 0;
    f.thread.messages.push("tool");
    f.records.tool = {
      step: { type: "agent-tool-result", state: "applied" },
      created_time: BASE + 100,
    };
    assert.equal(
      (await f.client.threadSignals(f.id, { includeUserMessage: true }))
        .lastUserMessageTime,
      BASE,
    );
    assert.deepEqual(f.readBatches, [["tool"]]);
    f.thread.messages.push("next-user");
    f.records["next-user"] = {
      step: { type: "user" },
      created_time: BASE + 200,
    };
    assert.equal(
      (await f.client.threadSignals(f.id, { includeUserMessage: true }))
        .lastUserMessageTime,
      BASE + 200,
    );
  } finally {
    f.cleanup();
  }
});
test("cancelling while account preparation is pending prevents an inference write", async () => {
  const f = await fixture();
  const original = f.client.account.bind(f.client);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.client.account = async () => {
    await gate;
    return original();
  };
  const controller = new AbortController();
  try {
    f.mode("accepted");
    const sending = f.client.sendChatNudge(f.id, "resume", controller.signal);
    controller.abort();
    release();
    await assert.rejects(sending, /abort/i);
    assert.equal(f.runs(), 0);
  } finally {
    release();
    f.cleanup();
  }
});
test("final-step shapes distinguish commentary plus tool-use from an actual final answer", async () => {
  const f = await fixture();
  try {
    f.records.mixed = {
      step: {
        type: "agent-inference",
        value: [
          { type: "text", content: "Working" },
          { type: "tool_use", name: "read" },
        ],
      },
    };
    const shape = await f.client.finalStepShape("mixed");
    assert.equal(shape?.hasAnswerText, true);
    assert.equal(shape?.hasToolUse, true);
  } finally {
    f.cleanup();
  }
});
