import { randomUUID } from "node:crypto";
import type {
  AccountContext, ChatAttachment, ChatResult, ChatSession, Conversation, ConversationMessage,
  ConversationSummary, ListConversationsResult, ParsedInferenceStream
} from "./types.js";
import type { NotionConfig } from "./config.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { normalizeModelName } from "./models.js";
import { McpConnectionManager } from "./mcp-connections.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"';

type JsonObject = Record<string, unknown>;

interface TranscriptPage { transcripts?: Array<Record<string, unknown>>; threadIds?: string[]; unreadThreadIds?: string[]; nextCursor?: string | null; hasMore?: boolean; recordMap?: { thread?: Record<string, unknown> } }
interface ThreadLookup { page: TranscriptPage; transcript: Record<string, unknown> | null; thread: Record<string, unknown> }

function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {}; }
export function unwrapRecord(value: unknown): JsonObject { let current = object(value); for (let i = 0; i < 3; i += 1) { const nested = current.value; if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break; current = object(nested); } return current; }
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function asNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function formatRichTextSegment(value: unknown): string {
  if (!Array.isArray(value)) return ""; const text = asString(value[0]); if (!text) return "";
  const annotations = Array.isArray(value[1]) ? value[1] : []; let result = text; let href = "";
  for (const rawAnnotation of annotations) { const annotation = Array.isArray(rawAnnotation) ? rawAnnotation : [rawAnnotation]; const kind = annotation[0]; const data = annotation[1]; if (kind === "a" && typeof data === "string") href = data; else if (kind === "b") result = `**${result}**`; else if (kind === "i") result = `*${result}*`; else if (kind === "s") result = `~~${result}~~`; else if (kind === "c") result = `\`${result}\``; }
  return href ? `[${result}](${href})` : result;
}

export function notionRichTextToMarkdown(value: unknown): string {
  if (value === null || value === undefined) return ""; if (typeof value === "string") return value;
  if (Array.isArray(value)) { if (typeof value[0] === "string") return formatRichTextSegment(value); return value.map(notionRichTextToMarkdown).join(""); }
  const record = object(value); return asString(record.content) || asString(record.text) || asString(record.plain_text);
}

function agentInferenceText(value: unknown): string {
  if (typeof value === "string") return value; if (!Array.isArray(value)) return "";
  return value.map((item) => object(item)).filter((item) => item.type === "text" && typeof item.content === "string").map((item) => asString(item.content).trim()).filter(Boolean).join("\n\n").trim();
}

export function parseConversationMessages(messageIds: string[], recordMap: Record<string, unknown>): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const id of messageIds) { const record = unwrapRecord(recordMap[id]); const step = object(record.step); let role: "user" | "assistant" | null = null; let text = ""; if (step.type === "user") { role = "user"; text = notionRichTextToMarkdown(step.value).trim(); } else if (step.type === "agent-inference") { role = "assistant"; text = agentInferenceText(step.value); } if (!role || !text) continue; const previous = messages.at(-1); if (previous?.role === role) { previous.text = `${previous.text}\n\n${text}`; continue; } messages.push({ id, role, text, createdAt: asNumber(record.created_time) }); }
  return messages;
}

function cleanLangTags(text: string): string { return text.replace(/<lang\b[^>]*\/>/g, "").replace(/<lang[^>]*$/, ""); }

function normalizeStreamLine(line: string): string { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("event:") || trimmed.startsWith(":")) return ""; if (trimmed.startsWith("data:")) { const data = trimmed.slice(5).trim(); return data === "[DONE]" ? "" : data; } return trimmed; }

export function parseInferenceLines(lines: string[]): ParsedInferenceStream {
  let text = ""; let inputTokens = 0; let outputTokens = 0; const eventTypes: Record<string, number> = {}; const patchTypes = new Map<string, string>(); const patchCounts = new Map<string, number>();
  for (const rawLine of lines) { const line = normalizeStreamLine(rawLine); if (!line) continue; let event: JsonObject; try { event = object(JSON.parse(line)); } catch { continue; } const type = asString(event.type, "unknown"); eventTypes[type] = (eventTypes[type] ?? 0) + 1; if (type === "error") throw new Error(`Notion AI error: ${asString(event.message, "unknown error")}`); if (type === "premium-feature-unavailable") { const availability = object(event.featureAvailability); const limit = object(availability.limit); const current = limit.current; const total = limit.total; const detail = typeof current === "number" && typeof total === "number" ? ` (AI credit limit reached: ${current}/${total})` : ""; throw new Error(`Notion AI premium feature unavailable${detail}`); } if (type === "agent-inference") { for (const rawEntry of Array.isArray(event.value) ? event.value : []) { const entry = object(rawEntry); if (entry.type === "text" && typeof entry.content === "string") { text = entry.content; } } if (typeof event.inputTokens === "number") inputTokens += event.inputTokens; if (typeof event.outputTokens === "number") outputTokens += event.outputTokens; continue; } if (type !== "patch") continue; for (const rawOperation of Array.isArray(event.v) ? event.v : []) { const operation = object(rawOperation); const op = asString(operation.o); const path = asString(operation.p); if (op === "a" && path.includes("/value/-")) { const entry = object(operation.v); const statePrefix = path.slice(0, path.indexOf("/value/")); const count = patchCounts.get(statePrefix) ?? 0; patchTypes.set(`${statePrefix}/value/${count}`, asString(entry.type)); patchCounts.set(statePrefix, count + 1); } if (op === "a" && path.endsWith("/inputTokens") && typeof operation.v === "number") { inputTokens += operation.v; } if (op === "a" && path.endsWith("/outputTokens") && typeof operation.v === "number") { outputTokens += operation.v; } if (!path.includes("content") || typeof operation.v !== "string") continue; const contentIndex = path.lastIndexOf("/content"); const entryType = contentIndex >= 0 ? patchTypes.get(path.slice(0, contentIndex)) : "text"; if (entryType === "thinking" || entryType === "tool_use") continue; if (op === "x") text += operation.v; else if (op === "p") text = text.replace(/<lang[^>]*\/>/g, "").replace(operation.v.includes("<lang") ? /<lang[^>]*\/>/g : /$/, operation.v); } }
  return { text: cleanLangTags(text), inputTokens, outputTokens, eventTypes };
}

function applyPatchReplacement(current: string, replacement: string): string { const langIndex = current.lastIndexOf("<lang"); return langIndex >= 0 ? current.slice(0, langIndex) + replacement : current + replacement; }

export async function parseInferenceStream(stream: ReadableStream<Uint8Array>): Promise<ParsedInferenceStream> { const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = ""; const lines: string[] = []; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let newline = buffer.indexOf("\n"); while (newline >= 0) { lines.push(buffer.slice(0, newline).trimEnd()); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); } } buffer += decoder.decode(); if (buffer.trim()) lines.push(buffer.trim()); return parseInferenceLines(lines); }

function buildCookie(account: AccountContext): string { if (account.fullCookie) return account.fullCookie; const userIdNoDash = account.userId.replaceAll("-", ""); return [`notion_browser_id=${account.browserId}`, `device_id=${account.deviceId}`, `notion_user_id=${account.userId}`, "notion_locale=en-US/legacy", `notion_users=[%22${account.userId}%22]`, "notion_check_cookie_consent=false", "notion_cookie_sync_completed=%7B%22completed%22%3Atrue%2C%22version%22%3A4%7D", `_cioid=${userIdNoDash}`, `token_v2=${account.tokenV2}`].join("; "); }

/** Mirrors the config step the Notion web client sends, so server-side gating behaves the same. */
export const UI_CONFIG_DEFAULTS: JsonObject = {
  type: "workflow",
  enableAgentAutomations: true,
  enableAgentDiffs: true,
  enableAgentIntegrations: true,
  enableAgentAskSurvey: true,
  enableCreateAndRunThread: true,
  enableCsvAttachmentSupport: true,
  enableCustomAgents: true,
  enableScriptAgent: true,
  enableScriptAgentAdvanced: false,
  enableScriptAgentMcpServers: true,
  enableScriptAgentSlack: true,
  useRulePrioritization: true,
  internetAccess: false,
  isCustomAgent: false,
  isCustomAgentBuilder: false,
  writerMode: false
};

function buildConfigValue(model: string, webSearch: boolean, workspaceSearch: boolean, readOnly: boolean, subsequent: boolean): JsonObject {
  const integrations = webSearch || workspaceSearch;
  return {
    ...UI_CONFIG_DEFAULTS,
    modelFromUser: !subsequent,
    useWebSearch: webSearch,
    useReadOnlyMode: readOnly,
    ...(integrations ? { searchScopes: [{ type: "everything" }] } : {}),
    ...(subsequent ? { model, isThreadStartedByAdmin: true } : {})
  };
}

interface ConversationCursor { notionCursor?: string; offset: number }

function decodeConversationCursor(cursor?: string): ConversationCursor { if (!cursor) return { offset: 0 }; if (!cursor.startsWith("mcpv1.")) return { notionCursor: cursor, offset: 0 }; try { const value = object(JSON.parse(Buffer.from(cursor.slice(6), "base64url").toString("utf8"))); const offset = typeof value.offset === "number" && Number.isInteger(value.offset) && value.offset >= 0 ? value.offset : 0; const notionCursor = asString(value.notionCursor); return notionCursor ? { notionCursor, offset } : { offset }; } catch { throw new Error("Invalid list_conversations cursor"); } }

function encodeConversationCursor(value: ConversationCursor): string { return `mcpv1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`; }

export class NotionClient {
  private accountPromise: Promise<AccountContext> | null = null;
  private readonly sessions = new Map<string, ChatSession>();
  private workspaceManager: WorkspaceManager | null = null;
  private mcpManager: McpConnectionManager | null = null;

  constructor(private readonly config: NotionConfig, private readonly fetchImpl: typeof fetch = fetch) {
    if (config.account.tokenV2) {
      this.workspaceManager = new WorkspaceManager(
        { tokenV2: config.account.tokenV2, userId: config.account.userId || "", userName: config.account.userName || "", userEmail: config.account.userEmail || "", spaceId: config.account.spaceId || "", spaceName: config.account.spaceName || "", spaceViewId: config.account.spaceViewId || "", timezone: config.account.timezone || "UTC", clientVersion: config.account.clientVersion || "23.13.20260313.1423", browserId: config.account.browserId || randomUUID(), deviceId: config.account.deviceId || randomUUID(), ...(config.account.fullCookie ? { fullCookie: config.account.fullCookie } : {}) },
        config.apiBase, fetchImpl, config.accountFilePath
      );
    }
  }

  async account(): Promise<AccountContext> { this.accountPromise ??= this.resolveAccount(); return this.accountPromise; }

  private async resolveAccount(): Promise<AccountContext> {
    const configured = this.config.account; if (configured.userId && configured.spaceId) return configured as AccountContext;
    const response = await this.fetchJson("loadUserContent", {}); const recordMap = object(response.recordMap); const users = object(recordMap.notion_user); const userId = Object.keys(users)[0]; if (!userId) throw new Error("loadUserContent did not return a Notion user");
    const user = unwrapRecord(users[userId]); const userRoot = unwrapRecord(object(recordMap.user_root)[userId]); const pointers = Array.isArray(userRoot.space_view_pointers) ? userRoot.space_view_pointers : []; if (pointers.length === 0) throw new Error("loadUserContent did not return a workspace");
    const spaces = object(recordMap.space); const pointer = pointers.map((p) => object(p)).sort((a, b) => { const sc = (c: JsonObject): number => { const cs = unwrapRecord(spaces[asString(c.spaceId)]); const csS = object(cs.settings); return (csS.disable_ai_feature !== true ? 2 : 0) + (asString(cs.plan_type) !== "free" ? 1 : 0); }; return sc(b) - sc(a); })[0] ?? {};
    const spaceId = asString(pointer.spaceId); const space = unwrapRecord(spaces[spaceId]); const settings = unwrapRecord(object(recordMap.user_settings)[userId]); const userSettings = object(settings.settings);
    return { tokenV2: configured.tokenV2, userId, userName: configured.userName || asString(user.name), userEmail: configured.userEmail || asString(user.email), spaceId, spaceName: configured.spaceName || asString(space.name), spaceViewId: configured.spaceViewId || asString(pointer.id), timezone: configured.timezone || asString(userSettings.time_zone, "UTC"), clientVersion: configured.clientVersion || "23.13.20260313.1423", browserId: configured.browserId || randomUUID(), deviceId: configured.deviceId || randomUUID(), ...(configured.fullCookie ? { fullCookie: configured.fullCookie } : {}) };
  }

  private headers(account: AccountContext, stream: boolean): HeadersInit { return { accept: stream ? "application/x-ndjson" : "application/json", "accept-language": "en-US,en;q=0.9", "content-type": "application/json", "notion-audit-log-platform": "web", "notion-client-version": account.clientVersion, origin: "https://www.notion.so", referer: `{{https://www.notion.so/${account.spaceId}}}`, "sec-ch-ua": SEC_CH_UA, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", "user-agent": USER_AGENT, "x-notion-active-user-header": account.userId, "x-notion-space-id": account.spaceId, cookie: buildCookie(account) }; }

  private async request(endpoint: string, body: unknown, stream: boolean): Promise<Response> { const account = endpoint === "loadUserContent" ? ({ ...this.config.account, userId: this.config.account.userId || "", spaceId: this.config.account.spaceId || "", userName: "", userEmail: "", spaceName: "", spaceViewId: "", timezone: this.config.account.timezone || "UTC", clientVersion: this.config.account.clientVersion || "23.13.20260313.1423", browserId: this.config.account.browserId || randomUUID(), deviceId: this.config.account.deviceId || randomUUID() } as AccountContext) : await this.account(); const response = await this.fetchImpl(`${this.config.apiBase}/${endpoint}`, { method: "POST", headers: endpoint === "loadUserContent" ? { accept: "application/json", "content-type": "application/json", cookie: `token_v2=${account.tokenV2}`, "user-agent": USER_AGENT } : this.headers(account, stream), body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.requestTimeoutMs) }); if (!response.ok) { const errorBody = (await response.text()).slice(0, 500); throw new Error(`${endpoint} returned HTTP ${response.status}: ${errorBody}`); } return response; }

  private async fetchJson(endpoint: string, body: unknown): Promise<JsonObject> { const response = await this.request(endpoint, body, false); return object(await response.json()); }

  private async transcriptPage(cursor?: string): Promise<TranscriptPage> { const account = await this.account(); const body: JsonObject = { threadParentPointer: { table: "space", id: account.spaceId, spaceId: account.spaceId }, includeWorkflowThreads: true, includeWriterChats: false, ...(cursor ? { cursor } : {}) }; return (await this.fetchJson("getInferenceTranscriptsForUser", body)) as TranscriptPage; }

  async listConversations(options: { limit?: number; cursor?: string; maxPages?: number } = {}): Promise<ListConversationsResult> { const limit = Math.min(Math.max(options.limit ?? 20, 1), 100); const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 50); const state = decodeConversationCursor(options.cursor); const conversations: ConversationSummary[] = []; let notionCursor = state.notionCursor; let offset = state.offset; let nextCursor: string | null = null; let hasMore = false; for (let pi = 0; pi < maxPages && conversations.length < limit; pi += 1) { const page = await this.transcriptPage(notionCursor); const unread = new Set(page.unreadThreadIds ?? []); const threads = page.recordMap?.thread ?? {}; const pts = page.transcripts ?? []; let idx = offset; for (; idx < pts.length; idx += 1) { const r = pts[idx]; const t = object(r); const id = asString(t.id); if (!id) continue; const th = unwrapRecord(threads[id]); conversations.push({ id, title: asString(t.title) || asString(object(th.data).title) || "Untitled", type: asString(t.type) || asString(th.type, "workflow"), createdAt: asNumber(t.created_at) ?? asNumber(th.created_time), updatedAt: asNumber(t.updated_at) ?? asNumber(th.updated_time), messageCount: arrayOfStrings(th.messages).length, unread: unread.has(id) }); if (conversations.length >= limit) { const no = idx + 1; if (no < pts.length) { nextCursor = encodeConversationCursor({ ...(notionCursor ? { notionCursor } : {}), offset: no }); hasMore = true; } else if (page.hasMore && page.nextCursor) { nextCursor = encodeConversationCursor({ notionCursor: page.nextCursor, offset: 0 }); hasMore = true; } break; } } if (conversations.length >= limit) break; if (!page.hasMore || !page.nextCursor) { nextCursor = null; hasMore = false; break; } notionCursor = page.nextCursor; offset = 0; nextCursor = encodeConversationCursor({ notionCursor, offset: 0 }); hasMore = true; } return { conversations, nextCursor, hasMore }; }

  private async findThread(threadId: string, maxPages: number): Promise<ThreadLookup> { let cursor: string | undefined; for (let pi = 0; pi < maxPages; pi += 1) { const page = await this.transcriptPage(cursor); const rawThread = page.recordMap?.thread?.[threadId]; if (rawThread) { const t = (page.transcripts ?? []).find((item) => asString(object(item).id) === threadId) ?? null; return { page, transcript: t, thread: unwrapRecord(rawThread) }; } if (!page.hasMore || !page.nextCursor) break; cursor = page.nextCursor; } throw new Error(`Conversation ${threadId} was not found`); }

  private async fetchThreadMessages(messageIds: string[]): Promise<Record<string, unknown>> { const account = await this.account(); const records: Record<string, unknown> = {}; for (let i = 0; i < messageIds.length; i += 100) { const batch = messageIds.slice(i, i + 100); const resp = await this.fetchJson("syncRecordValuesMain", { requests: batch.map((id) => ({ pointer: { table: "thread_message", id, spaceId: account.spaceId }, version: -1 })) }); Object.assign(records, object(object(resp.recordMap).thread_message)); } return records; }

  async getConversation(threadId: string, maxPages = 20): Promise<Conversation> { const found = await this.findThread(threadId, Math.min(Math.max(maxPages, 1), 100)); const messageIds = arrayOfStrings(found.thread.messages); const records = await this.fetchThreadMessages(messageIds); const t = found.transcript ?? {}; return { id: threadId, title: asString(t.title) || asString(object(found.thread.data).title) || "Untitled", type: asString(t.type) || asString(found.thread.type, "workflow"), createdAt: asNumber(t.created_at) ?? asNumber(found.thread.created_time), updatedAt: asNumber(t.updated_at) ?? asNumber(found.thread.updated_time), messages: parseConversationMessages(messageIds, records) }; }

  private buildContext(account: AccountContext, datetime: string, hasAttachments = false): JsonObject { return { timezone: account.timezone, userName: account.userName, userId: account.userId, userEmail: account.userEmail, spaceName: account.spaceName, spaceId: account.spaceId, spaceViewId: account.spaceViewId, currentDatetime: datetime, surface: hasAttachments ? "workflows" : "ai_module" }; }

  private buildInferenceBody(account: AccountContext, prompt: string, model: string, webSearch: boolean, workspaceSearch: boolean, readOnly: boolean, session: ChatSession, attachments: ChatAttachment[] = []): JsonObject {
    const sub = session.turnCount > 0;
    const now = new Date().toISOString();
    const userStep: JsonObject = { id: randomUUID(), type: "user", value: [[prompt]], userId: account.userId, createdAt: now, ...(attachments.length ? { attachments } : {}) };
    const transcript: JsonObject[] = [
      { id: session.configId, type: "config", value: buildConfigValue(model, webSearch, workspaceSearch, readOnly, sub) },
      { id: session.contextId, type: "context", value: this.buildContext(account, session.originalDatetime, attachments.length > 0) },
      ...session.updatedConfigIds.map((id) => ({ id, type: "updated-config" })),
      userStep
    ];
    return { traceId: randomUUID(), spaceId: account.spaceId, threadId: session.threadId, transcript, createThread: !sub, generateTitle: !sub, saveAllThreadOperations: true, setUnreadState: false, threadType: "workflow", asPatchResponse: false, isPartialTranscript: sub, ...(!sub ? { threadParentPointer: { table: "space", id: account.spaceId, spaceId: account.spaceId } } : {}), debugOverrides: { model, emitAgentSearchExtractedResults: true } };
  }

  async chat(options: { prompt: string; model?: string; conversationId?: string; webSearch?: boolean; workspaceSearch?: boolean; readOnly?: boolean; attachments?: ChatAttachment[]; _retryCount?: number }): Promise<ChatResult> {
    const maxRetries = this.config.maxWorkspaceRetries ?? 5;
    try { return await this._chatInternal(options); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isPremiumLimit = message.includes("premium feature unavailable") || message.includes("premium-feature-unavailable");
      const attempt = (options._retryCount ?? 0) + 1;
      if (isPremiumLimit && this.workspaceManager && attempt <= maxRetries) {
        await this.workspaceManager.handleLimitReached();
        this.accountPromise = null;
        return this.chat({ ...options, _retryCount: attempt });
      }
      throw error;
    }
  }

  private async _chatInternal(options: { prompt: string; model?: string; conversationId?: string; webSearch?: boolean; workspaceSearch?: boolean; readOnly?: boolean; attachments?: ChatAttachment[]; _retryCount?: number }): Promise<ChatResult> {
    const account = await this.account();
    const model = normalizeModelName(options.model, this.config.defaultModel);
    let session: ChatSession;
    if (options.conversationId) {
      const known = this.sessions.get(options.conversationId);
      if (!known) throw new Error(`Conversation ${options.conversationId} is not an active MCP session. Start a new chat without conversationId.`);
      session = known;
    } else { session = { threadId: randomUUID(), configId: randomUUID(), contextId: randomUUID(), originalDatetime: new Date().toISOString(), model, updatedConfigIds: [], turnCount: 0 }; }
    const body = this.buildInferenceBody(account, options.prompt, model, options.webSearch ?? false, options.workspaceSearch ?? false, options.readOnly ?? true, session, options.attachments ?? []);
    const response = await this.request("runInferenceTranscript", body, true);
    if (!response.body) throw new Error("runInferenceTranscript returned no response stream");
    const parsed = await parseInferenceStream(response.body);
    if (!parsed.text.trim()) throw new Error("Notion AI returned an empty response");
    session.turnCount += 1; session.updatedConfigIds.push(randomUUID()); session.model = model; this.sessions.set(session.threadId, session);
    return { conversationId: session.threadId, text: parsed.text, model, usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens } };
  }

  /** Raw internal-API POST used by the management tools. */
  async apiPost(endpoint: string, body: JsonObject): Promise<JsonObject> { return this.fetchJson(endpoint, body); }

  mcp(): McpConnectionManager {
    this.mcpManager ??= new McpConnectionManager(
      { post: (endpoint, requestBody) => this.fetchJson(endpoint, requestBody), spaceId: async () => (await this.account()).spaceId },
      this.config.mcpRegistryPath
    );
    return this.mcpManager;
  }

  private workspaces(): WorkspaceManager {
    if (!this.workspaceManager) throw new Error("Workspace management requires a token_v2 credential");
    return this.workspaceManager;
  }

  async listWorkspaces(): Promise<Array<Record<string, unknown>>> {
    const account = await this.account();
    const all = await this.workspaces().listWorkspaces();
    return all.map((ws) => ({ ...ws, current: ws.spaceId === account.spaceId }));
  }

  async getCurrentWorkspace(): Promise<JsonObject> {
    const account = await this.account();
    return { spaceId: account.spaceId, spaceName: account.spaceName, spaceViewId: account.spaceViewId, userEmail: account.userEmail, pinnedSpaceId: this.workspaces().pinnedWorkspace() };
  }

  async switchWorkspace(selector: string, pin = false): Promise<JsonObject> {
    const workspace = await this.workspaces().switchWorkspace(selector);
    if (pin) this.workspaces().pin(workspace.spaceId);
    this.accountPromise = null;
    this.sessions.clear();
    return { ...workspace, pinned: pin };
  }

  async createWorkspace(name?: string, options: { pin?: boolean; switchTo?: boolean } = {}): Promise<JsonObject> {
    const manager = this.workspaces();
    const shouldSwitch = options.switchTo !== false;
    const workspace = shouldSwitch
      ? await manager.createAndSwitchWorkspace(name, { pin: options.pin ?? true })
      : await manager.createWorkspace(name);
    if (shouldSwitch) { this.accountPromise = null; this.sessions.clear(); }
    return { ...workspace, switched: shouldSwitch, pinned: shouldSwitch ? (options.pin ?? true) : false };
  }
}
