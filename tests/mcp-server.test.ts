import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NotionClient } from "../src/notion-client.js";
import { createServer, toMcpAuth } from "../src/server.js";

export const EXPECTED_TOOLS = [
  "add_mcp_connection",
  "check_mcp_oauth_support",
  "connect_preconfigured_mcp_server",
  "create_workspace",
  "download_attachment",
  "get_conversation",
  "get_current_workspace",
  "get_mcp_connection_status",
  "list_conversations",
  "list_mcp_connections",
  "list_preconfigured_mcp_servers",
  "list_workspaces",
  "notion_ai_chat",
  "remove_mcp_connection",
  "start_mcp_oauth",
  "switch_workspace",
  "update_mcp_connection",
  "upload_attachment"
];

function fakeClient(): { client: NotionClient; chatCalls: Array<Record<string, unknown>>; added: Array<Record<string, unknown>>; uploaded: Array<Record<string, unknown>>; downloaded: Array<Record<string, unknown>> } {
  const chatCalls: Array<Record<string, unknown>> = [];
  const added: Array<Record<string, unknown>> = [];
  const uploaded: Array<Record<string, unknown>> = [];
  const downloaded: Array<Record<string, unknown>> = [];
  const client = {
    chat: async (options: Record<string, unknown>) => {
      chatCalls.push(options);
      return { conversationId: "11111111-1111-4111-8111-111111111111", text: "Mock answer", model: "mock-model", usage: { inputTokens: 1, outputTokens: 2 } };
    },
    listConversations: async () => ({ conversations: [], nextCursor: null, hasMore: false }),
    getConversation: async (id: string) => ({ id, title: "Mock", type: "workflow", createdAt: null, updatedAt: null, messages: [] }),
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
    })
  } as unknown as NotionClient;
  return { client, chatCalls, added, uploaded, downloaded };
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
  } finally { await close(); }
});

test("notion_ai_chat forwards model and uploaded file IDs and returns the answer text", async () => {
  const { client, chatCalls } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const response = await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello", model: "thinking", fileIds: ["file-1"] } });
    assert.equal(response.isError, undefined);
    assert.equal(Array.isArray(response.content) && response.content[0]?.type === "text" ? response.content[0].text : "", "Mock answer");
    assert.equal(chatCalls[0]?.model, "thinking");
    assert.deepEqual(chatCalls[0]?.fileIds, ["file-1"]);
  } finally { await close(); }
});

test("attachment tools forward upload and download options", async () => {
  const { client, uploaded, downloaded } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const upload = await mcpClient.callTool({ name: "upload_attachment", arguments: { base64: "aGVsbG8=", fileName: "notes.txt", mimeType: "text/plain", transport: "inference_transcript" } });
    assert.equal((upload.structuredContent as { fileId: string }).fileId, "file-1");
    assert.deepEqual(uploaded[0], { base64: "aGVsbG8=", fileName: "notes.txt", mimeType: "text/plain", transport: "inference_transcript" });
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
  assert.equal(toMcpAuth(undefined), undefined);
});
