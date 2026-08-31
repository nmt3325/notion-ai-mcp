import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NotionClient } from "../src/notion-client.js";
import { createRemoteMcpHttpServer } from "../src/http-server.js";
import { EXPECTED_TOOL_NAMES } from "../src/tool-names.js";

const bearerToken = "test-only-not-a-secret-bearer-token-0000000000000000";

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
    chatDefaults: () => ({ webSearch: true, workspaceSearch: true, readOnly: false }),
    keepAwakeDefaults: () => ({ idleMs: 120_000, pollMs: 30_000, cooldownMs: 60_000, maxNudges: 40, deadlineMs: 10_800_000, enabled: true }),
    keepAliveStatePath: () => null,
    threadSignals: async (threadId: string) => ({ threadId, updatedTime: 1, serverNow: 2, messageCount: 1, lastTurnOutcome: null, credits: null })
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
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOL_NAMES]);
    const result = await client.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello" } });
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Remote mock answer");
    await transport.terminateSession();
    assert.equal(remote.sessionCount(), 0);
  } finally {
    await client.close().catch(() => undefined);
    await remote.close();
  }
});

test("every session is served by one shared client so background state outlives a single call", async () => {
  let built = 0;
  const remote = createRemoteMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    bearerToken,
    sessionTtlMs: 60_000,
    maxSessions: 5,
    clientFactory: () => { built += 1; return fakeClient(); },
    logger: () => undefined
  });
  const address = await remote.listen();
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const connect = async (): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${bearerToken}` } } });
    const client = new Client({ name: "notion-ai-http-test", version: "1.0.0" });
    // SDK 1.29 declarations conflict under exactOptionalPropertyTypes, while
    // the client transport implements the Transport contract at runtime.
    await client.connect(transport as unknown as Transport);
    return client;
  };
  const first = await connect();
  const second = await connect();
  try {
    assert.equal(remote.sessionCount(), 2);
    // Notion opens a new MCP session for every tool call, so a client per session would give each
    // call its own chat-job registry and its own keep-awake timers.
    assert.equal(built, 1);
    assert.equal(remote.resumeKeepAwake(), 0);
  } finally {
    await first.close();
    await second.close();
    await remote.close();
  }
});
