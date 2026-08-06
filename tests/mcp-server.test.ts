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
  "update_mcp_connection"
];

function fakeClient(): { client: NotionClient; chatCalls: Array<Record<string, unknown>>; added: Array<Record<string, unknown>> } {
  const chatCalls: Array<Record<string, unknown>> = [];
  const added: Array<Record<string, unknown>> = [];
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
    mcp: () => ({
      list: () => [{ id: "module-1", name: "DeepWiki" }],
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
  return { client, chatCalls, added };
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

test("notion_ai_chat forwards model and attachments and returns the answer text", async () => {
  const { client, chatCalls } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const response = await mcpClient.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello", model: "thinking", attachments: [{ name: "notes.md", text: "hi" }] } });
    assert.equal(response.isError, undefined);
    assert.equal(Array.isArray(response.content) && response.content[0]?.type === "text" ? response.content[0].text : "", "Mock answer");
    assert.equal(chatCalls[0]?.model, "thinking");
    assert.deepEqual(chatCalls[0]?.attachments, [{ name: "notes.md", text: "hi" }]);
  } finally { await close(); }
});

test("management tools reach the workspace and MCP managers", async () => {
  const { client, added } = fakeClient();
  const { mcpClient, close } = await connect(client);
  try {
    const workspaces = await mcpClient.callTool({ name: "list_workspaces", arguments: {} });
    assert.deepEqual((workspaces.structuredContent as { items: Array<{ spaceId: string }> }).items[0]?.spaceId, "space-1");
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
