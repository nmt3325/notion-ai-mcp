import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { NotionClient } from "./notion-client.js";

export function createServer(client: NotionClient): McpServer {
  const server = new McpServer({ name: "notion-ai-mcp", version: "0.1.0" });

  server.registerTool(
    "notion_ai_chat",
    {
      title: "Chat with Notion AI",
      description:
        "Send a prompt to Notion AI through its unofficial internal API. Returns the fully aggregated streamed response.",
      inputSchema: {
        prompt: z.string().min(1).describe("Prompt to send to Notion AI"),
        model: z.string().min(1).optional().describe("Notion internal model ID; defaults to NOTION_DEFAULT_MODEL"),
        conversationId: z.string().uuid().optional().describe("ID returned by a previous notion_ai_chat call in this server process"),
        webSearch: z.boolean().default(false).describe("Allow Notion AI web search"),
        workspaceSearch: z.boolean().default(false).describe("Allow Notion workspace search"),
        readOnly: z.boolean().default(true).describe("Use Notion Ask/read-only mode; recommended for safety")
      }
    },
    async (input) => {
      const result = await client.chat({
        prompt: input.prompt,
        webSearch: input.webSearch,
        workspaceSearch: input.workspaceSearch,
        readOnly: input.readOnly,
        ...(input.model ? { model: input.model } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {})
      });
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List Notion AI conversations",
      description: "List Notion AI workflow/chat threads using getInferenceTranscriptsForUser.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).optional().describe("Opaque nextCursor returned by the previous call"),
        maxPages: z.number().int().min(1).max(50).default(10)
      }
    },
    async (input) => {
      const result = await client.listConversations({
        limit: input.limit,
        maxPages: input.maxPages,
        ...(input.cursor ? { cursor: input.cursor } : {})
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get a Notion AI conversation",
      description:
        "Get user-visible messages from one Notion AI thread. Operational steps, tool calls, and hidden thinking are omitted.",
      inputSchema: {
        conversationId: z.string().uuid().describe("Notion thread UUID from list_conversations"),
        maxPages: z.number().int().min(1).max(100).default(20)
      }
    },
    async ({ conversationId, maxPages }) => {
      const result = await client.getConversation(conversationId, maxPages);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  return server;
}

export async function runServer(): Promise<void> {
  const client = new NotionClient(loadConfig());
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}
