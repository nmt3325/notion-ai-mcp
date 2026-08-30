import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NotionClient } from "../src/notion-client.js";
import { createServer, toMcpAuth } from "../src/server.js";

export const EXPECTED_TOOLS = [
  "add_mcp_connection",
  "check_mcp_oauth_support",
  "complete_mcp_oauth",
  "connect_preconfigured_mcp_server",
  "create_workspace",
  "delete_conversation",
  "download_attachment",
  "get_chat_result",
  "get_conversation",
  "get_current_workspace",
  "get_mcp_connection_status",
  "list_chat_jobs",
  "list_conversations",
  "list_mcp_connections",
  "list_preconfigured_mcp_servers",
  "list_workspaces",
  "notion_ai_chat",
  "remove_mcp_connection",
  "rename_conversation",
  "start_mcp_oauth",
  "switch_workspace",
  "update_mcp_connection",
  "upload_attachment"
];

function fakeClient(): { client: NotionClient; chatCalls: Array<Record<string, unknown>>; added: Array<Record<string, unknown>>; uploaded: Array<Record<string, unknown>>; downloaded: Array<Record<string, unknown>>; lookups: Array<Record<string, unknown>>; waits: Array<number | undefined> } {
  const chatCalls: Array<Record<string, unknown>> = [];
  const added: Array<Record<string, unknown>> = [];
  const uploaded: Array<Record<string, unknown>> = [];
  const downloaded: Array<Record<string, unknown>> = [];
  const lookups: Array<Record<string, unknown>> = [];
  const waits: Array<number | undefined> = [];
  const client = {
    chat: async (options: Record<string, unknown>) => {
      chatCalls.push(options);
      return { conversationId: "11111111-1111-4111-8111-111111111111", text: "Mock answer", model: "mock-model", usage: { inputTokens: 1, outputTokens: 2 } };
    },
    startChat: async (options: Record<string, unknown>) => {
      chatCalls.push(options);
      return { status: "running", jobId: "job-1", conversationId: "11111111-1111-4111-8111-111111111111", model: "mock-model", startedAt: 1, hint: "Collect it with get_chat_result." };
    },
    chatWithWait: async (options: Record<string, unknown>, waitMs?: number) => {
      chatCalls.push(options);
      waits.push(waitMs);
      return { status: "completed", jobId: "job-1", conversationId: "11111111-1111-4111-8111-111111111111", text: "Mock answer", model: "mock-model", usage: { inputTokens: 1, outputTokens: 2 } };
    },
    chatResult: async (options: Record<string, unknown>) => {
      lookups.push(options);
      return { status: "completed", source: "thread", conversationId: "11111111-1111-4111-8111-111111111111", text: "Recovered answer", startedAt: 1, elapsedMs: 2 };
    },
    listChatJobs: (options: Record<string, unknown>) => {
      lookups.push(options);
      return [{ jobId: "job-1", conversationId: "11111111-1111-4111-8111-111111111111", status: "running", model: "mock-model", prompt: "Hello", turn: 1, transport: "inference_transcript", startedAt: 1 }];
    },
    chatStatePath: () => "/tmp/notion-ai-mcp-state.json",
    chatStateError: () => null,
    listConversations: async () => ({ conversations: [], nextCursor: null, hasMore: false }),
    getConversation: async (id: string) => ({ id, title: "Mock", type: "workflow", createdAt: null, updatedAt: null, messages: [] }),
    renameConversation: async (id: string, title: string) => ({ conversationId: id, previousTitle: "Mock", title, changed: true }),
    deleteConversation: async (id: string) => ({ conversationId: id, title: "Mock", deleted: true, alreadyDeleted: false }),
    listWorkspaces: async () => [{ spaceId: "space-1", name: "Mock Space", current: true }],
    getCurrentWorkspace: async () => ({ spaceId: "space-1", spaceName: "Mock Space" }),
    switchWorkspace: async (selector: string, pin = false) => ({ spaceId: selector, pinned: pin }),
    createWorkspace: async (name?: string) => ({ spaceId: "space-2", name: name ?? "auto", switched: true }),
    uploadAttachment: async (options: Record<string, unknown>) => {
      uploaded.push(options);
      return { fileId: "file-1", fileName: "notes.txt", mediaType: "text/plain", sizeBytes: 5, target: { type: "user" }, file: { id: "file-1", filename: "notes.txt", media_type: "text/plain", size_bytes: 5 } };
    },
    downloadAttachment: async (options: Record<string, unknown>) => {
      downloaded.push(options);
      return { fileId: "file-1", fileName: "notes.txt", mediaType: "text/plain", sizeBytes: 5, base64: "aGVsbG8=" };
    },
    mcp: () => ({
      list: async () => [{ id: "module-1", name: "DeepWiki" }],
      add: async (input: Record<string, unknown>) => { added.push(input); return { id: "module-1", ...input }; },
      update: async () => ({ id: "module-1" }),
      remove: async () => ({ id: "module-1", removed: true }),
      status: async () => ({ id: "module-1", authType: "bearer" }),
      checkOAuthSupport: async () => ({ supportsOAuth: true }),
      startOAuth: async () => ({ authorizationUrl: "https://example.com/authorize" }),
      listPreconfigured: async () => [{ id: "preconfigured-1", name: "Amplitude" }],
      connectPreconfigured: async () => ({ id: "preconfigured-1", connected: true })
    }),
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false })
  } as unknown as NotionClient;
  return { client, chatCalls, added, uploaded, downloaded, lookups, waits };
}

async function connect(client: NotionClient): Promise<{ mcpClient: Client; close: () => Promise<void> }> {
  const server = createServer(client);
  const mcpClient = new Client({ name: "notion-ai-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, close: async () => { await mcpClient.close(); await server.close(); } };
}

test("MCP server advertises chat, workspace, and MCP management tools", async () => {
  const { client } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const tools = await mcpClient.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    const chatTool = tools.tools.find((tool) => tool.name === "notion_ai_chat");
    const properties = (chatTool?.inputSchema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties;
    assert.equal(properties?.readOnly?.default, false);
  } finally { await close(); }
});

test("notion_ai_chat forwards model and uploaded file IDs and returns the answer text", async () => {
  const { client, chatCalls } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const response = await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello", model: "thinking", reasoningEffort: "high", fileIds: ["file-1"] } });
    assert.equal(response.isError, undefined);
    assert.equal(Array.isArray(response.content) && response.content[0]?.type === "text" ? response.content[0].text : "", "Mock answer");
    assert.equal(chatCalls[0]?.model, "thinking");
    assert.equal(chatCalls[0]?.reasoningEffort, "high");
    assert.deepEqual(chatCalls[0]?.fileIds, ["file-1"]);
    assert.equal(chatCalls[0]?.readOnly, false);
  } finally { await close(); }
});

test("attachment tools forward upload and download options", async () => {
  const { client, uploaded, downloaded } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const upload = await mcpClient.callTool({ name: "upload_attachment", arguments: { base64: "aGVsbG8=", fileName: "notes.txt", mimeType: "text/plain", transport: "inference_transcript", processForInference: true } });
    assert.equal((upload.structuredContent as { fileId: string }).fileId, "file-1");
    assert.deepEqual(uploaded[0], { base64: "aGVsbG8=", fileName: "notes.txt", mimeType: "text/plain", transport: "inference_transcript", processForInference: true });
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const download = await mcpClient.callTool({ name: "download_attachment", arguments: { conversationId, fileId: "file-1", returnBase64: true } });
    assert.equal((download.structuredContent as { base64: string }).base64, "aGVsbG8=");
    assert.deepEqual(downloaded[0], { conversationId, fileId: "file-1", returnBase64: true, overwrite: false });
    const legacy = {
      url: "https://secure.example/artifact",
      fileName: "artifact.md",
      mimeType: "text/markdown",
      permissionRecord: {
        table: "thread",
        id: conversationId,
        spaceId: "22222222-2222-4222-8222-222222222222"
      }
    };
    await mcpClient.callTool({ name: "download_attachment", arguments: { legacy } });
    assert.deepEqual(downloaded[1], { legacy, returnBase64: false, overwrite: false });
  } finally { await close(); }
});

test("management tools reach the workspace and MCP managers", async () => {
  const { client, added } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const workspaces = await mcpClient.callTool({ name: "list_workspaces", arguments: {} });
    assert.deepEqual((workspaces.structuredContent as { items: Array<{ spaceId: string }> }).items[0]?.spaceId, "space-1");
    const mcpConnections = await mcpClient.callTool({ name: "list_mcp_connections", arguments: {} });
    assert.equal((mcpConnections.structuredContent as { items: Array<{ id: string }> }).items[0]?.id, "module-1");
    const switched = await mcpClient.callTool({ name: "switch_workspace", arguments: { workspace: "space-9", pin: true } });
    assert.deepEqual(switched.structuredContent, { spaceId: "space-9", pinned: true });
    await mcpClient.callTool({ name: "add_mcp_connection", arguments: { name: "DeepWiki", serverUrl: "https://mcp.example.com/mcp", auth: { type: "apiKey", key: "k", headerName: "X-Key" } } });
    assert.deepEqual(added[0]?.auth, { type: "apiKey", key: "k", headerName: "X-Key" });
  } finally { await close(); }
});

test("toMcpAuth rejects incomplete credentials", () => {
  assert.throws(() => toMcpAuth({ type: "bearer" }), /auth.token/);
  assert.throws(() => toMcpAuth({ type: "basic", username: "u" }), /auth.username/);
  assert.throws(() => toMcpAuth({ type: "header", headers: {} }), /auth.headers/);
  assert.deepEqual(toMcpAuth({ type: "none" }), { type: "none" });
  assert.deepEqual(toMcpAuth({ type: "bearer", token: " b " }), { type: "bearer", token: "b" });
  assert.deepEqual(toMcpAuth({ type: "token", token: " t " }), { type: "token", token: "t" });
  assert.equal(toMcpAuth(undefined), undefined);
});

test("notion_ai_chat keeps the client under the 60s limit and hands back a pending job", async () => {
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const client = {
    chatWithWait: async () => ({
      status: "pending", jobId: "job-slow", conversationId, model: "mock-model", startedAt: 1, elapsedMs: 45_000,
      hint: "Still generating after 45s. Nothing is lost: call get_chat_result with jobId job-slow."
    }),
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false })
  } as unknown as NotionClient;
  const { mcpClient, close } = await connect(client);
  try {
    const response = await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Slow question", waitSeconds: 45 } });
    assert.equal(response.isError, undefined);
    const structured = response.structuredContent as { status: string; jobId: string; conversationId: string };
    assert.equal(structured.status, "pending");
    assert.equal(structured.jobId, "job-slow");
    assert.equal(structured.conversationId, conversationId);
    assert.match(Array.isArray(response.content) && response.content[0]?.type === "text" ? response.content[0].text : "", /get_chat_result/);
  } finally { await close(); }
});

test("notion_ai_chat background mode returns the conversation ID without waiting", async () => {
  const { client, chatCalls, waits } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const response = await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello", background: true } });
    const structured = response.structuredContent as { status: string; jobId: string };
    assert.equal(structured.status, "running");
    assert.equal(structured.jobId, "job-1");
    assert.equal(chatCalls.length, 1);
    assert.equal(waits.length, 0);
  } finally { await close(); }
});

test("notion_ai_chat forwards waitSeconds as milliseconds", async () => {
  const { client, waits } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello", waitSeconds: 30 } });
    assert.deepEqual(waits, [30_000]);
  } finally { await close(); }
});

test("get_chat_result and list_chat_jobs recover answers after a timed out call", async () => {
  const { client, lookups } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const recovered = await mcpClient.callTool({ name: "get_chat_result", arguments: { jobId: "job-1", waitSeconds: 5 } });
    assert.equal(Array.isArray(recovered.content) && recovered.content[0]?.type === "text" ? recovered.content[0].text : "", "Recovered answer");
    assert.deepEqual(lookups[0], { jobId: "job-1", waitMs: 5000 });
    const jobs = await mcpClient.callTool({ name: "list_chat_jobs", arguments: { status: "running" } });
    const structured = jobs.structuredContent as { jobs: Array<{ jobId: string }>; statePath: string };
    assert.equal(structured.jobs[0]?.jobId, "job-1");
    assert.equal(structured.statePath, "/tmp/notion-ai-mcp-state.json");
    assert.deepEqual(lookups[1], { status: "running", limit: 20 });
  } finally { await close(); }
});

const READ_ONLY_TOOLS = [
  "check_mcp_oauth_support",
  "get_chat_result",
  "get_conversation",
  "get_current_workspace",
  "get_mcp_connection_status",
  "list_chat_jobs",
  "list_conversations",
  "list_mcp_connections",
  "list_preconfigured_mcp_servers",
  "list_workspaces"
];

const DESTRUCTIVE_TOOLS = [
  "delete_conversation",
  "download_attachment",
  "notion_ai_chat",
  "remove_mcp_connection",
  "rename_conversation",
  "update_mcp_connection"
];

const REQUIRED_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

test("every tool declares explicit annotations so clients can group read, write, and destructive calls", async () => {
  const { client } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const { tools } = await mcpClient.listTools();
    for (const tool of tools) {
      for (const hint of REQUIRED_HINTS) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} is missing ${hint}`);
      }
      if (tool.annotations?.readOnlyHint === true) {
        assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} is read-only but flagged destructive`);
      }
    }
    assert.deepEqual(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name).sort(), READ_ONLY_TOOLS);
    assert.deepEqual(tools.filter((tool) => tool.annotations?.readOnlyHint === false && tool.annotations?.destructiveHint === true).map((tool) => tool.name).sort(), DESTRUCTIVE_TOOLS);
  } finally { await close(); }
});
