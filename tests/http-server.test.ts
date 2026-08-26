import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NotionClient } from "../src/notion-client.js";
import { createRemoteMcpHttpServer } from "../src/http-server.js";

const bearerToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function fakeClient(): NotionClient {
  return {
    chat: async () => ({
      conversationId: "11111111-1111-4111-8111-111111111111",
      text: "Remote mock answer",
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 2 }
    }),
    chatWithWait: async () => ({
      status: "completed",
      jobId: "job-1",
      conversationId: "11111111-1111-4111-8111-111111111111",
      text: "Remote mock answer",
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 2 }
    }),
    startChat: async () => ({ status: "running", jobId: "job-1", conversationId: "11111111-1111-4111-8111-111111111111", model: "mock-model", startedAt: 1, hint: "Collect it with get_chat_result." }),
    chatResult: async () => ({ status: "completed", source: "job", conversationId: "11111111-1111-4111-8111-111111111111", text: "Remote mock answer", startedAt: 1, elapsedMs: 2 }),
    listChatJobs: () => [],
    chatStatePath: () => null,
    chatStateError: () => null,
    listConversations: async () => ({ conversations: [], nextCursor: null, hasMore: false }),
    renameConversation: async (id: string, title: string) => ({ conversationId: id, previousTitle: "Remote mock", title, changed: true }),
    deleteConversation: async (id: string) => ({ conversationId: id, title: "Remote mock", deleted: true, alreadyDeleted: false }),
    getConversation: async (id: string) => ({
      id,
      title: "Remote mock",
      type: "workflow",
      createdAt: null,
      updatedAt: null,
      messages: []
    }),
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false })
  } as unknown as NotionClient;
}

test("Streamable HTTP server requires bearer auth and executes MCP tools", async () => {
  const remote = createRemoteMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    bearerToken,
    sessionTtlMs: 60_000,
    maxSessions: 5,
    clientFactory: fakeClient,
    logger: () => undefined
  });
  const address = await remote.listen();
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    })
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

  const health = await fetch(new URL("/healthz", endpoint));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${bearerToken}` } }
  });
  const client = new Client({ name: "notion-ai-http-test", version: "1.0.0" });
  try {
    // SDK 1.29 declarations conflict under exactOptionalPropertyTypes, while
    // the client transport implements the Transport contract at runtime.
    await client.connect(transport as unknown as Transport);
    assert.equal(remote.sessionCount(), 1);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
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
    ]);
    const result = await client.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello" } });
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Remote mock answer");
    await transport.terminateSession();
    assert.equal(remote.sessionCount(), 0);
  } finally {
    await client.close().catch(() => undefined);
    await remote.close();
  }
});
