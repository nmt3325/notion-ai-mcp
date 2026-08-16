import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { NotionClient } from "./notion-client.js";
import type { McpAuth } from "./mcp-connections.js";
import { BUILTIN_ALIASES, listModels, modelReasoningEfforts, REASONING_EFFORTS } from "./models.js";

export const SERVER_VERSION = "0.8.0";
// Set at deploy time (docker build arg or env) so a caller can tell which commit is actually running.
const BUILD_COMMIT = process.env.NOTION_BUILD_COMMIT?.trim() || process.env.GIT_COMMIT?.trim() || "unknown";

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

type ProgressExtra = {
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification?: ((notification: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined;
};

/**
 * Emits periodic progress notifications while a slow call runs.
 *
 * MCP clients abandon a tool call after roughly 60 seconds; clients that honour progress keep waiting,
 * and for the rest the work still continues in a background job.
 */
async function withHeartbeat<T>(extra: unknown, run: () => Promise<T>): Promise<T> {
  const progress = extra as ProgressExtra | undefined;
  const progressToken = progress?._meta?.progressToken;
  const send = progress?.sendNotification;
  if (progressToken === undefined || typeof send !== "function") return run();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    // A transport the client already abandoned can reject *or* throw synchronously. An uncaught throw
    // inside a timer callback escapes the try/finally below and would kill the whole process, so both
    // paths are swallowed here.
    try {
      void Promise.resolve(send({ method: "notifications/progress", params: { progressToken, progress: ticks, message: `Notion AI is still generating (${ticks * 10}s)` } })).catch(() => { /* progress is best effort */ });
    } catch { /* progress is best effort */ }
  }, 10_000);
  timer.unref?.();
  try { return await run(); }
  finally { clearInterval(timer); }
}

export function toMcpAuth(input: AuthInput | undefined): McpAuth | undefined {
  if (!input) return undefined;
  switch (input.type) {
    case "none": return { type: "none" };
    case "oauth": return { type: "oauth" };
    case "bearer": {
      const token = input.token?.trim();
      if (!token) throw new Error("auth.token is required for bearer/token authentication");
      return { type: "bearer", token };
    }
    case "token": {
      const token = input.token?.trim();
      if (!token) throw new Error("auth.token is required for bearer/token authentication");
      return { type: "token", token };
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
  const defaults = client.chatDefaults();
  const canonicalModelIds = new Set(Object.values(BUILTIN_ALIASES));
  const modelHint = listModels().filter((entry) => entry.pickable || canonicalModelIds.has(entry.modelId)).map((entry) => `${entry.modelId} (${entry.aliases.join(", ")})`).join("; ");
  const effortHint = listModels()
    .filter((entry) => entry.pickable && modelReasoningEfforts(entry.modelId) !== undefined)
    .map((entry) => {
      const config = modelReasoningEfforts(entry.modelId);
      return config ? `${entry.modelId}: ${config.supported.join("|")} (default ${config.default})` : entry.modelId;
    })
    .join("; ");

  server.registerTool("notion_ai_chat", {
    title: "Chat with Notion AI",
    description: "Send a prompt to Notion AI and return the fully aggregated streamed answer. Waits up to waitSeconds (default 45s, below the ~60s point where MCP clients abandon a call) and otherwise returns status \"pending\" with jobId and conversationId so get_chat_result can collect the answer instead of losing it. Accepts friendly model names as well as internal IDs.",
    inputSchema: {
      prompt: z.string().min(1).describe("Prompt to send to Notion AI"),
      model: z.string().min(1).optional().describe(`Model name or internal ID. Known: ${modelHint}`),
      reasoningEffort: z.enum(REASONING_EFFORTS).optional().describe(`Thinking effort, sent as the same reasoningEffort field the Notion web client persists. Only models with an effort picker accept it. Per model: ${effortHint}`),
      conversationId: z.string().uuid().optional().describe("ID returned by a previous notion_ai_chat call, including one whose call timed out or ran before a restart; omit reasoningEffort to keep the effort already chosen for that conversation"),
      webSearch: z.boolean().optional().describe(`Allow Notion AI web search. Omitted means NOTION_DEFAULT_WEB_SEARCH (currently ${defaults.webSearch}).`),
      workspaceSearch: z.boolean().optional().describe(`Allow Notion workspace search. Omitted means NOTION_DEFAULT_WORKSPACE_SEARCH (currently ${defaults.workspaceSearch}).`),
      readOnly: z.boolean().optional().describe(`Ask/read-only mode. false is Agent mode, which lets Notion AI edit the workspace. Omitted means NOTION_DEFAULT_READ_ONLY (currently ${defaults.readOnly}).`),
      attachments: z.array(z.object({
        name: z.string().min(1),
        url: z.string().min(1).optional(),
        text: z.string().optional(),
        mimeType: z.string().optional()
      })).optional().describe("Legacy inline text/link context. Use upload_attachment plus fileIds for real files."),
      fileIds: z.array(z.string().min(1)).max(19).optional().describe("File IDs returned by upload_attachment. A new file chat uses the current Agent Service content-block format."),
      waitSeconds: z.number().int().min(1).max(55).optional().describe("Seconds to wait inline for the answer (default NOTION_CHAT_WAIT_MS, 45s). The cap stays under the ~60s client limit; when it passes, a pending job is returned instead of an error."),
      background: z.boolean().default(false).describe("Return jobId and conversationId immediately without waiting, then collect the answer with get_chat_result. Use this for prompts that need minutes of thinking.")
    }
  }, async (input, extra) => {
    const options = {
      prompt: input.prompt,
      ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
      ...(input.workspaceSearch === undefined ? {} : { workspaceSearch: input.workspaceSearch }),
      ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.fileIds ? { fileIds: input.fileIds } : {})
    };
    if (input.background) {
      const started = await client.startChat(options);
      return result(started, started.hint);
    }
    const chat = await withHeartbeat(extra, () => client.chatWithWait(options, input.waitSeconds === undefined ? undefined : input.waitSeconds * 1000));
    return result(chat, chat.status === "completed" ? chat.text : chat.hint);
  });

  server.registerTool("get_chat_result", {
    title: "Collect a chat answer",
    description: "Collect the answer of a chat that is still generating or whose call already timed out. Reads the background job and falls back to the conversation thread, so an answer is never lost at the client 60s limit.",
    inputSchema: {
      jobId: z.string().min(1).optional().describe("jobId returned by notion_ai_chat"),
      conversationId: z.string().uuid().optional().describe("Conversation to read the answer from; works for jobs from an earlier server process too"),
      userMessageId: z.string().uuid().optional().describe("userMessageId returned by notion_ai_chat. The answer is then the assistant message right after that request, which stays correct when the thread has newer turns or parallel requests."),
      waitSeconds: z.number().int().min(0).max(55).default(20).describe("Seconds to wait for the answer before returning the current status")
    }
  }, async (input, extra) => {
    // matchedBy tells the caller whether the answer was matched to their own request or guessed from the newest one.
    const lookup = await withHeartbeat(extra, () => client.chatResult({
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      waitMs: input.waitSeconds * 1000
    }));
    return result(lookup, lookup.text ?? lookup.error ?? lookup.hint ?? lookup.status);
  });

  server.registerTool("list_chat_jobs", {
    title: "List chat jobs",
    description: "List the background Notion AI chats tracked by this server, newest first, with status, conversation ID and prompt preview.",
    inputSchema: {
      status: z.enum(["running", "completed", "failed", "orphaned"]).optional().describe("Only jobs in this state. orphaned means the job was still running when the server restarted, so read it with get_chat_result."),
      limit: z.number().int().min(1).max(100).default(20)
    }
  }, async (input) => {
    const warning = client.chatStateError();
    return result({
      jobs: client.listChatJobs({ ...(input.status ? { status: input.status } : {}), limit: input.limit }),
      statePath: client.chatStatePath(),
      version: SERVER_VERSION,
      commit: BUILD_COMMIT,
      instanceId: client.chatStateInstance(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      ...(warning ? { stateWarning: warning } : {})
    });
  });

  server.registerTool("upload_attachment", {
    title: "Upload an attachment",
    description: "Upload a local or base64 file for Notion AI. Auto mode safely falls back to the current assistant-transcript transport; explicit Agent Service upload does the same when Notion reports that the retired endpoint is unavailable. Paths and sizes remain restricted.",
    inputSchema: {
      path: z.string().min(1).optional().describe("File path, absolute or relative to NOTION_ATTACHMENT_ROOT"),
      base64: z.string().min(1).optional().describe("Standard base64 file data"),
      fileName: z.string().min(1).optional().describe("Required for a meaningful base64 upload name; optional path override"),
      mimeType: z.string().min(1).optional(),
      conversationId: z.string().uuid().optional().describe("Existing conversation target; omit for a new file chat"),
      transport: z.enum(["auto", "agent_service", "inference_transcript"]).optional().describe("Upload transport. Auto falls back when Agent Service is unavailable."),
      processForInference: z.boolean().optional().describe("For explicit inference_transcript uploads, wait for Notion's processAgentAttachment result and emit a processed attachment step")
    }
  }, async (input) => result(await client.uploadAttachment({
    ...(input.path ? { path: input.path } : {}),
    ...(input.base64 ? { base64: input.base64 } : {}),
    ...(input.fileName ? { fileName: input.fileName } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.processForInference !== undefined ? { processForInference: input.processForInference } : {})
  })));

  server.registerTool("download_attachment", {
    title: "Download an attachment",
    description: "Download either an Agent Service thread file (conversationId + fileId) or a legacy Notion artifact (legacy URL + permissionRecord) to a safe local path and/or return base64.",
    inputSchema: {
      conversationId: z.string().uuid().optional().describe("Agent Service conversation ID; provide together with fileId"),
      fileId: z.string().min(1).optional().describe("File ID or opaque upload handle; provide together with conversationId"),
      legacy: z.object({
        url: z.string().min(1).max(8192).describe("Original HTTPS, root-relative, or attachment: Notion file URL"),
        fileName: z.string().min(1).max(255).describe("Plain output/download file name"),
        mimeType: z.string().min(1).max(255).optional(),
        permissionRecord: z.object({
          table: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
          id: z.string().uuid(),
          spaceId: z.string().uuid()
        })
      }).optional().describe("Legacy getSignedFileUrls mode; mutually exclusive with conversationId/fileId"),
      outputPath: z.string().min(1).optional().describe("Destination path under NOTION_ATTACHMENT_ROOT; defaults to downloads/<filename>"),
      returnBase64: z.boolean().default(false),
      overwrite: z.boolean().default(false)
    }
  }, async (input) => result(await client.downloadAttachment({
    returnBase64: input.returnBase64,
    overwrite: input.overwrite,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.fileId ? { fileId: input.fileId } : {}),
    ...(input.legacy ? { legacy: input.legacy } : {}),
    ...(input.outputPath ? { outputPath: input.outputPath } : {})
  })));

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

  server.registerTool("rename_conversation", {
    title: "Rename a Notion AI conversation",
    description: "Rename an existing Notion AI thread after verifying that it belongs to the active workspace.",
    inputSchema: {
      conversationId: z.string().uuid(),
      title: z.string().trim().min(1).max(500),
      maxPages: z.number().int().min(1).max(100).default(20)
    }
  }, async ({ conversationId, title, maxPages }) => result(await client.renameConversation(conversationId, title, maxPages)));

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
    description: "Create a personal workspace with the verified Web transaction flow, then optionally switch to and pin it.",
    inputSchema: {
      name: z.string().min(1).optional().describe("Workspace name; defaults to an auto-generated one"),
      switchTo: z.boolean().default(true).describe("Switch the client to the new workspace"),
      pin: z.boolean().default(true).describe("Pin the new workspace so rotation does not move away from it")
    }
  }, async ({ name, switchTo, pin }) => result(await client.createWorkspace(name, { switchTo, pin })));

  server.registerTool("list_mcp_connections", {
    title: "List MCP connections",
    description: "List custom MCP modules linked to the current Personal Agent, merged with safe local registry metadata.",
    inputSchema: {}
  }, async () => result(await client.mcp().list()));

  server.registerTool("add_mcp_connection", {
    title: "Add an MCP connection",
    description: "Register a custom MCP server and optionally restrict its enabled tools and confirmation policy.",
    inputSchema: {
      name: z.string().min(1),
      serverUrl: z.string().min(1).describe("https URL of the MCP endpoint"),
      auth: authShape.optional(),
      transport: z.string().min(1).optional().describe("Preferred transport, defaults to streamableHttp"),
      enabledToolNames: z.array(z.string().min(1)).max(1000).optional().describe("Exact discovered tool names to enable; omit to enable all"),
      runReadToolsAutomatically: z.boolean().optional().describe("Allow read-only tools to run without confirmation; defaults to true"),
      runWriteToolsAutomatically: z.boolean().optional().describe("Allow write tools to run without confirmation; defaults to false")
    }
  }, async ({ name, serverUrl, auth, transport, enabledToolNames, runReadToolsAutomatically, runWriteToolsAutomatically }) => result(await client.mcp().add({
    name,
    serverUrl,
    ...(toMcpAuth(auth) ? { auth: toMcpAuth(auth) as McpAuth } : {}),
    ...(transport ? { transport } : {}),
    ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
    ...(runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically } : {}),
    ...(runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically } : {})
  })));

  server.registerTool("update_mcp_connection", {
    title: "Update an MCP connection",
    description: "Update a linked MCP module, including enabled tools and read/write confirmation policy, or reconnect after server changes.",
    inputSchema: {
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      serverUrl: z.string().min(1).optional(),
      auth: authShape.optional(),
      transport: z.string().min(1).optional(),
      enabledToolNames: z.array(z.string().min(1)).max(1000).nullable().optional().describe("Exact tool names to enable; [] disables all and null restores all"),
      runReadToolsAutomatically: z.boolean().optional(),
      runWriteToolsAutomatically: z.boolean().optional()
    }
  }, async ({ id, name, serverUrl, auth, transport, enabledToolNames, runReadToolsAutomatically, runWriteToolsAutomatically }) => result(await client.mcp().update(id, {
    ...(name ? { name } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    ...(toMcpAuth(auth) ? { auth: toMcpAuth(auth) as McpAuth } : {}),
    ...(transport ? { transport } : {}),
    ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
    ...(runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically } : {}),
    ...(runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically } : {})
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
    description: "Begin a process-bound native-redirect MCP OAuth flow; open browserAuthorizationUrl, then call complete_mcp_oauth. BYO secrets are never stored or returned.",
    inputSchema: {
      serverUrl: z.string().min(1),
      connectionName: z.string().trim().min(1).max(500).optional(),
      transport: z.string().min(1).optional(),
      selectedScopes: z.array(z.string().min(1).max(1_024)).max(100).optional(),
      workflowId: z.string().uuid().optional().describe("OAuth can be initiated for a workflow, but CLI completion currently supports Personal Agent modules only"),
      existingModuleId: z.string().uuid().optional().describe("Existing linked MCP module to reauthenticate; its server URL must match"),
      userProvidedOAuthClientId: z.string().trim().min(1).max(2_048).optional(),
      userProvidedOAuthClientSecret: z.string().min(1).max(8_192).optional(),
      enabledToolNames: z.array(z.string().min(1)).max(1_000).optional(),
      runReadToolsAutomatically: z.boolean().optional(),
      runWriteToolsAutomatically: z.boolean().optional()
    }
  }, async ({
    serverUrl, connectionName, transport, selectedScopes, workflowId, existingModuleId,
    userProvidedOAuthClientId, userProvidedOAuthClientSecret, enabledToolNames,
    runReadToolsAutomatically, runWriteToolsAutomatically
  }) => result(await client.mcp().startOAuth(serverUrl, {
    ...(connectionName ? { connectionName } : {}),
    ...(transport ? { transport } : {}),
    ...(selectedScopes !== undefined ? { selectedScopes } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(existingModuleId ? { existingModuleId } : {}),
    ...(userProvidedOAuthClientId ? { userProvidedOAuthClientId } : {}),
    ...(userProvidedOAuthClientSecret ? { userProvidedOAuthClientSecret } : {}),
    ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
    ...(runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically } : {}),
    ...(runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically } : {})
  })));

  server.registerTool("complete_mcp_oauth", {
    title: "Complete MCP OAuth",
    description: "Poll a native-redirect OAuth flow started by this process and, once authorized, create or reconnect the linked Personal Agent MCP module.",
    inputSchema: {
      oauthFlowId: z.string().min(1).max(2_048),
      waitSeconds: z.number().int().min(0).max(60).optional(),
      connectionName: z.string().trim().min(1).max(500).optional(),
      transport: z.string().min(1).optional(),
      enabledToolNames: z.array(z.string().min(1)).max(1_000).nullable().optional().describe("Exact tool names; [] disables all and null restores all during reconnect"),
      runReadToolsAutomatically: z.boolean().optional(),
      runWriteToolsAutomatically: z.boolean().optional()
    }
  }, async ({
    oauthFlowId, waitSeconds, connectionName, transport, enabledToolNames,
    runReadToolsAutomatically, runWriteToolsAutomatically
  }) => result(await client.mcp().completeOAuth(oauthFlowId, {
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    ...(connectionName ? { connectionName } : {}),
    ...(transport ? { transport } : {}),
    ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
    ...(runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically } : {}),
    ...(runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically } : {})
  })));

  server.registerTool("list_preconfigured_mcp_servers", {
    title: "List preconfigured MCP servers",
    description: "List Notion's visible MCP catalog using a credential-free allowlisted response.",
    inputSchema: {}
  }, async () => result(await client.mcp().listPreconfigured()));

  server.registerTool("connect_preconfigured_mcp_server", {
    title: "Connect a preconfigured MCP server",
    description: "Resolve a visible catalog entry and use the same current connect/OAuth flow as custom MCP servers.",
    inputSchema: {
      preconfiguredServerId: z.string().min(1),
      variant: z.string().min(1).max(200).optional().describe("Variant name such as US or EU"),
      serverUrl: z.string().min(1).max(8_192).optional().describe("URL for pattern-configured entries"),
      templateValues: z.record(z.string().min(1).max(100), z.string().min(1).max(2_048)).optional(),
      auth: authShape.optional().describe("Omit for an OAuth catalog entry to start OAuth automatically"),
      transport: z.string().min(1).optional(),
      selectedScopes: z.array(z.string().min(1).max(1_024)).max(100).optional(),
      userProvidedOAuthClientId: z.string().trim().min(1).max(2_048).optional(),
      userProvidedOAuthClientSecret: z.string().min(1).max(8_192).optional(),
      enabledToolNames: z.array(z.string().min(1)).max(1_000).optional(),
      runReadToolsAutomatically: z.boolean().optional(),
      runWriteToolsAutomatically: z.boolean().optional()
    }
  }, async ({
    preconfiguredServerId, variant, serverUrl, templateValues, auth, transport, selectedScopes,
    userProvidedOAuthClientId, userProvidedOAuthClientSecret, enabledToolNames,
    runReadToolsAutomatically, runWriteToolsAutomatically
  }) => {
    const resolvedAuth = toMcpAuth(auth);
    return result(await client.mcp().connectPreconfigured(preconfiguredServerId, {
      ...(variant ? { variant } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      ...(templateValues ? { templateValues } : {}),
      ...(resolvedAuth ? { auth: resolvedAuth } : {}),
      ...(transport ? { transport } : {}),
      ...(selectedScopes !== undefined ? { selectedScopes } : {}),
      ...(userProvidedOAuthClientId !== undefined ? { userProvidedOAuthClientId } : {}),
      ...(userProvidedOAuthClientSecret !== undefined ? { userProvidedOAuthClientSecret } : {}),
      ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
      ...(runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically } : {}),
      ...(runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically } : {})
    }));
  });

  return server;
}

export async function runServer(): Promise<void> {
  const client = new NotionClient(loadConfig());
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}
