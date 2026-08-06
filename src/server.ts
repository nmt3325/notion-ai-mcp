import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { NotionClient } from "./notion-client.js";
import type { McpAuth } from "./mcp-connections.js";
import { listModels } from "./models.js";

export const SERVER_VERSION = "0.7.5";

const authShape = z.object({
  type: z.enum(["none", "bearer", "token", "apiKey", "basic", "header", "oauth"]).describe("Authentication style expected by the MCP server"),
  token: z.string().optional().describe("Bearer/token value"),
  key: z.string().optional().describe("API key value"),
  headerName: z.string().optional().describe("Header name for apiKey auth (default X-API-Key)"),
  username: z.string().optional().describe("Basic auth user"),
  password: z.string().optional().describe("Basic auth password"),
  headers: z.record(z.string(), z.string()).optional().describe("Raw header map for header auth")
});

type AuthInput = z.infer<typeof authShape>;

export function toMcpAuth(input: AuthInput | undefined): McpAuth | undefined {
  if (!input) return undefined;
  switch (input.type) {
    case "none": return { type: "none" };
    case "oauth": return { type: "oauth" };
    case "bearer":
    case "token": {
      const token = input.token?.trim();
      if (!token) throw new Error("auth.token is required for bearer/token authentication");
      return { type: "bearer", token };
    }
    case "apiKey": {
      const key = input.key?.trim();
      if (!key) throw new Error("auth.key is required for apiKey authentication");
      return { type: "apiKey", key, ...(input.headerName?.trim() ? { headerName: input.headerName.trim() } : {}) };
    }
    case "basic": {
      if (!input.username || !input.password) throw new Error("auth.username and auth.password are required for basic authentication");
      return { type: "basic", username: input.username, password: input.password };
    }
    case "header": {
      const headers = input.headers ?? {};
      if (Object.keys(headers).length === 0) throw new Error("auth.headers must contain at least one header");
      return { type: "header", headers };
    }
    default: {
      const exhaustive: never = input.type;
      throw new Error(`Unsupported auth type ${String(exhaustive)}`);
    }
  }
}

function result(value: unknown, text?: string): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  const structured = Array.isArray(value) ? { items: value } : (value as Record<string, unknown>);
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(value, null, 2) }],
    structuredContent: structured
  };
}

export function createServer(client: NotionClient): McpServer {
  const server = new McpServer({ name: "notion-ai-mcp", version: SERVER_VERSION });
  const modelHint = listModels().map((entry) => `${entry.modelId} (${entry.aliases.join(", ")})`).join("; ");

  server.registerTool("notion_ai_chat", {
    title: "Chat with Notion AI",
    description: "Send a prompt to Notion AI and return the fully aggregated streamed answer. Accepts friendly model names as well as internal IDs.",
    inputSchema: {
      prompt: z.string().min(1).describe("Prompt to send to Notion AI"),
      model: z.string().min(1).optional().describe(`Model name or internal ID. Known: ${modelHint}`),
      conversationId: z.string().uuid().optional().describe("ID returned by a previous notion_ai_chat call in this server process"),
      webSearch: z.boolean().default(false).describe("Allow Notion AI web search"),
      workspaceSearch: z.boolean().default(false).describe("Allow Notion workspace search"),
      readOnly: z.boolean().default(true).describe("Use Notion Ask/read-only mode"),
      attachments: z.array(z.object({
        name: z.string().min(1),
        url: z.string().min(1).optional(),
        text: z.string().optional(),
        mimeType: z.string().optional()
      })).optional().describe("Files or inline text to attach to the prompt")
    }
  }, async (input) => {
    const chat = await client.chat({
      prompt: input.prompt,
      webSearch: input.webSearch,
      workspaceSearch: input.workspaceSearch,
      readOnly: input.readOnly,
      ...(input.model ? { model: input.model } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {})
    });
    return result(chat, chat.text);
  });

  server.registerTool("list_conversations", {
    title: "List Notion AI conversations",
    description: "List Notion AI workflow/chat threads in the active workspace.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).optional(),
      maxPages: z.number().int().min(1).max(50).default(10)
    }
  }, async (input) => result(await client.listConversations({ limit: input.limit, maxPages: input.maxPages, ...(input.cursor ? { cursor: input.cursor } : {}) })));

  server.registerTool("get_conversation", {
    title: "Get a Notion AI conversation",
    description: "Get user-visible messages from one Notion AI thread.",
    inputSchema: {
      conversationId: z.string().uuid(),
      maxPages: z.number().int().min(1).max(100).default(20)
    }
  }, async ({ conversationId, maxPages }) => result(await client.getConversation(conversationId, maxPages)));

  server.registerTool("list_workspaces", {
    title: "List Notion workspaces",
    description: "List every workspace on the signed-in account, flagging the current, pinned, and credit-exhausted ones.",
    inputSchema: {}
  }, async () => result(await client.listWorkspaces()));

  server.registerTool("get_current_workspace", {
    title: "Get the active workspace",
    description: "Show which workspace Notion AI calls currently run in.",
    inputSchema: {}
  }, async () => result(await client.getCurrentWorkspace()));

  server.registerTool("switch_workspace", {
    title: "Switch workspace",
    description: "Switch the active workspace by space ID or name.",
    inputSchema: {
      workspace: z.string().min(1).describe("Space ID or (partial) workspace name"),
      pin: z.boolean().default(false).describe("Keep using this workspace even after automatic rotation")
    }
  }, async ({ workspace, pin }) => result(await client.switchWorkspace(workspace, pin)));

  server.registerTool("create_workspace", {
    title: "Create a workspace",
    description: "Create a new personal workspace, which also resets the free AI credit allowance, and switch to it.",
    inputSchema: {
      name: z.string().min(1).optional().describe("Workspace name; defaults to an auto-generated one"),
      switchTo: z.boolean().default(true).describe("Switch the client to the new workspace"),
      pin: z.boolean().default(true).describe("Pin the new workspace so rotation does not move away from it")
    }
  }, async ({ name, switchTo, pin }) => result(await client.createWorkspace(name, { switchTo, pin })));

  server.registerTool("list_mcp_connections", {
    title: "List MCP connections",
    description: "List the custom MCP servers this server registered in Notion.",
    inputSchema: {}
  }, async () => result(client.mcp().list()));

  server.registerTool("add_mcp_connection", {
    title: "Add an MCP connection",
    description: "Register a custom MCP server in Notion (Settings > Connections > MCP) with bearer, token, API key, basic, raw header, or no authentication.",
    inputSchema: {
      name: z.string().min(1),
      serverUrl: z.string().min(1).describe("https URL of the MCP endpoint"),
      auth: authShape.optional(),
      transport: z.string().min(1).optional().describe("Preferred transport, defaults to http")
    }
  }, async ({ name, serverUrl, auth, transport }) => result(await client.mcp().add({
    name,
    serverUrl,
    ...(toMcpAuth(auth) ? { auth: toMcpAuth(auth) as McpAuth } : {}),
    ...(transport ? { transport } : {})
  })));

  server.registerTool("update_mcp_connection", {
    title: "Update an MCP connection",
    description: "Rename, re-point, or re-authenticate a registered MCP connection.",
    inputSchema: {
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      serverUrl: z.string().min(1).optional(),
      auth: authShape.optional(),
      transport: z.string().min(1).optional()
    }
  }, async ({ id, name, serverUrl, auth, transport }) => result(await client.mcp().update(id, {
    ...(name ? { name } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    ...(toMcpAuth(auth) ? { auth: toMcpAuth(auth) as McpAuth } : {}),
    ...(transport ? { transport } : {})
  })));

  server.registerTool("remove_mcp_connection", {
    title: "Remove an MCP connection",
    description: "Delete a custom MCP connection from the workspace.",
    inputSchema: { id: z.string().min(1) }
  }, async ({ id }) => result(await client.mcp().remove(id)));

  server.registerTool("get_mcp_connection_status", {
    title: "Get MCP connection status",
    description: "Check the stored authentication/OAuth status of one MCP connection.",
    inputSchema: { id: z.string().min(1) }
  }, async ({ id }) => result(await client.mcp().status(id)));

  server.registerTool("check_mcp_oauth_support", {
    title: "Check MCP OAuth support",
    description: "Ask Notion whether an MCP server advertises OAuth, before choosing an auth method.",
    inputSchema: { serverUrl: z.string().min(1) }
  }, async ({ serverUrl }) => result(await client.mcp().checkOAuthSupport(serverUrl)));

  server.registerTool("start_mcp_oauth", {
    title: "Start MCP OAuth",
    description: "Begin the OAuth flow for an MCP server and return the authorization URL to open in a browser.",
    inputSchema: {
      serverUrl: z.string().min(1),
      name: z.string().min(1).optional()
    }
  }, async ({ serverUrl, name }) => result(await client.mcp().startOAuth(serverUrl, name)));

  server.registerTool("list_preconfigured_mcp_servers", {
    title: "List preconfigured MCP servers",
    description: "List the MCP servers Notion offers out of the box.",
    inputSchema: {}
  }, async () => result(await client.mcp().listPreconfigured()));

  server.registerTool("connect_preconfigured_mcp_server", {
    title: "Connect a preconfigured MCP server",
    description: "Connect one of Notion's built-in MCP integrations by its catalog ID.",
    inputSchema: { preconfiguredServerId: z.string().min(1) }
  }, async ({ preconfiguredServerId }) => result(await client.mcp().connectPreconfigured(preconfiguredServerId)));

  return server;
}

export async function runServer(): Promise<void> {
  const client = new NotionClient(loadConfig());
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}
