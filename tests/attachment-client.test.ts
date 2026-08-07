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

test("NotionClient validates every multipart descriptor before uploading", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-invalid-multipart-"));
  const validParts = [1, 2].map((partNumber) => ({ part_number: partNumber, url: `https://upload.example/part/${partNumber}`, method: "PUT", headers: {} }));
  const scenarios: Array<{ name: string; upload: Record<string, unknown>; pattern: RegExp }> = [
    { name: "unknown type", upload: { type: "unknown", part_size_bytes: 4, parts: validParts }, pattern: /unsupported upload descriptor type/ },
    { name: "duplicate", upload: { type: "multipart", part_size_bytes: 4, parts: [validParts[0], validParts[0]] }, pattern: /invalid multipart upload part/ },
    { name: "out of range", upload: { type: "multipart", part_size_bytes: 4, parts: [validParts[0], { ...validParts[1], part_number: 3 }] }, pattern: /outside the file bounds/ },
    { name: "missing", upload: { type: "multipart", part_size_bytes: 4, parts: [validParts[0]] }, pattern: /contained 1 parts; expected 2/ }
  ];
  try {
    for (const scenario of scenarios) {
      let signedCalls = 0;
      let completeCalls = 0;
      const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
        const url = urlOf(input);
        if (url.hostname === "upload.example") { signedCalls += 1; return new Response(null, { status: 200, headers: { etag: "etag" } }); }
        if (url.pathname.endsWith("createAgentServiceFileUploadURL")) return json({ upload: scenario.upload, file: { id: "file-invalid" } });
        if (url.pathname.endsWith("completeAgentServiceFileUpload")) { completeCalls += 1; return json({ id: "file-invalid", filename: "data.bin", media_type: "application/octet-stream", size_bytes: 8 }); }
        return new Response("unexpected", { status: 500 });
      };
      const client = new NotionClient(config(root), fakeFetch as typeof fetch);
      await assert.rejects(() => client.uploadAttachment({ base64: Buffer.from("abcdefgh").toString("base64"), fileName: "data.bin" }), scenario.pattern, scenario.name);
      assert.equal(signedCalls, 0, `${scenario.name} must fail before any signed upload`);
      assert.equal(completeCalls, 0, `${scenario.name} must not complete the upload`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient rejects invalid upload creation and completion responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-invalid-complete-"));
  const bytes = Buffer.from("data");
  try {
    let signedCalls = 0;
    const missingFileFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") { signedCalls += 1; return new Response(null, { status: 200 }); }
      if (url.pathname.endsWith("createAgentServiceFileUploadURL")) return json({ upload: { type: "single_part", url: "https://upload.example/file", method: "PUT" }, file: {} });
      return json({});
    };
    await assert.rejects(
      () => new NotionClient(config(root), missingFileFetch as typeof fetch).uploadAttachment({ base64: bytes.toString("base64"), fileName: "data.bin" }),
      /did not return file\.id/
    );
    assert.equal(signedCalls, 0);

    const completions: Array<{ value: unknown; pattern: RegExp }> = [
      { value: {}, pattern: /invalid uploaded-file object/ },
      { value: { id: "other", filename: "data.bin", media_type: "application/octet-stream", size_bytes: 4 }, pattern: /different file ID/ },
      { value: { id: "file-complete", filename: "data.bin", media_type: "application/octet-stream", size_bytes: 5 }, pattern: /different file size/ },
      { value: { id: "file-complete", filename: "data.bin", media_type: "application/octet-stream", size_bytes: 4, sha256: "invalid" }, pattern: /invalid uploaded-file object/ },
      { value: { id: "file-complete", filename: "data.bin", media_type: "application/octet-stream", size_bytes: 4, sha256: "0".repeat(64) }, pattern: /checksum did not match local data/ }
    ];
    for (const completion of completions) {
      const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
        const url = urlOf(input);
        if (url.hostname === "upload.example") return new Response(null, { status: 200 });
        if (url.pathname.endsWith("createAgentServiceFileUploadURL")) return json({ upload: { type: "single_part", url: "https://upload.example/file", method: "PUT" }, file: { id: "file-complete" } });
        if (url.pathname.endsWith("completeAgentServiceFileUpload")) return json(completion.value);
        return new Response("unexpected", { status: 500 });
      };
      const client = new NotionClient(config(root), fakeFetch as typeof fetch);
      await assert.rejects(() => client.uploadAttachment({ base64: bytes.toString("base64"), fileName: "data.bin" }), completion.pattern);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient rejects inconsistent download metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-invalid-download-"));
  const data = Buffer.from("data");
  const scenarios: Array<{ metadata: Record<string, unknown>; pattern: RegExp }> = [
    { metadata: { size_bytes: 5 }, pattern: /size did not match Notion metadata/ },
    { metadata: { size_bytes: 4, sha256: "0".repeat(64) }, pattern: /checksum did not match Notion metadata/ },
    { metadata: { size_bytes: -1 }, pattern: /invalid size/ },
    { metadata: { size_bytes: 4, sha256: "invalid" }, pattern: /invalid checksum/ }
  ];
  try {
    for (const scenario of scenarios) {
      const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
        const url = urlOf(input);
        if (url.hostname === "download.example") return new Response(data, { status: 200 });
        if (url.pathname.endsWith("getFileContentURLForAgentThread")) return json({
          url: "https://download.example/file",
          file: { id: "file-download", filename: "data.bin", media_type: "application/octet-stream", ...scenario.metadata }
        });
        return new Response("unexpected", { status: 500 });
      };
      const client = new NotionClient(config(root), fakeFetch as typeof fetch);
      await assert.rejects(() => client.downloadAttachment({ conversationId: "11111111-1111-4111-8111-111111111111", fileId: "file-download", returnBase64: true }), scenario.pattern);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient aborts a stalled signed upload at the request timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-timeout-"));
  let sawSignal = false;
  let sawAbort = false;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.pathname.endsWith("createAgentServiceFileUploadURL")) return json({
        upload: { type: "single_part", url: "https://upload.example/stalled", method: "PUT" },
        file: { id: "file-timeout" }
      });
      if (url.hostname === "upload.example") {
        const signal = init?.signal;
        sawSignal = signal instanceof AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) { reject(new Error("missing abort signal")); return; }
          const aborted = () => { sawAbort = true; reject(new Error("signed request aborted")); };
          if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const timedConfig = config(root);
    timedConfig.requestTimeoutMs = 20;
    const client = new NotionClient(timedConfig, fakeFetch as typeof fetch);
    const keepEventLoopAlive = setTimeout(() => undefined, 1_000);
    try {
      await assert.rejects(() => client.uploadAttachment({ base64: "ZGF0YQ==", fileName: "data.bin" }), /signed request aborted/);
    } finally {
      clearTimeout(keepEventLoopAlive);
    }
    assert.equal(sawSignal, true);
    assert.equal(sawAbort, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient permits 19 unique file IDs and deduplicates before Agent Service", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-file-ids-"));
  let createBody: Record<string, unknown> | undefined;
  let createCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const endpoint = urlOf(input).pathname.split("/").at(-1);
      if (endpoint === "createAgentThread") { createCalls += 1; createBody = requestBody(init); return json({ thread: { id: createBody.threadId } }); }
      if (endpoint === "getThreadTranscript") return json({
        patches: [
          { op: "put", entity: { id: "assistant", kind: "assistant_message", source: "provisional", sequence: 1, content: [{ type: "text", text: "ok" }] } },
          { op: "put", entity: { id: "done", kind: "turn_completed", source: "committed", sequence: 2, stop_reason: "completed" } }
        ],
        forward_cursor: "done",
        has_more_forward: false
      });
      return new Response("unexpected", { status: 500 });
    };
    const ids = Array.from({ length: 19 }, (_, index) => `file-${index}`);
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const result = await client.chat({ prompt: "Read all files", fileIds: [` ${ids[0]} `, ...ids.slice(1), ids[0]] });
    assert.equal(result.text, "ok");
    const content = createBody?.content as Array<Record<string, unknown>>;
    assert.equal(content.length, 20);
    assert.deepEqual(content.slice(1).map((entry) => entry.file_id), ids);
    await assert.rejects(() => client.chat({ prompt: "Too many", fileIds: Array.from({ length: 20 }, (_, index) => `unique-${index}`) }), /at most 19 files/);
    assert.equal(createCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy inline attachments become prompt context and reject real-file mixing", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-legacy-attachments-"));
  let inferenceBody: Record<string, unknown> | undefined;
  let inferenceCalls = 0;
  let uploadCreateCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const endpoint = urlOf(input).pathname.split("/").at(-1);
      if (endpoint === "runInferenceTranscript") {
        inferenceCalls += 1;
        inferenceBody = requestBody(init);
        return new Response(`${JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "Legacy answer" }] })}\n`, { status: 200 });
      }
      if (endpoint === "createAgentServiceFileUploadURL") { uploadCreateCalls += 1; return json({}); }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const first = await client.chat({
      prompt: "Summarize",
      attachments: [
        { name: "notes.txt", text: "hello" },
        { name: "source", url: "https://example.com/source" }
      ]
    });
    const expectedPrompt = "Summarize\n\n--- Attachment context: notes.txt ---\nhello\n\n--- Attachment context: source ---\nhttps://example.com/source";
    const transcript = (inferenceBody?.transcript ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(transcript.find((entry) => entry.type === "user")?.value, [[expectedPrompt]]);
    await assert.rejects(() => client.chat({ prompt: "Add a file", conversationId: first.conversationId, fileIds: ["file-1"] }), /cannot be added to a legacy chat/);
    await assert.rejects(() => client.uploadAttachment({ base64: "ZGF0YQ==", fileName: "data.bin", conversationId: first.conversationId, transport: "agent_service" }), /cannot target an inference-transcript conversation/);
    assert.equal(inferenceCalls, 1);
    assert.equal(uploadCreateCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient downloads legacy artifacts through getSignedFileUrls", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-legacy-download-"));
  const data = Buffer.from("legacy artifact");
  let signerBody: Record<string, unknown> | undefined;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "download.example") {
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.signal instanceof AbortSignal, true);
        return new Response(data, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
      }
      if (url.pathname.endsWith("getSignedFileUrls")) {
        signerBody = requestBody(init);
        return json({ signedUrls: ["https://download.example/legacy"] });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const permissionRecord = { table: "thread", id: "11111111-1111-4111-8111-111111111111", spaceId: SPACE_ID };
    const downloaded = await client.downloadAttachment({
      legacy: { url: "https://secure.example/original", fileName: "artifact.md", permissionRecord },
      returnBase64: true
    });
    assert.deepEqual(signerBody, {
      urls: [{
        url: "https://secure.example/original",
        download: true,
        downloadName: "artifact.md",
        permissionRecord
      }]
    });
    assert.equal(downloaded.source, "legacy_signed_url");
    assert.equal(downloaded.fileId, undefined);
    assert.equal(downloaded.fileName, "artifact.md");
    assert.equal(downloaded.mediaType, "text/markdown");
    assert.equal(downloaded.sizeBytes, data.byteLength);
    assert.equal(downloaded.base64, data.toString("base64"));
    assert.equal(downloaded.sha256, createHash("sha256").update(data).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("NotionClient rejects ambiguous or unsafe legacy download inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-client-legacy-download-invalid-"));
  let fetchCalls = 0;
  try {
    const fakeFetch = async (): Promise<Response> => { fetchCalls += 1; return json({ signedUrls: [] }); };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const permissionRecord = { table: "thread", id: "11111111-1111-4111-8111-111111111111", spaceId: SPACE_ID };
    await assert.rejects(() => client.downloadAttachment({ returnBase64: true }), /exactly one download mode/);
    await assert.rejects(() => client.downloadAttachment({ conversationId: permissionRecord.id, returnBase64: true }), /requires both conversationId and fileId/);
    await assert.rejects(() => client.downloadAttachment({
      conversationId: permissionRecord.id,
      fileId: "file-1",
      legacy: { url: "https://secure.example/file", fileName: "file.txt", permissionRecord },
      returnBase64: true
    }), /exactly one download mode/);
    await assert.rejects(() => client.downloadAttachment({
      legacy: { url: "http://insecure.example/file", fileName: "file.txt", permissionRecord },
      returnBase64: true
    }), /must be HTTPS/);
    await assert.rejects(() => client.downloadAttachment({
      legacy: { url: "https://secure.example/file", fileName: "../file.txt", permissionRecord },
      returnBase64: true
    }), /plain file name/);
    await assert.rejects(() => client.downloadAttachment({
      legacy: { url: "https://secure.example/file", fileName: "file.txt", permissionRecord: { ...permissionRecord, spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
      returnBase64: true
    }), /active workspace/);
    assert.equal(fetchCalls, 0);

    await assert.rejects(() => client.downloadAttachment({
      legacy: { url: "https://secure.example/file", fileName: "file.txt", permissionRecord },
      returnBase64: true
    }), /exactly one signed URL/);
    assert.equal(fetchCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
