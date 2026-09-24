import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Message, parseMarkdown } from "chat";
import { FileStateAdapter } from "../src/file-state.js";

function message(id: string, text: string): Message {
  return new Message({
    id,
    threadId: "matrix:room",
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: {
      userId: "@alice:example.com",
      userName: "alice",
      fullName: "Alice",
      isBot: false,
      isMe: false
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: []
  });
}

async function withState(
  run: (filePath: string, directory: string) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "notion-matrix-state-"));
  try { await run(join(directory, "state.json"), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("file state persists subscriptions, cache, lists, and queues across restart", async () => {
  await withState(async (filePath) => {
    const first = new FileStateAdapter(filePath);
    await first.connect();
    await first.subscribe("matrix:room");
    await first.set("object", { answer: 42 });
    await first.appendToList("history", "one");
    await first.appendToList("history", "two", { maxLength: 5 });
    await first.enqueue("matrix:room", {
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      message: message("event-1", "hello")
    }, 10);
    await first.disconnect();

    assert.equal(statSync(filePath).mode & 0o777, 0o600);

    const second = new FileStateAdapter(filePath);
    await second.connect();
    assert.equal(await second.isSubscribed("matrix:room"), true);
    assert.deepEqual(await second.get("object"), { answer: 42 });
    assert.deepEqual(await second.getList("history"), ["one", "two"]);
    assert.equal(await second.queueDepth("matrix:room"), 1);
    const queued = await second.dequeue("matrix:room");
    assert.ok(queued?.message instanceof Message);
    assert.equal(queued?.message.text, "hello");
    assert.equal(await second.queueDepth("matrix:room"), 0);
    await second.disconnect();
  });
});

test("file state enforces cache and queue TTLs", async () => {
  await withState(async (filePath) => {
    const state = new FileStateAdapter(filePath);
    await state.connect();
    await state.set("short", "value", 10);
    await state.appendToList("short-list", "value", { ttlMs: 10 });
    await state.enqueue("thread", {
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + 10,
      message: message("event-2", "expired")
    }, 10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await state.get("short"), null);
    assert.deepEqual(await state.getList("short-list"), []);
    assert.equal(await state.dequeue("thread"), null);
    await state.disconnect();
  });
});

test("file state lock ownership supports acquire, extend, force release, and release", async () => {
  await withState(async (filePath) => {
    const state = new FileStateAdapter(filePath);
    await state.connect();
    const lock = await state.acquireLock("thread", 1_000);
    assert.ok(lock);
    assert.equal(await state.acquireLock("thread", 1_000), null);
    assert.equal(await state.extendLock(lock, 2_000), true);
    const impostor = { ...lock, token: "not-the-owner" };
    await state.releaseLock(impostor);
    assert.equal(await state.acquireLock("thread", 1_000), null);
    await state.forceReleaseLock("thread");
    const replacement = await state.acquireLock("thread", 1_000);
    assert.ok(replacement);
    await state.releaseLock(replacement);
    assert.ok(await state.acquireLock("thread", 1_000));
    await state.disconnect();
  });
});

test("concurrent mutations produce one valid atomic state file", async () => {
  await withState(async (filePath, directory) => {
    const state = new FileStateAdapter(filePath);
    await state.connect();
    await Promise.all(Array.from({ length: 20 }, (_, index) => state.set(`key-${index}`, index)));
    for (let index = 0; index < 20; index += 1) {
      assert.equal(await state.get(`key-${index}`), index);
    }
    assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(await state.setIfNotExists("only-once", 1), true);
    assert.equal(await state.setIfNotExists("only-once", 2), false);
    await state.disconnect();
  });
});
