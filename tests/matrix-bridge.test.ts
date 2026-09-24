import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStateAdapter } from "../src/file-state.js";
import {
  MatrixConversationStore,
  MatrixNotionBridge,
  type MatrixBridgeSink,
  type NotionBridgeClient
} from "../src/matrix-bridge.js";
import type { MatrixBridgeOptions } from "../src/matrix-config.js";
import type { ChatJobLookup, ChatStartResult } from "../src/types.js";

const OPTIONS: MatrixBridgeOptions = {
  pollIntervalMs: 1,
  responseTimeoutMs: 10_000,
  maxMessageChars: 10_000
};

class FakeSink implements MatrixBridgeSink {
  readonly posts: Array<{ threadId: string; markdown: string }> = [];
  readonly typing: string[] = [];

  async postMarkdown(threadId: string, markdown: string): Promise<void> {
    this.posts.push({ threadId, markdown });
  }

  async startTyping(threadId: string): Promise<void> {
    this.typing.push(threadId);
  }
}

class FakeNotion implements NotionBridgeClient {
  readonly starts: Array<Parameters<NotionBridgeClient["startChat"]>[0]> = [];
  readonly lookups: Array<Parameters<NotionBridgeClient["chatResult"]>[0]> = [];
  startImplementation?: (options: Parameters<NotionBridgeClient["startChat"]>[0]) => Promise<ChatStartResult>;
  resultImplementation?: (options: Parameters<NotionBridgeClient["chatResult"]>[0]) => Promise<ChatJobLookup>;

  async startChat(options: Parameters<NotionBridgeClient["startChat"]>[0]): Promise<ChatStartResult> {
    this.starts.push(options);
    if (this.startImplementation) return this.startImplementation(options);
    const turn = this.starts.length;
    const conversationId = options.conversationId ?? `conversation-${turn}`;
    return {
      status: "running",
      jobId: `job-${turn}`,
      conversationId,
      model: "model",
      startedAt: Date.now(),
      hint: "running"
    };
  }

  async chatResult(options: Parameters<NotionBridgeClient["chatResult"]>[0]): Promise<ChatJobLookup> {
    this.lookups.push(options);
    if (this.resultImplementation) return this.resultImplementation(options);
    return {
      status: "completed",
      source: "job",
      conversationId: options.conversationId ?? "missing",
      text: `answer-${this.lookups.length}`
    };
  }
}

async function withBridge(
  run: (context: {
    bridge: MatrixNotionBridge;
    notion: FakeNotion;
    sink: FakeSink;
    store: MatrixConversationStore;
    state: FileStateAdapter;
    filePath: string;
  }) => Promise<void>,
  overrides: {
    notion?: FakeNotion;
    sink?: FakeSink;
    options?: MatrixBridgeOptions;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "notion-matrix-bridge-"));
  const filePath = join(directory, "state.json");
  const state = new FileStateAdapter(filePath);
  await state.connect();
  const store = new MatrixConversationStore(state);
  await store.initialize();
  const notion = overrides.notion ?? new FakeNotion();
  const sink = overrides.sink ?? new FakeSink();
  const bridge = new MatrixNotionBridge(
    notion,
    sink,
    store,
    overrides.options ?? OPTIONS,
    {},
    overrides.sleep ?? (async () => undefined),
    overrides.now ?? Date.now
  );
  try { await run({ bridge, notion, sink, store, state, filePath }); }
  finally {
    bridge.stop();
    await state.disconnect().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Matrix receive -> Notion start/result -> Matrix send, then conversation continuation", async () => {
  await withBridge(async ({ bridge, notion, sink, store }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-1", text: "hello" });
    assert.equal(notion.starts.length, 1);
    assert.equal(notion.starts[0]?.prompt, "hello");
    assert.equal(notion.starts[0]?.conversationId, undefined);
    assert.equal(notion.lookups[0]?.jobId, "job-1");
    assert.equal(notion.lookups[0]?.conversationId, "conversation-1");
    assert.deepEqual(sink.posts, [{ threadId: "matrix:room", markdown: "answer-1" }]);
    assert.equal((await store.get("matrix:room"))?.conversationId, "conversation-1");
    assert.equal((await store.get("matrix:room"))?.pending, undefined);

    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-2", text: "follow up" });
    assert.equal(notion.starts[1]?.conversationId, "conversation-1");
    assert.equal(notion.lookups[1]?.jobId, "job-2");
    assert.equal(sink.posts[1]?.markdown, "answer-2");
  });
});

test("replayed Matrix event IDs are not submitted to Notion twice", async () => {
  await withBridge(async ({ bridge, notion, sink }) => {
    const message = { threadId: "matrix:room", messageId: "event-replayed", text: "hello" };
    await bridge.handleMessage(message);
    await bridge.handleMessage({ ...message, text: "replayed body" });

    assert.equal(notion.starts.length, 1);
    assert.deepEqual(sink.posts, [{ threadId: "matrix:room", markdown: "answer-1" }]);
  });
});

test("pending Notion results are polled until complete", async () => {
  const notion = new FakeNotion();
  let lookup = 0;
  notion.resultImplementation = async (options) => {
    lookup += 1;
    if (lookup === 1) {
      return {
        status: "running",
        source: "job",
        conversationId: options.conversationId ?? "missing"
      };
    }
    return {
      status: "completed",
      source: "job",
      conversationId: options.conversationId ?? "missing",
      text: "eventual answer"
    };
  };

  await withBridge(async ({ bridge, sink }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event", text: "wait" });
    assert.equal(lookup, 2);
    assert.equal(sink.posts.at(-1)?.markdown, "eventual answer");
    assert.ok(sink.typing.length >= 2);
  }, { notion });
});

test("a timed-out turn keeps polling in the background and delivers the answer", async () => {
  const notion = new FakeNotion();
  let lookup = 0;
  let clock = 0;
  notion.resultImplementation = async (options) => {
    lookup += 1;
    if (lookup <= 2) {
      return {
        status: "running",
        source: "job",
        conversationId: options.conversationId ?? "missing"
      };
    }
    return {
      status: "completed",
      source: "job",
      conversationId: options.conversationId ?? "missing",
      text: "background answer"
    };
  };

  await withBridge(async ({ bridge, sink, store }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event", text: "slow" });
    assert.ok(sink.posts.some((post) => post.markdown.includes("still generating")));

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (sink.posts.some((post) => post.markdown === "background answer")) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    assert.ok(lookup >= 3);
    assert.ok(sink.posts.some((post) => post.markdown === "background answer"));
    assert.equal((await store.get("matrix:room"))?.pending, undefined);
  }, {
    notion,
    options: { ...OPTIONS, pollIntervalMs: 1, responseTimeoutMs: 1 },
    sleep: async (ms) => { clock += ms; },
    now: () => clock
  });
});

test("a retargeted Notion job updates the Matrix thread mapping", async () => {
  const notion = new FakeNotion();
  notion.resultImplementation = async (options) => ({
    status: "completed",
    source: "job",
    conversationId: "conversation-retargeted",
    text: `answer for ${options.jobId}`
  });

  await withBridge(async ({ bridge, notion: fake, store }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-1", text: "first" });
    assert.equal(fake.lookups[0]?.jobId, "job-1");
    assert.equal((await store.get("matrix:room"))?.conversationId, "conversation-retargeted");

    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-2", text: "follow up" });
    assert.equal(fake.starts[1]?.conversationId, "conversation-retargeted");
    assert.equal(fake.lookups[1]?.jobId, "job-2");
  }, { notion });
});

test("messages in one Matrix thread remain strictly ordered", async () => {
  const notion = new FakeNotion();
  let releaseFirst!: () => void;
  const firstResult = new Promise<void>((resolve) => { releaseFirst = resolve; });
  notion.resultImplementation = async (options) => {
    if (options.conversationId === "conversation-1") await firstResult;
    return {
      status: "completed",
      source: "job",
      conversationId: options.conversationId ?? "missing",
      text: `answer for ${options.conversationId}`
    };
  };

  await withBridge(async ({ bridge, sink }) => {
    const first = bridge.handleMessage({ threadId: "matrix:room", messageId: "event-1", text: "first" });
    while (notion.starts.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = bridge.handleMessage({ threadId: "matrix:room", messageId: "event-2", text: "second" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notion.starts.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(notion.starts.length, 2);
    assert.equal(notion.starts[1]?.conversationId, "conversation-1");
    assert.deepEqual(sink.posts.map((post) => post.markdown), [
      "answer for conversation-1",
      "answer for conversation-1"
    ]);
  }, { notion });
});

test("commands never reach Notion and !new resets the conversation mapping", async () => {
  await withBridge(async ({ bridge, notion, sink }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-1", text: "hello" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-2", text: "!status" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-3", text: "!help" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-4", text: "!new" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-5", text: "fresh" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-4", text: "!new" });
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event-6", text: "follow up" });

    assert.equal(notion.starts.length, 3);
    assert.equal(notion.starts[1]?.conversationId, undefined);
    assert.equal(notion.starts[2]?.conversationId, "conversation-2");
    assert.ok(sink.posts.some((post) => post.markdown.includes("Status: ready")));
    assert.ok(sink.posts.some((post) => post.markdown.includes("bridge commands")));
    assert.equal(
      sink.posts.filter((post) => post.markdown.includes("Started a new")).length,
      1
    );
  });
});

test("a persisted pending turn is recovered after restart", async () => {
  await withBridge(async ({ state, filePath }) => {
    const firstStore = new MatrixConversationStore(state);
    await firstStore.initialize();
    await firstStore.setPending("matrix:room", {
      jobId: "job-old",
      conversationId: "conversation-old",
      messageId: "event-old",
      startedAt: Date.now()
    });
    await state.disconnect();

    const restartedState = new FileStateAdapter(filePath);
    await restartedState.connect();
    const restartedStore = new MatrixConversationStore(restartedState);
    await restartedStore.initialize();
    const notion = new FakeNotion();
    notion.resultImplementation = async (options) => {
      if (options.jobId) throw new Error(`Unknown jobId ${options.jobId}`);
      return {
        status: "completed",
        source: "thread",
        conversationId: "conversation-old",
        text: "recovered answer"
      };
    };
    const sink = new FakeSink();
    const bridge = new MatrixNotionBridge(
      notion,
      sink,
      restartedStore,
      OPTIONS,
      {},
      async () => undefined
    );
    await bridge.resumePending();
    assert.equal(notion.lookups[0]?.jobId, "job-old");
    assert.equal(notion.lookups[1]?.jobId, undefined);
    assert.equal(notion.lookups[1]?.conversationId, "conversation-old");
    assert.equal(sink.posts[0]?.markdown, "recovered answer");
    assert.equal((await restartedStore.get("matrix:room"))?.pending, undefined);
    assert.equal((await restartedStore.get("matrix:room"))?.conversationId, "conversation-old");
    bridge.stop();
    await restartedState.disconnect();
  });
});

test("Notion errors are returned to Matrix without leaking internal details", async () => {
  const notion = new FakeNotion();
  notion.startImplementation = async () => {
    throw new Error("token_v2=super-secret internal payload");
  };
  await withBridge(async ({ bridge, sink }) => {
    await bridge.handleMessage({ threadId: "matrix:room", messageId: "event", text: "hello" });
    assert.equal(sink.posts.length, 1);
    assert.match(sink.posts[0]?.markdown ?? "", /couldn't complete/);
    assert.doesNotMatch(sink.posts[0]?.markdown ?? "", /super-secret|token_v2/);
  }, { notion });
});
