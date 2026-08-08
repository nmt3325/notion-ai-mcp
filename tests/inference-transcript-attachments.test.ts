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

test("auto upload does not retarget an explicit conversation during transcript fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-explicit-target-"));
  const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let transcriptCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentServiceFileUploadURL") return json({ message: "unsupported target" }, 500);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        transcriptCalls += 1;
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:unexpected.txt`,
          signedGetUrl: "https://download.example/preview",
          signedUploadPostUrl: "https://upload.example/post",
          postHeaders: [],
          fields: { key: "safe/unexpected.txt" },
          chatId: pointer.id
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(
      () => client.uploadAttachment({
        base64: Buffer.from("targeted").toString("base64"),
        fileName: "targeted.txt",
        conversationId,
        transport: "auto"
      }),
      /createAgentServiceFileUploadURL returned HTTP 500/
    );
    assert.equal(transcriptCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active inference conversations accept later one-shot transcript uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-existing-transcript-"));
  const uploadRequests: Array<Record<string, unknown>> = [];
  const inferenceRequests: Array<Record<string, unknown>> = [];
  let agentUploadCalls = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "createAgentServiceFileUploadURL") {
        agentUploadCalls += 1;
        return json({ message: "should not be called" }, 500);
      }
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const body = requestBody(init);
        uploadRequests.push(body);
        const pointer = body.assistantChatTranscriptSessionPointer as Record<string, unknown>;
        const index = uploadRequests.length;
        return json({
          url: `${SPACE_ID}:server-${index}.txt`,
          signedGetUrl: `https://download.example/preview-${index}`,
          signedUploadPostUrl: `https://upload.example/post-${index}`,
          postHeaders: [],
          fields: { key: `safe/server-${index}.txt` },
          chatId: pointer.id
        });
      }
      if (endpoint === "runInferenceTranscript") {
        inferenceRequests.push(requestBody(init));
        return inference(`Turn ${inferenceRequests.length}`);
      }
      return new Response("unexpected", { status: 500 });
    };

    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const firstUpload = await client.uploadAttachment({
      base64: Buffer.from("first").toString("base64"),
      fileName: "first.txt",
      transport: "inference_transcript"
    });
    const firstChat = await client.chat({ prompt: "First", fileIds: [firstUpload.fileId] });
    const secondUpload = await client.uploadAttachment({
      base64: Buffer.from("second").toString("base64"),
      fileName: "second.txt",
      conversationId: firstChat.conversationId,
      transport: "auto"
    });
    const secondChat = await client.chat({
      prompt: "Second",
      conversationId: firstChat.conversationId,
      fileIds: [secondUpload.fileId]
    });

    assert.equal(secondUpload.conversationId, firstChat.conversationId);
    assert.equal(secondChat.conversationId, firstChat.conversationId);
    assert.equal(agentUploadCalls, 0);
    assert.equal(uploadRequests.length, 2);
    assert.deepEqual(uploadRequests.map((request) => request.createThread), [true, true]);
    assert.deepEqual(
      uploadRequests.map((request) => (request.assistantChatTranscriptSessionPointer as Record<string, unknown>).id),
      [firstChat.conversationId, firstChat.conversationId]
    );
    assert.equal(inferenceRequests[1]?.createThread, false);
    assert.equal(inferenceRequests[1]?.isPartialTranscript, true);
    const secondTranscript = inferenceRequests[1]?.transcript as Array<Record<string, unknown>>;
    assert.deepEqual(secondTranscript.map((step) => step.type), ["config", "context", "updated-config", "computer-file", "user"]);
    const secondFile = secondTranscript.find((step) => step.type === "computer-file") as Record<string, unknown>;
    assert.equal(secondFile.fileUrl, `${SPACE_ID}:server-2.txt`);
    assert.equal(secondFile.fileName, "second.txt");
    await assert.rejects(
      () => client.chat({ prompt: "Reuse", conversationId: firstChat.conversationId, fileIds: [secondUpload.fileId] }),
      /can only be attached once/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcript handles enforce thread, transport, and process isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-transcript-isolation-"));
  let uploadCount = 0;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        uploadCount += 1;
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:isolation-${uploadCount}.txt`,
          signedGetUrl: `https://download.example/isolation-${uploadCount}`,
          signedUploadPostUrl: `https://upload.example/isolation-${uploadCount}`,
          postHeaders: [],
          fields: { key: `safe/isolation-${uploadCount}.txt` },
          chatId: pointer.id
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const first = await client.uploadAttachment({ base64: Buffer.from("one").toString("base64"), fileName: "one.txt", transport: "inference_transcript" });
    const second = await client.uploadAttachment({ base64: Buffer.from("two").toString("base64"), fileName: "two.txt", transport: "inference_transcript" });

    await assert.rejects(() => client.chat({ prompt: "Cross thread", fileIds: [first.fileId, second.fileId] }), /different conversations cannot be mixed/);
    await assert.rejects(() => client.chat({ prompt: "Mixed", fileIds: [first.fileId, "agent-service-file"] }), /cannot be mixed/);
    await assert.rejects(
      () => client.downloadAttachment({ conversationId: second.conversationId, fileId: first.fileId, returnBase64: true }),
      /another conversation/
    );

    const restarted = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(() => restarted.chat({ prompt: "Restart", fileIds: [first.fileId] }), /unknown or expired/);
    await assert.rejects(
      () => restarted.downloadAttachment({ conversationId: first.conversationId, fileId: first.fileId, returnBase64: true }),
      /unknown or expired/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace switching invalidates transcript sessions and handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-transcript-workspace-"));
  const spaceB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const viewB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:workspace.txt`,
          signedGetUrl: "https://download.example/workspace",
          signedUploadPostUrl: "https://upload.example/workspace",
          postHeaders: [],
          fields: { key: "safe/workspace.txt" },
          chatId: pointer.id
        });
      }
      if (endpoint === "loadUserContent") {
        return json({ recordMap: {
          user_root: { [USER_ID]: { value: { space_view_pointers: [
            { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", table: "space_view", spaceId: SPACE_ID },
            { id: viewB, table: "space_view", spaceId: spaceB }
          ] } } },
          space: {
            [SPACE_ID]: { value: { name: "Alpha", plan_type: "personal" } },
            [spaceB]: { value: { name: "Beta", plan_type: "personal" } }
          }
        } });
      }
      if (endpoint === "getInferenceTranscriptsForUser") return json({});
      return new Response("unexpected", { status: 500 });
    };

    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({
      base64: Buffer.from("workspace").toString("base64"),
      fileName: "workspace.txt",
      transport: "inference_transcript"
    });
    await client.switchWorkspace("Beta");
    assert.equal((await client.getCurrentWorkspace()).spaceId, spaceB);
    await assert.rejects(() => client.chat({ prompt: "Old handle", fileIds: [uploaded.fileId] }), /unknown or expired/);
    await assert.rejects(
      () => client.downloadAttachment({ conversationId: uploaded.conversationId, fileId: uploaded.fileId, returnBase64: true }),
      /unknown or expired/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcript storage rejects HTTP 201 instead of treating it as completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-transcript-status-"));
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 201 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:status.txt`,
          signedGetUrl: "https://download.example/status",
          signedUploadPostUrl: "https://upload.example/status",
          postHeaders: [],
          fields: { key: "safe/status.txt" },
          chatId: pointer.id
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(
      () => client.uploadAttachment({
        base64: Buffer.from("status").toString("base64"),
        fileName: "status.txt",
        transport: "inference_transcript"
      }),
      /unsupported HTTP 201/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit transcript uploads reject unknown conversations before account networking", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-unknown-transcript-target-"));
  let networkCalls = 0;
  try {
    const unresolved = config(root);
    unresolved.account.userId = "";
    unresolved.account.spaceId = "";
    const fakeFetch = async (): Promise<Response> => {
      networkCalls += 1;
      return json({ message: "unexpected" }, 500);
    };
    const client = new NotionClient(unresolved, fakeFetch as typeof fetch);
    await assert.rejects(
      () => client.uploadAttachment({
        base64: "YQ==",
        fileName: "unknown.txt",
        conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        transport: "inference_transcript"
      }),
      /requires an active inference-transcript conversation/
    );
    assert.equal(networkCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto mode falls back after a generic Agent Service HTTP 400", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-generic-400-fallback-"));
  const endpoints: string[] = [];
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1) ?? "";
      endpoints.push(endpoint);
      if (endpoint === "createAgentServiceFileUploadURL") return json({ message: "invalid input" }, 400);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:fallback-400.txt`,
          signedGetUrl: "https://download.example/fallback-400",
          signedUploadPostUrl: "https://upload.example/fallback-400",
          postHeaders: [],
          fields: { key: "safe/fallback-400.txt" },
          chatId: pointer.id
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({ base64: "YQ==", fileName: "fallback.txt", transport: "auto" });
    assert.equal(uploaded.transport, "inference_transcript");
    assert.deepEqual(endpoints, ["createAgentServiceFileUploadURL", "getUploadFileUrlForAssistantChatTranscriptUpload"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple transcript handles from one thread are attached in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-multi-transcript-"));
  const uploadRequests: Array<Record<string, unknown>> = [];
  let inferenceRequest: Record<string, unknown> | undefined;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const body = requestBody(init);
        uploadRequests.push(body);
        const pointer = body.assistantChatTranscriptSessionPointer as Record<string, unknown>;
        const index = uploadRequests.length;
        return json({
          url: `${SPACE_ID}:multi-${index}.txt`,
          signedGetUrl: `https://download.example/multi-${index}`,
          signedUploadPostUrl: `https://upload.example/multi-${index}`,
          postHeaders: [],
          fields: { key: `safe/multi-${index}.txt` },
          chatId: pointer.id
        });
      }
      if (endpoint === "runInferenceTranscript") {
        inferenceRequest = requestBody(init);
        return inference("Both files received");
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const first = await client.uploadAttachment({ base64: "MQ==", fileName: "one.txt", transport: "inference_transcript" });
    const second = await client.uploadAttachment({
      base64: "Mg==",
      fileName: "two.txt",
      conversationId: first.conversationId,
      transport: "inference_transcript"
    });
    const chat = await client.chat({ prompt: "Compare", fileIds: [first.fileId, second.fileId] });
    assert.equal(chat.conversationId, first.conversationId);
    assert.equal(second.conversationId, first.conversationId);
    assert.deepEqual(
      uploadRequests.map((request) => (request.assistantChatTranscriptSessionPointer as Record<string, unknown>).id),
      [first.conversationId, first.conversationId]
    );
    const transcript = inferenceRequest?.transcript as Array<Record<string, unknown>>;
    assert.deepEqual(transcript.map((step) => step.type), ["config", "context", "computer-file", "computer-file", "user"]);
    assert.deepEqual(
      transcript.filter((step) => step.type === "computer-file").map((step) => step.fileName),
      ["one.txt", "two.txt"]
    );
    await assert.rejects(
      () => client.chat({ prompt: "Reuse", conversationId: chat.conversationId, fileIds: [first.fileId, second.fileId] }),
      /can only be attached once/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing file_token rejects before contacting file.notion.com", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-missing-file-token-"));
  let proxyCalls = 0;
  let fileHostCalls = 0;
  try {
    const configured = config(root);
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      if (url.hostname === "app.notion.com") {
        proxyCalls += 1;
        return new Response(null, { status: 302, headers: { location: "https://file.notion.com/safe/missing-token.txt" } });
      }
      if (url.hostname === "file.notion.com") {
        fileHostCalls += 1;
        return new Response("should-not-download", { status: 200 });
      }
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:missing-token.txt`,
          signedGetUrl: "https://download.example/missing-token",
          signedUploadPostUrl: "https://upload.example/missing-token",
          postHeaders: [],
          fields: { key: "safe/missing-token.txt" },
          chatId: pointer.id
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(configured, fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({ base64: "YQ==", fileName: "missing-token.txt", transport: "inference_transcript" });
    configured.account.fullCookie = "token_v2=test-token";
    await assert.rejects(
      () => client.downloadAttachment({ conversationId: uploaded.conversationId, fileId: uploaded.fileId, returnBase64: true }),
      /requires file_token/
    );
    assert.equal(proxyCalls, 1);
    assert.equal(fileHostCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed transcript uploads poll task_output and emit official attachment steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-processed-transcript-"));
  const outputKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const processRequests: Array<Record<string, unknown>> = [];
  const syncRequests: Array<Record<string, unknown>> = [];
  let syncCalls = 0;
  let inferenceRequest: Record<string, unknown> | undefined;
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:processed.csv`,
          signedGetUrl: "https://download.example/processed",
          signedUploadPostUrl: "https://upload.example/processed",
          postHeaders: [],
          fields: { key: "safe/processed.csv" },
          chatId: pointer.id
        });
      }
      if (endpoint === "processAgentAttachment") {
        processRequests.push(requestBody(init));
        return json({ outputKey, spaceId: SPACE_ID });
      }
      if (endpoint === "syncRecordValuesMain") {
        syncCalls += 1;
        syncRequests.push(requestBody(init));
        const status = syncCalls === 1 ? "in_progress" : "complete";
        const value = status === "complete" ? {
          result: {
            type: "success",
            data: {
              attachmentRisk: "scanned",
              contentType: "text/csv",
              fileSizeBytes: 4,
              numFields: 2,
              numRows: 1,
              stepMetadata: {
                fileSizeBytes: 4,
                numFields: 2,
                numRows: 1,
                guardrail: { attachmentRisk: "scanned" }
              }
            }
          }
        } : {};
        return json({ recordMap: { task_output: { [outputKey]: { value: { version: syncCalls, status, value } } } } });
      }
      if (endpoint === "runInferenceTranscript") {
        inferenceRequest = requestBody(init);
        return inference("Processed");
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    const uploaded = await client.uploadAttachment({
      base64: Buffer.from("a,b\n").toString("base64"),
      fileName: "processed.csv",
      mimeType: "text/csv",
      transport: "inference_transcript",
      processForInference: true
    });
    assert.equal(uploaded.processedForInference, true);
    assert.equal(syncCalls, 2);
    assert.deepEqual(processRequests[0], {
      url: `${SPACE_ID}:processed.csv`,
      spaceId: SPACE_ID,
      aiSessionPointer: { table: "thread", id: uploaded.conversationId, spaceId: SPACE_ID },
      source: "user_upload",
      clientVersion: "23.13.test"
    });
    assert.deepEqual(syncRequests[0], {
      requests: [{ pointer: { table: "task_output", id: outputKey, spaceId: SPACE_ID }, version: -1 }]
    });
    await client.chat({ prompt: "Analyze", fileIds: [uploaded.fileId] });
    const transcript = inferenceRequest?.transcript as Array<Record<string, unknown>>;
    assert.deepEqual(transcript.map((step) => step.type), ["config", "context", "attachment", "user"]);
    const attachment = transcript[2] as Record<string, unknown>;
    assert.equal(attachment.contentType, "text/csv");
    assert.equal(attachment.fileName, "processed.csv");
    assert.deepEqual(attachment.metadata, {
      fileSizeBytes: 4,
      numFields: 2,
      numRows: 1,
      guardrail: { attachmentRisk: "scanned" },
      attachmentSource: "user_upload"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed transcript uploads surface validated task errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "notion-ai-processed-error-"));
  const outputKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  try {
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.hostname === "upload.example") return new Response(null, { status: 204 });
      const endpoint = url.pathname.split("/").at(-1);
      if (endpoint === "getUploadFileUrlForAssistantChatTranscriptUpload") {
        const pointer = requestBody(init).assistantChatTranscriptSessionPointer as Record<string, unknown>;
        return json({
          url: `${SPACE_ID}:protected.pdf`,
          signedGetUrl: "https://download.example/protected",
          signedUploadPostUrl: "https://upload.example/protected",
          postHeaders: [],
          fields: { key: "safe/protected.pdf" },
          chatId: pointer.id
        });
      }
      if (endpoint === "processAgentAttachment") return json({ outputKey, spaceId: SPACE_ID });
      if (endpoint === "syncRecordValuesMain") {
        return json({ recordMap: { task_output: { [outputKey]: { value: {
          version: 1,
          status: "complete",
          value: { result: { type: "error", data: { code: "PASSWORD_PROTECTED", message: "Password required" } } }
        } } } } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const client = new NotionClient(config(root), fakeFetch as typeof fetch);
    await assert.rejects(
      () => client.uploadAttachment({
        base64: "YQ==",
        fileName: "protected.pdf",
        mimeType: "application/pdf",
        transport: "inference_transcript",
        processForInference: true
      }),
      /PASSWORD_PROTECTED.*Password required/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
