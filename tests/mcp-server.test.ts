import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NotionClient } from "../src/notion-client.js";
import { createServer } from "../src/server.js";

test("MCP server advertises and executes the three required tools", async () => {
  const fakeNotionClient = {
    chat: async () => ({
      conversationId: "11111111-1111-4111-8111-111111111111",
      text: "Mock answer",
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 2 }
    }),
    listConversations: async () => ({ conversations: [], nextCursor: null, hasMore: false }),
    getConversation: async (id: string) => ({
      id,
      title: "Mock",
      type: "workflow",
      createdAt: null,
      updatedAt: null,
      messages: []
    })
  } as unknown as NotionClient;

  const server = createServer(fakeNotionClient);
  const client = new Client({ name: "notion-ai-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "get_conversation",
      "list_conversations",
      "notion_ai_chat"
    ]);
    const result = await client.callTool({ name: "notion_ai_chat", arguments: { prompt: "Hello" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Mock answer");
  } finally {
    await client.close();
    await server.close();
  }
});
