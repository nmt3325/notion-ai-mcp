import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NotionConfig } from "../src/config.js";
import { NotionClient } from "../src/notion-client.js";

const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function config(root: string, maxAttachmentBytes = 1024): NotionConfig {
  return {
    apiBase: "https://www.notion.so/api/v3",
    defaultModel: "almond-croissant-low",
    requestTimeoutMs: 5_000,
    attachmentRoot: root,
    maxAttachmentBytes,
    account: {
      tokenV2: "token",
      userId: USER_ID,
      userName: "Test User",
      userEmail: "test@example.com",
      spaceId: SPACE_ID,
      spaceName: "Test Space",
      spaceViewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      timezone: "UTC",
      clientVersion: "23.13.test",
      browserId: "browser",
      deviceId: "device"
    }
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function urlOf(input: string | URL | Request): URL {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function binaryBody(init?: RequestInit): Buffer {
  const body = init?.body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("Expected binary request body");
}

test("NotionClient performs single-part Agent Service upload and completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-single-"));
  const uploaded = Buffer.from("hello");
  let completeBody: Record<string, unknown> | undefined;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") {
        assert.equal(init?.method, "PUT");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("x-upload-token"), "signed");
        assert.deepEqual(binaryBody(init), uploaded);
        return new Response(null, { status: 200 });
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentServiceFileUploadURL") {
        const body = requestBody(init);
        assert.equal(body.filename, "hello.txt");
        assert.equal(body.mediaType, "text/plain");
        assert.equal(body.sizeBytes, 5);
        assert.deepEqual(body.target, { type: "user" });
        return json({
          upload: { type: "single_part", url: "https://upload.example/single", method: "PUT", headers: { "x-upload-token": "signed" } },
          file: { id: "file-single" }
        });
      }
      if (endpoint === "completeAgentServiceFileUpload") {
        completeBody = requestBody(init);
        return json({ id: "file-single", filename: "hello.txt", media_type: "text/plain", size_bytes: 5 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const result = await client.uploadAttachment({ base64: uploaded.toString("base64"), fileName: "hello.txt" });
    assert.equal(result.fileId, "file-single");
    assert.deepEqual(completeBody, { spaceId: SPACE_ID, target: { type: "user" }, fileId: "file-single" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient uploads multipart bytes and completes with sorted ETags", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-multipart-"));
  const data = Buffer.from("abcdefghij");
  const uploadedParts: string[] = [];
  let completeBody: Record<string, unknown> | undefined;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") {
        const part = Number(url.pathname.split("/").at(-1));
        uploadedParts[part - 1] = binaryBody(init).toString();
        return new Response(null, { status: 200, headers: { etag: `etag-${part}` } });
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentServiceFileUploadURL") return json({
        upload: {
          type: "multipart",
          part_size_bytes: 4,
          parts: [1, 2, 3].map((partNumber) => ({ part_number: partNumber, url: `https://upload.example/part/${partNumber}`, method: "PUT", headers: [] }))
        },
        file: { id: "file-multipart" }
      });
      if (endpoint === "completeAgentServiceFileUpload") {
        completeBody = requestBody(init);
        return json({ id: "file-multipart", filename: "data.bin", media_type: "application/octet-stream", size_bytes: data.length });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const result = await client.uploadAttachment({ base64: data.toString("base64"), fileName: "data.bin" });
    assert.equal(result.fileId, "file-multipart");
    assert.deepEqual(uploadedParts, ["abcd", "efgh", "ij"]);
    assert.deepEqual(completeBody?.parts, [
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" }
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient rejects multipart upload parts without ETags", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-etag-"));
  try {
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 200 });
      if (url.pathname.endsWith("createAgentServiceFileUploadURL")) return json({
        upload: { type: "multipart", part_size_bytes: 4, parts: [{ part_number: 1, url: "https://upload.example/part/1", method: "PUT", headers: {} }] },
        file: { id: "file-no-etag" }
      });
      return json({});
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(() => client.uploadAttachment({ base64: "YWJjZA==", fileName: "data.bin" }), /did not return an ETag/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient downloads thread files, verifies checksum, and writes safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-download-"));
  const data = Buffer.from("downloaded");
  const sha256 = createHash("sha256").update(data).digest("hex");
  try {
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "download.example") return new Response(data, { status: 200, headers: { "content-type": "text/plain", "content-length": String(data.length) } });
      if (url.pathname.endsWith("getFileContentURLForAgentThread")) return json({
        url: "https://download.example/file",
        file: { id: "file-download", filename: "download.txt", media_type: "text/plain", size_bytes: data.length, sha256 }
      });
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const base64 = await client.downloadAttachment({ conversationId: "11111111-1111-4111-8111-111111111111", fileId: "file-download", returnBase64: true });
    assert.equal(base64.base64, data.toString("base64"));
    assert.equal(base64.sha256, sha256);
    const written = await client.downloadAttachment({ conversationId: "11111111-1111-4111-8111-111111111111", fileId: "file-download", outputPath: "out/download.txt" });
    assert.equal((await readFile(written.path as string)).toString(), "downloaded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("file-ID chat uses current Agent Service create and send event content", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-chat-"));
  let createBody: Record<string, unknown> | undefined;
  let sendBody: Record<string, unknown> | undefined;
  let transcriptCalls = 0;
  const turn = (id: string, text: string, sequence: number, cursor: string) => json({
    patches: [
      { op: "put", entity: { id: `assistant-${id}`, kind: "assistant_message", source: "provisional", sequence, content: [{ type: "text", text: "" }] } },
      { op: "patch", id: `assistant-${id}`, ops: [{ op: "append", path: "/content/0/text", value: text }] },
      { op: "put", entity: { id: `done-${id}`, kind: "turn_completed", source: "committed", sequence: sequence + 1, stop_reason: "completed" } }
    ],
    forward_cursor: cursor,
    has_more_forward: false
  });
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentThread") {
        createBody = requestBody(init);
        return json({ thread: { id: createBody.threadId } });
      }
      if (endpoint === "sendEventToAgentThread") {
        sendBody = requestBody(init);
        return json({});
      }
      if (endpoint === "getThreadTranscript") {
        transcriptCalls += 1;
        if (transcriptCalls === 1) return turn("one", "First answer", 2, "cursor-one");
        if (transcriptCalls === 2) return json({ patches: [], forward_cursor: "cursor-baseline", has_more_forward: false });
        assert.equal(requestBody(init).cursor, "cursor-baseline");
        return turn("two", "Second answer", 5, "cursor-two");
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const first = await client.chat({ prompt: "Read this file", model: "fast", fileIds: ["file-1"] });
    assert.equal(first.text, "First answer");
    assert.deepEqual(createBody?.content, [
      { type: "text", text: "Read this file" },
      { type: "file", file_id: "file-1" }
    ]);
    assert.equal(createBody?.type, "personal_agent");
    assert.deepEqual(createBody?.policies, { approval_mode: "ask" });
    const second = await client.chat({ prompt: "Continue", conversationId: first.conversationId });
    assert.equal(second.text, "Second answer");
    assert.deepEqual(sendBody?.event, { type: "user.message", content: [{ type: "text", text: "Continue" }] });
    assert.deepEqual(sendBody?.policies, { approval_mode: "ask" });
    assert.equal(sendBody?.clientEventId === undefined, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
