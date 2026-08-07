import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareAttachmentInput, readResponseBuffer, writeAttachmentOutput } from "../src/attachments.js";

test("attachment input accepts safe paths and strict base64", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-attachments-"));
  const outside = await mkdtemp(join(tmpdir(), "notion-ai-outside-"));
  try {
    await writeFile(join(root, "notes.txt"), "hello");
    await writeFile(join(outside, "secret.txt"), "secret");
    const pathInput = await prepareAttachmentInput({ path: "notes.txt" }, root, 100);
    assert.equal(pathInput.data.toString(), "hello");
    assert.equal(pathInput.mediaType, "text/plain");
    const base64Input = await prepareAttachmentInput({ base64: "aGVsbG8=", fileName: "notes.md" }, root, 100);
    assert.equal(base64Input.data.toString(), "hello");
    assert.equal(base64Input.mediaType, "text/markdown");
    await assert.rejects(() => prepareAttachmentInput({ path: join(outside, "secret.txt") }, root, 100), /must stay within/);
    await assert.rejects(() => prepareAttachmentInput({ base64: "not base64", fileName: "x" }, root, 100), /valid standard base64/);
    await assert.rejects(() => prepareAttachmentInput({ path: "notes.txt", base64: "aA==" }, root, 100), /exactly one/);
    await assert.rejects(() => prepareAttachmentInput({ path: "notes.txt" }, root, 4), /byte limit/);
    await writeFile(join(root, "empty.txt"), "");
    await assert.rejects(() => prepareAttachmentInput({ path: "empty.txt" }, root, 100), /must not be empty/);
    await assert.rejects(() => prepareAttachmentInput({ base64: "aA==", fileName: "dir\\name.txt" }, root, 100), /plain file name/);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("attachment output rejects traversal and symlink parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-output-"));
  const outside = await mkdtemp(join(tmpdir(), "notion-ai-output-outside-"));
  try {
    await assert.rejects(() => writeAttachmentOutput(Buffer.from("x"), "../escape.txt", root), /must stay within/);
    await symlink(outside, join(root, "link"), "dir");
    await assert.rejects(() => writeAttachmentOutput(Buffer.from("x"), "link/new/escape.txt", root), /must not contain symlinks/);
    await assert.rejects(() => access(join(outside, "new")), /ENOENT/);
    const path = await writeAttachmentOutput(Buffer.from("safe"), "downloads/safe.txt", root);
    assert.equal(path, join(root, "downloads", "safe.txt"));
    await assert.rejects(() => writeAttachmentOutput(Buffer.from("again"), "downloads/safe.txt", root), /EEXIST/);
    await chmod(path, 0o666);
    await writeAttachmentOutput(Buffer.from("replaced"), "downloads/safe.txt", root, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("download reader enforces declared and streamed byte limits", async () => {
  await assert.rejects(() => readResponseBuffer(new Response("12345", { headers: { "content-length": "5" } }), 4), /byte limit/);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123"));
      controller.enqueue(new TextEncoder().encode("456"));
      controller.close();
    }
  });
  await assert.rejects(() => readResponseBuffer(new Response(stream), 5), /byte limit/);
  assert.equal((await readResponseBuffer(new Response("ok"), 5)).toString(), "ok");
});
