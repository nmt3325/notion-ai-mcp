import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NotionConfig } from "../src/config.js";
import { NotionClient } from "../src/notion-client.js";

const SPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function config(root: string): NotionConfig {
  return {
    apiBase: "https://www.notion.so/api/v3",
    defaultModel: "almond-croissant-low",
    requestTimeoutMs: 5_000,
    attachmentRoot: root,
    maxAttachmentBytes: 1024,
    account: {
      tokenV2: "test-token",
      fullCookie: "token_v2=test-token; file_token=file-secret",
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function urlOf(input: string | URL | Request): URL {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function inference(text: string): Response {
  return new Response(`${JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: text }] })}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

test("automatic transcript fallback uploads, chats, continues, and downloads by opaque handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-transcript-upload-"));
  const data = Buffer.from("a,b\n1,2\n");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const uploadFields = [["key", "safe/object.csv"], ["Policy", "signed-policy"]] as const;
  let uploadRequest: Record<string, unknown> | undefined;
  let firstInference: Record<string, unknown> | undefined;
  let secondInference: Record<string, unknown> | undefined;
  let signedProxyRequest: Record<string, unknown> | undefined;
  let fileDownloadCookie: string | null | undefined;
  let runCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") {
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("x-upload-token"), "header-value");
        assert.ok(init?.body instanceof FormData);
        const entries = [...init.body.entries()];
        assert.deepEqual(entries.slice(0, -1), uploadFields);
        assert.equal(entries.at(-1)?.[0], "file");
        const file = entries.at(-1)?.[1];
        assert.ok(file instanceof Blob);
        assert.equal(file.size, data.length);
        assert.equal(file.type, "text/csv");
        assert.match((file as File).name, /^[0-9a-f-]{36}\.csv$/);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), data);
        return new Response(null, { status: 204 });
      }
      if (url.hostname === "download.example") {
        return new Response(data, { status: 200, headers: { "content-type": "text/csv", "content-length": String(data.length) } });
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentServiceFileUploadURL") return json({ message: "unsupported generation" }, 500);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        uploadRequest = requestBody(init);
        const pointer = uploadRequest.assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:server-object.csv`,
          signedGetUrl: "https://download.example/preview?signature=secret-preview",
          signedUploadPostUrl: "https://upload.example/post?signature=secret-upload",
          postHeaders: [{ name: "x-upload-token", value: "header-value" }],
          fields: Object.fromEntries(uploadFields),
          chatId: pointer.id
        });
      }
      if (endpoint === "runInferenceTranscript") {
        runCalls += 1;
        if (runCalls === 1) firstInference = requestBody(init);
        else secondInference = requestBody(init);
        return inference(runCalls === 1 ? "CSV received" : "Continued");
      }
      if (url.pathname.startsWith("/signed/")) {
        const headers = new Headers(init?.headers);
        signedProxyRequest = {
          host: url.hostname,
          sourceUrl: decodeURIComponent(url.pathname.slice("/signed/".length)),
          method: init?.method,
          hasCookie: Boolean(headers.get("cookie")),
          table: url.searchParams.get("table"),
          id: url.searchParams.get("id"),
          spaceId: url.searchParams.get("spaceId"),
          name: url.searchParams.get("name"),
          download: url.searchParams.get("download"),
          userId: url.searchParams.get("userId"),
          cache: url.searchParams.get("cache"),
          imgBuildSrc: url.searchParams.get("imgBuildSrc")
        };
        return new Response(null, { status: 302, headers: { location: "https://file.notion.com/f/signed-download" } });
      }
      if (url.hostname === "file.notion.com") {
        fileDownloadCookie = new Headers(init?.headers).get("cookie");
        return new Response(data, { status: 200, headers: { "content-type": "text/csv", "content-length": String(data.length) } });
      }
      return new Response("unexpected", { status: 500 });
    };

    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({ base64: data.toString("base64"), fileName: "table.csv" });
    assert.equal(uploaded.transport, "inference_transcript");
    assert.match(uploaded.fileId, /^transcript-file-[0-9a-f-]{36}$/);
    assert.match(uploaded.conversationId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(uploaded.sha256, sha256);
    assert.equal(uploaded.target.type, "thread");
    assert.equal(JSON.stringify(uploaded).includes("secret-"), false);

    const pointer = uploadRequest?.assistantChatTranscriptSessionPointer as Record<string, unknown>;
    assert.deepEqual(Object.keys(uploadRequest ?? {}).sort(), ["assistantChatTranscriptSessionPointer", "contentLength", "contentType", "createThread", "name"].sort());
    assert.equal(uploadRequest?.contentLength, data.length);
    assert.equal(uploadRequest?.contentType, "text/csv");
    assert.equal(uploadRequest?.createThread, true);
    assert.match(String(uploadRequest?.name), /^[0-9a-f-]{36}\.csv$/);
    assert.deepEqual(pointer, { spaceId: SPACE_ID, table: "thread", id: uploaded.conversationId });

    const first = await client.chat({ prompt: "Read the CSV", model: "fast", fileIds: [uploaded.fileId] });
    assert.equal(first.text, "CSV received");
    assert.equal(first.conversationId, uploaded.conversationId);
    assert.equal(firstInference?.threadId, uploaded.conversationId);
    assert.equal(firstInference?.createThread, true);
    assert.equal(firstInference?.isPartialTranscript, false);
    const firstTranscript = firstInference?.transcript as Array<Record<string, unknown>>;
    assert.deepEqual(firstTranscript.map((step) => step.type), ["config", "context", "computer-file", "user"]);
    const context = firstTranscript.find((step) => step.type === "context")?.value as Record<string, unknown>;
    assert.equal(context.surface, "workflows");
    const fileStep = firstTranscript.find((step) => step.type === "computer-file") as Record<string, unknown>;
    assert.equal(fileStep.fileUrl, `${SPACE_ID}:server-object.csv`);
    assert.equal(fileStep.fileName, "table.csv");
    assert.equal(fileStep.contentType, "text/csv");
    assert.deepEqual(fileStep.metadata, { fileSize: data.length, attachmentSource: "user_upload" });

    const second = await client.chat({ prompt: "Continue", conversationId: first.conversationId });
    assert.equal(second.text, "Continued");
    assert.equal(secondInference?.createThread, false);
    assert.equal(secondInference?.isPartialTranscript, true);
    assert.deepEqual((secondInference?.transcript as Array<Record<string, unknown>>).map((step) => step.type), ["config", "context", "updated-config", "user"]);
    await assert.rejects(() => client.chat({ prompt: "Attach twice", conversationId: first.conversationId, fileIds: [uploaded.fileId] }), /can only be attached once/);

    const downloaded = await client.downloadAttachment({ conversationId: first.conversationId, fileId: uploaded.fileId, returnBase64: true });
    assert.equal(downloaded.source, "inference_transcript");
    assert.equal(downloaded.base64, data.toString("base64"));
    assert.equal(downloaded.sha256, sha256);
    assert.deepEqual(signedProxyRequest, {
      host: "app.notion.com",
      sourceUrl: `${SPACE_ID}:server-object.csv`,
      method: "GET",
      hasCookie: true,
      table: "thread",
      id: first.conversationId,
      spaceId: SPACE_ID,
      name: "table.csv",
      download: "true",
      userId: USER_ID,
      cache: "v2",
      imgBuildSrc: "getSignedFileProxyUrl"
    });
    assert.equal(fileDownloadCookie, "file_token=file-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("transcript download rejects unsafe signed-proxy redirects before connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-unsafe-proxy-"));
  const data = Buffer.from("unsafe redirect probe");
  let unsafeHostCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      if (url.hostname === "10.0.0.1") {
        unsafeHostCalls += 1;
        return new Response(data);
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:unsafe-proxy.txt`,
          signedGetUrl: "https://download.example/preview",
          signedUploadPostUrl: "https://upload.example/post",
          postHeaders: [],
          fields: { key: "safe/object.txt" },
          chatId: pointer.id
        });
      }
      if (url.pathname.startsWith("/signed/")) {
        return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/private" } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({
      base64: data.toString("base64"),
      fileName: "unsafe-proxy.txt",
      transport: "inference_transcript"
    });
    await assert.rejects(
      () => client.downloadAttachment({ conversationId: uploaded.conversationId, fileId: uploaded.fileId, returnBase64: true }),
      /unsafe host/
    );
    assert.equal(unsafeHostCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit Agent Service mode does not silently fall back", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-no-fallback-"));
  const endpoints: string[] = [];
  try {
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const endpoint = urlOf(input).pathname.split("/").at(-1) ?? "";
      endpoints.push(endpoint);
      return json({ message: "unsupported" }, 500);
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(
      () => client.uploadAttachment({ base64: "YQ==", fileName: "a.txt", transport: "agent_service" }),
      /createAgentServiceFileUploadURL returned HTTP 500/
    );
    assert.deepEqual(endpoints, ["createAgentServiceFileUploadURL"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcript upload rejects malformed signed descriptors before storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-invalid-transcript-upload-"));
  const scenarios: Array<{ name: string; patch: Record<string, unknown>; pattern: RegExp }> = [
    { name: "map headers", patch: { postHeaders: { "x-test": "value" } }, pattern: /invalid postHeaders/ },
    { name: "empty fields", patch: { fields: {} }, pattern: /invalid form fields/ },
    { name: "unsafe upload URL", patch: { signedUploadPostUrl: "http://evil.example/upload" }, pattern: /must use HTTPS/ },
    { name: "private upload host", patch: { signedUploadPostUrl: "https://169.254.169.254/upload" }, pattern: /unsafe host/ },
    { name: "mismatched chat", patch: { chatId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, pattern: /different or invalid chatId/ }
  ];
  try {
    for (const scenario of scenarios) {
      let storageCalls = 0;
      const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = urlOf(input);
        if (url.hostname === "upload.example") {
          storageCalls += 1;
          return new Response(null, { status: 204 });
        }
        const body = requestBody(init);
        const pointer = body.assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:safe.txt`,
          signedGetUrl: "https://download.example/preview",
          signedUploadPostUrl: "https://upload.example/post",
          postHeaders: [],
          fields: { key: "safe.txt" },
          chatId: pointer.id,
          ...scenario.patch
        });
      };
      const client = new NotionClient(config(root), fakeFetch as typeof fetch);
      await assert.rejects(
        () => client.uploadAttachment({ base64: "YQ==", fileName: `${scenario.name}.txt`, transport: "inference_transcript" }),
        scenario.pattern
      );
      assert.equal(storageCalls, 0, scenario.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
