import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type JsonObject = Record<string, unknown>;

/** Every authentication style the Notion "Custom MCP" connect form supports. */
export type McpAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "token"; token: string }
  | { type: "apiKey"; key: string; headerName?: string }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; headers: Record<string, string> }
  | { type: "oauth" };

export type McpApprovalIntent = "approve_on_connect";
export type McpTransport = "streamableHttp" | "sse";
export interface McpToolSettings {
  /** Undefined means every discovered tool is enabled. */
  enabledToolNames?: string[];
  /** Undefined follows Notion's default: read tools run automatically. */
  runReadToolsAutomatically?: boolean;
  /** Undefined follows Notion's default: write tools require confirmation. */
  runWriteToolsAutomatically?: boolean;
}
export interface McpHeader { name: string; value: string }
export interface McpContext { spaceId: string; userId: string; spaceViewId: string }

export interface McpConnectionRecord {
  id: string;
  name: string;
  serverUrl: string;
  spaceId: string;
  /** Optional so registries written by older releases continue to load. */
  spaceViewId?: string;
  authType: McpAuth["type"] | "unknown";
  transport: string;
  toolNames: string[];
  enabledToolNames?: string[];
  runReadToolsAutomatically?: boolean;
  runWriteToolsAutomatically?: boolean;
  createdAt: string;
}

export interface McpConnectionSummary {
  id: string;
  name: string;
  serverUrl: string;
  spaceId: string;
  spaceViewId: string;
  authType: McpAuth["type"] | "unknown";
  transport: string;
  toolNames: string[];
  /** null means every discovered tool is enabled. */
  enabledToolNames: string[] | null;
  runReadToolsAutomatically: boolean;
  runWriteToolsAutomatically: boolean;
  createdAt: string | null;
  source: "notion" | "notion_and_registry" | "registry_only";
  alive: boolean | null;
  linked: boolean;
  defaultEnabled: boolean;
}

export interface McpApi {
  post(endpoint: string, body: JsonObject): Promise<JsonObject>;
  context(): Promise<McpContext>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function unwrapRecord(value: unknown): JsonObject {
  let current = object(value);
  for (let index = 0; index < 5; index += 1) {
    const nested = current.value;
    if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break;
    current = object(nested);
  }
  return current;
}
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function linkedModuleId(value: unknown): string { return asString(object(object(value).pointer).id); }
function linkedModules(settings: JsonObject): unknown[] { return Array.isArray(settings.agent_chat_modules) ? settings.agent_chat_modules : []; }

/** Turns a declarative auth choice into the legacy header map used by callers. */
export function buildAuthHeaders(auth: McpAuth | undefined): Record<string, string> {
  if (!auth) return {};
  switch (auth.type) {
    case "none":
    case "oauth":
      return {};
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "token":
      return { Authorization: `Token ${auth.token}` };
    case "apiKey":
      return { [auth.headerName?.trim() || "X-API-Key"]: auth.key };
    case "basic":
      return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` };
    case "header":
      return { ...auth.headers };
    default: {
      const exhaustive: never = auth;
      throw new Error(`Unsupported MCP auth type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Current Notion APIs expect authHeaders as [{name,value}], not an object map. */
export function buildAuthHeaderList(auth: McpAuth | undefined): McpHeader[] {
  return Object.entries(buildAuthHeaders(auth))
    .map(([name, value]) => ({ name: name.trim(), value }))
    .filter(({ name, value }) => Boolean(name) && Boolean(value.trim()));
}

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("serverUrl is required");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`serverUrl is not a valid URL: ${value}`); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("serverUrl must use https (localhost is allowed for testing)");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeTransport(value?: string): McpTransport {
  const normalized = value?.trim() || "streamableHttp";
  if (normalized === "streamableHttp" || normalized === "streamable-http" || normalized === "http") return "streamableHttp";
  if (normalized === "sse") return "sse";
  throw new Error("transport must be streamableHttp or sse");
}

export function toolNamesFrom(value: unknown): string[] {
  const tools = Array.isArray(value) ? value : Array.isArray(object(value).tools) ? (object(value).tools as unknown[]) : [];
  return tools.map((tool) => asString(object(tool).name)).filter(Boolean);
}

const MCP_NO_TOOLS_SENTINEL = "__NONE__";

/** Notion persists disable-all with a sentinel because an empty array is normalized away. */
function persistedToolNames(value: string[]): string[] {
  return value.length === 0 ? [MCP_NO_TOOLS_SENTINEL] : [...value];
}

/** Decode Notion's sentinel while keeping the public API free of internal marker values. */
function storedToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || name === MCP_NO_TOOLS_SENTINEL || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Normalize a selection and reject names that were not returned by validation. */
export function normalizeEnabledToolNames(value: string[], availableToolNames: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = item.trim();
    if (!name) throw new Error("enabledToolNames cannot contain empty names");
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const available = new Set(availableToolNames);
  const unknown = names.filter((name) => name === MCP_NO_TOOLS_SENTINEL || !available.has(name));
  if (unknown.length > 0) throw new Error(`Unknown MCP tool name(s): ${unknown.join(", ")}`);
  return names;
}

/** Normalize optional OAuth scopes exactly as the current connect UI resolves them. */
export function normalizeOAuthScopes(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > 100) throw new Error("selectedScopes supports at most 100 scopes");
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const scope = item.trim();
    if (!scope) throw new Error("selectedScopes cannot contain empty scopes");
    if (scope.length > 1_024) throw new Error("selectedScopes contains an excessively long scope");
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  if (scopes.length === 0) throw new Error("selectedScopes must contain at least one scope when provided");
  return scopes;
}

const SAFE_OAUTH_RESPONSE_FIELDS = ["authorizationUrl", "completionFlowId", "oauthFlowId"] as const;

/** Keep transient credentials request-only, even if a future API response accidentally echoes them. */
function safeOAuthResponse(response: JsonObject, integrationId: string, clientSecret?: string): JsonObject {
  const safe: JsonObject = { integrationId };
  for (const key of SAFE_OAUTH_RESPONSE_FIELDS) {
    const value = response[key];
    if (typeof value !== "string" || !value) continue;
    if (clientSecret && value.includes(clientSecret)) {
      throw new Error("Notion returned an unsafe OAuth response containing supplied credentials");
    }
    safe[key] = value;
  }
  return safe;
}

/** Local mirror of the modules we created, so the tools keep working across restarts. */
export class McpRegistry {
  private records: McpConnectionRecord[] = [];

  constructor(private readonly path?: string) { this.load(); }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const list = Array.isArray(parsed) ? parsed : object(parsed).connections;
      this.records = (Array.isArray(list) ? list : []).map((item) => object(item) as unknown as McpConnectionRecord).filter((item) => Boolean(item.id));
    } catch { this.records = []; }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ connections: this.records }, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  list(): McpConnectionRecord[] { return [...this.records]; }
  get(id: string): McpConnectionRecord | undefined { return this.records.find((record) => record.id === id); }
  upsert(record: McpConnectionRecord): void {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record; else this.records.push(record);
    this.save();
  }
  remove(id: string): boolean {
    const next = this.records.filter((record) => record.id !== id);
    const removed = next.length !== this.records.length;
    this.records = next;
    if (removed) this.save();
    return removed;
  }
}

export interface AddConnectionInput extends McpToolSettings {
  name: string;
  serverUrl: string;
  auth?: McpAuth;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
}

export interface UpdateConnectionInput {
  name?: string;
  serverUrl?: string;
  auth?: McpAuth;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
  /** null removes the filter so all discovered tools are enabled. */
  enabledToolNames?: string[] | null;
  runReadToolsAutomatically?: boolean;
  runWriteToolsAutomatically?: boolean;
}

export interface StartOAuthOptions {
  selectedScopes?: string[];
  workflowId?: string;
  /** Supplying a verified current-workspace module enables reconnect context. */
  existingModuleId?: string;
  /** BYO OAuth credentials are transient and are never persisted or returned. */
  userProvidedOAuthClientId?: string;
  userProvidedOAuthClientSecret?: string;
}

export class McpConnectionManager {
  private readonly registry: McpRegistry;

  constructor(private readonly api: McpApi, registryPath?: string) {
    this.registry = new McpRegistry(registryPath);
  }

  private async context(): Promise<McpContext> {
    const context = await this.api.context();
    if (!context.spaceId || !context.userId || !context.spaceViewId) {
      throw new Error("MCP connection management requires a resolved user, workspace, and space view");
    }
    return context;
  }

  async checkOAuthSupport(serverUrl: string): Promise<JsonObject> {
    const { spaceId } = await this.context();
    return this.api.post("checkMcpOAuthSupport", { serverUrl: normalizeServerUrl(serverUrl), spaceId });
  }

  private async validateInContext(context: McpContext, serverUrl: string, auth?: McpAuth, approvalIntent: McpApprovalIntent = "approve_on_connect"): Promise<JsonObject> {
    const response = await this.api.post("validateMcpConnection", {
      serverUrl: normalizeServerUrl(serverUrl),
      spaceId: context.spaceId,
      authHeaders: buildAuthHeaderList(auth),
      approvalIntent
    });
    if (response.success === false) {
      const detail = asString(object(response.error).message, "connection validation failed");
      throw new Error(`Notion rejected the MCP server: ${detail}`);
    }
    return response;
  }

  async validate(serverUrl: string, auth?: McpAuth, approvalIntent: McpApprovalIntent = "approve_on_connect"): Promise<JsonObject> {
    return this.validateInContext(await this.context(), serverUrl, auth, approvalIntent);
  }

  /** Exact workflow_module record shape emitted by Notion's current model factory. */
  buildCreateTransaction(moduleId: string, context: McpContext, input: AddConnectionInput, toolList: unknown[], now = Date.now()): JsonObject {
    const enabledToolNames = input.enabledToolNames === undefined
      ? undefined
      : normalizeEnabledToolNames(input.enabledToolNames, toolNamesFrom(toolList));
    const data: JsonObject = {
      id: moduleId,
      name: input.name,
      icon: "🤖",
      serverUrl: normalizeServerUrl(input.serverUrl),
      preferredTransport: normalizeTransport(input.transport),
      ...(toolList.length ? { tools: toolList } : {}),
      ...(enabledToolNames !== undefined ? { enabledToolNames: persistedToolNames(enabledToolNames) } : {}),
      runReadToolsAutomatically: input.runReadToolsAutomatically ?? true,
      runWriteToolsAutomatically: input.runWriteToolsAutomatically ?? false
    };
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [{
          pointer: { table: "workflow_module", id: moduleId, spaceId: context.spaceId },
          path: [],
          command: "set",
          args: {
            alive: true,
            created_by_id: context.userId,
            created_by_table: "notion_user",
            created_time: now,
            id: moduleId,
            last_edited_by_id: context.userId,
            last_edited_by_table: "notion_user",
            last_edited_time: now,
            parent_id: context.userId,
            parent_table: "notion_user",
            version: 1,
            module_type: "mcpServer",
            space_id: context.spaceId,
            data
          }
        }]
      }]
    };
  }

  private async loadSpaceViewSettings(context: McpContext): Promise<JsonObject> {
    const response = await this.api.post("syncRecordValuesMain", {
      requests: [{ pointer: { table: "space_view", id: context.spaceViewId }, version: -1 }],
      spacePointer: { table: "space", id: context.spaceId }
    });
    const recordMap = object(response.recordMap);
    const record = unwrapRecord(object(recordMap.space_view)[context.spaceViewId]);
    if (asString(record.id) !== context.spaceViewId || asString(record.space_id) !== context.spaceId || record.alive !== true) {
      throw new Error(`Current space_view ${context.spaceViewId} is missing or invalid`);
    }
    return object(record.settings);
  }

  private async loadSpaceRecords(context: McpContext, pointers: Array<{ table: string; id: string; spaceId: string }>): Promise<Map<string, JsonObject>> {
    const unique = new Map<string, { table: string; id: string; spaceId: string }>();
    for (const pointer of pointers) {
      if (!pointer.table || !pointer.id || pointer.spaceId !== context.spaceId) continue;
      unique.set(`${pointer.table}:${pointer.id}`, pointer);
    }
    if (unique.size === 0) return new Map();
    const response = await this.api.post("syncRecordValues", {
      requests: [...unique.values()].map((pointer) => ({ pointer, version: -1 }))
    });
    const recordMap = object(response.recordMap);
    const records = new Map<string, JsonObject>();
    for (const [key, pointer] of unique) {
      const record = unwrapRecord(object(recordMap[pointer.table])[pointer.id]);
      if (asString(record.id) === pointer.id) records.set(key, record);
    }
    return records;
  }

  private async loadSpaceRecord(context: McpContext, table: string, id: string, pointerSpaceId = context.spaceId): Promise<JsonObject> {
    const records = await this.loadSpaceRecords(context, [{ table, id, spaceId: pointerSpaceId }]);
    const record = records.get(`${table}:${id}`);
    if (!record) throw new Error(`${table} ${id} was not found`);
    return record;
  }

  private settingsOperation(context: McpContext, settings: JsonObject, moduleId: string, linked: boolean): JsonObject {
    const existing = linkedModules(settings).filter((entry) => linkedModuleId(entry) !== moduleId);
    const agentChatModules = linked
      ? [...existing, { pointer: { table: "workflow_module", id: moduleId, spaceId: context.spaceId }, defaultEnabled: false }]
      : existing;
    return {
      pointer: { table: "space_view", id: context.spaceViewId, spaceId: context.spaceId },
      path: ["settings"],
      command: "update",
      args: { ...settings, agent_chat_modules: agentChatModules }
    };
  }

  private settingsTransaction(context: McpContext, settings: JsonObject, moduleId: string, linked: boolean): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [this.settingsOperation(context, settings, moduleId, linked)]
      }]
    };
  }

  private deadOperation(moduleId: string, spaceId: string): JsonObject {
    return {
      pointer: { table: "workflow_module", id: moduleId, spaceId },
      path: [],
      command: "update",
      args: { alive: false }
    };
  }

  private deadTransaction(moduleId: string, spaceId: string): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{ id: randomUUID(), spaceId, operations: [this.deadOperation(moduleId, spaceId)] }]
    };
  }

  private deactivateTransaction(context: McpContext, settings: JsonObject, moduleId: string): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [this.deadOperation(moduleId, context.spaceId), this.settingsOperation(context, settings, moduleId, false)]
      }]
    };
  }

  private async deactivateAndUnlink(moduleId: string, context: McpContext): Promise<void> {
    try {
      const settings = await this.loadSpaceViewSettings(context);
      await this.api.post("saveTransactionsFanout", this.deactivateTransaction(context, settings, moduleId));
    } catch (error) {
      await this.api.post("saveTransactionsFanout", this.deadTransaction(moduleId, context.spaceId));
      throw error;
    }
  }

  private assertActiveWorkspace(record: McpConnectionRecord | undefined, context: McpContext): void {
    if (record?.spaceId && record.spaceId !== context.spaceId) {
      throw new Error(`MCP connection belongs to workspace ${record.spaceId}; switch to that workspace first`);
    }
    if (record?.spaceViewId && record.spaceViewId !== context.spaceViewId) {
      throw new Error("MCP connection belongs to a different space view; switch workspaces first");
    }
  }

  async add(input: AddConnectionInput): Promise<McpConnectionRecord & { validation: JsonObject }> {
    const context = await this.context();
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const approvalIntent = input.approvalIntent ?? "approve_on_connect";
    const transport = normalizeTransport(input.transport);
    const validation = await this.validateInContext(context, serverUrl, input.auth, approvalIntent);
    const toolList = Array.isArray(validation.tools) ? (validation.tools as unknown[]) : [];
    const enabledToolNames = input.enabledToolNames === undefined
      ? undefined
      : normalizeEnabledToolNames(input.enabledToolNames, toolNamesFrom(toolList));
    const runReadToolsAutomatically = input.runReadToolsAutomatically ?? true;
    const runWriteToolsAutomatically = input.runWriteToolsAutomatically ?? false;
    const normalizedInput: AddConnectionInput = {
      ...input,
      name,
      serverUrl,
      transport,
      ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically
    };
    const moduleId = randomUUID();
    await this.api.post("saveTransactionsFanout", this.buildCreateTransaction(moduleId, context, normalizedInput, toolList));
    try {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: moduleId,
        spaceId: context.spaceId,
        authHeaders: buildAuthHeaderList(input.auth),
        initiationContext: "connect",
        approvalIntent
      });
      const settings = await this.loadSpaceViewSettings(context);
      await this.api.post("saveTransactionsFanout", this.settingsTransaction(context, settings, moduleId, true));
    } catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    const record: McpConnectionRecord = {
      id: moduleId,
      name,
      serverUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      authType: input.auth?.type ?? "none",
      transport,
      toolNames: toolNamesFrom(toolList),
      ...(enabledToolNames !== undefined ? { enabledToolNames: [...enabledToolNames] } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically,
      createdAt: new Date().toISOString()
    };
    try { this.registry.upsert(record); }
    catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    return { ...record, validation };
  }

  async update(id: string, changes: UpdateConnectionInput): Promise<McpConnectionRecord> {
    if (changes.name === undefined
      && changes.serverUrl === undefined
      && changes.auth === undefined
      && changes.transport === undefined
      && changes.enabledToolNames === undefined
      && changes.runReadToolsAutomatically === undefined
      && changes.runWriteToolsAutomatically === undefined) {
      throw new Error("At least one MCP connection update is required");
    }
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    const settings = await this.loadSpaceViewSettings(context);
    const linked = linkedModules(settings).some((entry) => {
      const pointer = object(object(entry).pointer);
      return asString(pointer.table) === "workflow_module"
        && asString(pointer.id) === id
        && asString(pointer.spaceId) === context.spaceId;
    });
    if (!linked) throw new Error(`MCP connection ${id} is not linked to the current Personal Agent`);

    const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", id);
    if (asString(moduleRecord.id) !== id
      || asString(moduleRecord.module_type) !== "mcpServer"
      || moduleRecord.alive !== true
      || asString(moduleRecord.space_id) !== context.spaceId) {
      throw new Error(`${id} is not a live MCP module in the active workspace`);
    }
    const currentData = object(moduleRecord.data);
    const currentName = asString(currentData.name, asString(currentData.officialName, existing?.name ?? id));
    const currentServerUrl = asString(currentData.serverUrl, existing?.serverUrl ?? "");
    if (!currentServerUrl) throw new Error(`MCP connection ${id} has no server URL`);
    const currentTransport = normalizeTransport(asString(currentData.preferredTransport, existing?.transport ?? "streamableHttp"));
    const name = changes.name === undefined ? currentName : changes.name.trim();
    if (!name) throw new Error("name is required");
    const serverUrl = changes.serverUrl === undefined ? currentServerUrl : normalizeServerUrl(changes.serverUrl);
    const transport = changes.transport === undefined ? currentTransport : normalizeTransport(changes.transport);
    const serverSettingsChanged = serverUrl !== currentServerUrl || transport !== currentTransport;
    if (serverSettingsChanged && changes.auth === undefined) {
      throw new Error("Changing serverUrl or transport requires auth to validate and reconnect the MCP server");
    }

    const reconnect = changes.auth !== undefined || serverSettingsChanged;
    let validatedTools: unknown[] | undefined;
    if (reconnect) {
      const validation = await this.validateInContext(context, serverUrl, changes.auth, changes.approvalIntent ?? "approve_on_connect");
      validatedTools = Array.isArray(validation.tools) ? validation.tools : [];
    }
    const enabledToolNames = Array.isArray(changes.enabledToolNames)
      ? normalizeEnabledToolNames(changes.enabledToolNames, toolNamesFrom(validatedTools ?? currentData.tools))
      : undefined;
    const data: JsonObject = {
      ...currentData,
      id,
      name,
      serverUrl,
      preferredTransport: transport,
      ...(validatedTools && validatedTools.length > 0 ? { tools: validatedTools } : {}),
      ...(enabledToolNames !== undefined ? { enabledToolNames: persistedToolNames(enabledToolNames) } : {}),
      ...(changes.runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically: changes.runReadToolsAutomatically } : {}),
      ...(changes.runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically: changes.runWriteToolsAutomatically } : {})
    };
    if (changes.enabledToolNames === null) delete data.enabledToolNames;
    await this.api.post("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [{
          pointer: { table: "workflow_module", id, spaceId: context.spaceId },
          path: ["data"],
          command: changes.enabledToolNames === null ? "set" : "update",
          args: data
        }]
      }]
    });
    if (reconnect) {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: id,
        spaceId: context.spaceId,
        authHeaders: buildAuthHeaderList(changes.auth),
        initiationContext: "reconnect",
        approvalIntent: changes.approvalIntent ?? "approve_on_connect"
      });
    }
    const remoteToolNames = toolNamesFrom(data.tools);
    const storedEnabled = storedToolNames(data.enabledToolNames);
    const record: McpConnectionRecord = {
      id,
      name,
      serverUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      authType: changes.auth?.type ?? existing?.authType ?? "unknown",
      transport,
      toolNames: remoteToolNames.length > 0 ? remoteToolNames : [...(existing?.toolNames ?? [])],
      ...(storedEnabled !== undefined ? { enabledToolNames: storedEnabled } : {}),
      runReadToolsAutomatically: data.runReadToolsAutomatically !== false,
      runWriteToolsAutomatically: data.runWriteToolsAutomatically === true,
      createdAt: existing?.createdAt ?? asIsoTimestamp(moduleRecord.created_time) ?? new Date().toISOString()
    };
    this.registry.upsert(record);
    return record;
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    await this.deactivateAndUnlink(id, context);
    this.registry.remove(id);
    return { removed: true };
  }

  async list(): Promise<McpConnectionSummary[]> {
    const context = await this.context();
    const settings = await this.loadSpaceViewSettings(context);
    const localRecords = this.registry.list().filter((record) =>
      record.spaceId === context.spaceId && (!record.spaceViewId || record.spaceViewId === context.spaceViewId)
    );
    const localById = new Map(localRecords.map((record) => [record.id, record]));
    const linked: Array<{ id: string; spaceId: string; defaultEnabled: boolean }> = [];
    const seen = new Set<string>();
    for (const entry of linkedModules(settings)) {
      const rawEntry = object(entry);
      const pointer = object(rawEntry.pointer);
      const id = asString(pointer.id);
      const spaceId = asString(pointer.spaceId, context.spaceId);
      if (asString(pointer.table) !== "workflow_module" || !id || spaceId !== context.spaceId || seen.has(id)) continue;
      seen.add(id);
      linked.push({ id, spaceId, defaultEnabled: rawEntry.defaultEnabled === true });
    }
    const records = await this.loadSpaceRecords(context, linked.map(({ id, spaceId }) => ({ table: "workflow_module", id, spaceId })));
    const summaries: McpConnectionSummary[] = [];
    for (const link of linked) {
      const record = records.get(`workflow_module:${link.id}`);
      if (!record || asString(record.module_type) !== "mcpServer") continue;
      const recordSpaceId = asString(record.space_id, context.spaceId);
      if (recordSpaceId !== context.spaceId) continue;
      const data = object(record.data);
      const local = localById.get(link.id);
      const remoteToolNames = toolNamesFrom(data.tools);
      const enabledToolNames = storedToolNames(data.enabledToolNames);
      summaries.push({
        id: link.id,
        name: asString(data.name, asString(data.officialName, local?.name ?? link.id)),
        serverUrl: asString(data.serverUrl, local?.serverUrl ?? ""),
        spaceId: context.spaceId,
        spaceViewId: context.spaceViewId,
        authType: local?.authType ?? "unknown",
        transport: asString(data.preferredTransport, local?.transport ?? ""),
        toolNames: remoteToolNames.length > 0 ? remoteToolNames : [...(local?.toolNames ?? [])],
        enabledToolNames: enabledToolNames ?? null,
        runReadToolsAutomatically: data.runReadToolsAutomatically !== false,
        runWriteToolsAutomatically: data.runWriteToolsAutomatically === true,
        createdAt: asIsoTimestamp(record.created_time) ?? local?.createdAt ?? null,
        source: local ? "notion_and_registry" : "notion",
        alive: record.alive === true,
        linked: true,
        defaultEnabled: link.defaultEnabled
      });
      localById.delete(link.id);
    }
    for (const local of localRecords) {
      if (!localById.has(local.id)) continue;
      summaries.push({
        id: local.id,
        name: local.name,
        serverUrl: local.serverUrl,
        spaceId: context.spaceId,
        spaceViewId: context.spaceViewId,
        authType: local.authType,
        transport: local.transport,
        toolNames: [...local.toolNames],
        enabledToolNames: local.enabledToolNames ? [...local.enabledToolNames] : null,
        runReadToolsAutomatically: local.runReadToolsAutomatically !== false,
        runWriteToolsAutomatically: local.runWriteToolsAutomatically === true,
        createdAt: local.createdAt,
        source: "registry_only",
        alive: null,
        linked: false,
        defaultEnabled: false
      });
    }
    return summaries;
  }

  async status(id: string): Promise<JsonObject> {
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    const settings = await this.loadSpaceViewSettings(context);
    const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", id);
    if (asString(moduleRecord.module_type) !== "mcpServer") throw new Error(`${id} is not an MCP workflow module`);
    const moduleData = object(moduleRecord.data);
    const connectionPointer = object(moduleData.connectionPointer);
    const connectionId = asString(connectionPointer.id);
    const connectionTable = asString(connectionPointer.table);
    const connectionSpaceId = asString(connectionPointer.spaceId, context.spaceId);
    const alive = moduleRecord.alive === true;
    const linked = linkedModules(settings).some((entry) => linkedModuleId(entry) === id);
    let connectionStatus: "connected" | "needs_reauth" | "needs_setup" | "disconnected" = alive && linked ? "needs_setup" : "disconnected";
    if (alive && linked && connectionId && connectionTable) {
      const externalConnection = await this.loadSpaceRecord(context, connectionTable, connectionId, connectionSpaceId);
      connectionStatus = object(externalConnection.data).authenticated === false ? "needs_reauth" : "connected";
    }
    return {
      moduleId: id,
      spaceId: context.spaceId,
      moduleType: "mcpServer",
      alive,
      linked,
      status: connectionStatus,
      connected: connectionStatus === "connected",
      authType: existing?.authType ?? "unknown",
      transport: asString(moduleData.preferredTransport, existing?.transport ?? ""),
      enabledToolNames: storedToolNames(moduleData.enabledToolNames) ?? null,
      runReadToolsAutomatically: moduleData.runReadToolsAutomatically !== false,
      runWriteToolsAutomatically: moduleData.runWriteToolsAutomatically === true,
      ...(connectionId && connectionTable ? {
        connectionPointer: { table: connectionTable, id: connectionId, spaceId: connectionSpaceId }
      } : {})
    };
  }

  async startOAuth(serverUrl: string, options: StartOAuthOptions | string = {}): Promise<JsonObject> {
    // Accept the old optional name string without forwarding the obsolete field.
    const resolved = typeof options === "string" ? {} : options;
    const normalizedServerUrl = normalizeServerUrl(serverUrl);
    const selectedScopes = normalizeOAuthScopes(resolved.selectedScopes);
    const workflowId = resolved.workflowId?.trim();
    const existingModuleId = resolved.existingModuleId?.trim();
    if (resolved.workflowId !== undefined && !workflowId) throw new Error("workflowId cannot be empty");
    if (resolved.existingModuleId !== undefined && !existingModuleId) throw new Error("existingModuleId cannot be empty");

    const rawClientId = resolved.userProvidedOAuthClientId;
    const rawClientSecret = resolved.userProvidedOAuthClientSecret;
    if ((rawClientId === undefined) !== (rawClientSecret === undefined)) {
      throw new Error("userProvidedOAuthClientId and userProvidedOAuthClientSecret must be provided together");
    }
    const clientId = rawClientId?.trim();
    if (rawClientId !== undefined && !clientId) throw new Error("userProvidedOAuthClientId cannot be empty");
    if (rawClientSecret !== undefined && !rawClientSecret.trim()) throw new Error("userProvidedOAuthClientSecret cannot be empty");

    const context = await this.context();
    if (existingModuleId) {
      const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", existingModuleId);
      const moduleData = object(moduleRecord.data);
      if (moduleRecord.alive !== true || asString(moduleRecord.module_type) !== "mcpServer") {
        throw new Error(`${existingModuleId} is not a live MCP workflow module`);
      }
      if (asString(moduleRecord.space_id, context.spaceId) !== context.spaceId) {
        throw new Error(`${existingModuleId} is not in the active workspace`);
      }
      const currentServerUrl = asString(moduleData.serverUrl);
      if (!currentServerUrl || normalizeServerUrl(currentServerUrl) !== normalizedServerUrl) {
        throw new Error("OAuth reconnect serverUrl must match the existing MCP module");
      }
    }

    const integrationId = randomUUID();
    const response = await this.api.post("initiateMcpOAuth", {
      serverUrl: normalizedServerUrl,
      spaceId: context.spaceId,
      integrationId,
      ...(workflowId ? { workflowId } : {}),
      ...(selectedScopes ? { selectedScopes } : {}),
      initiationContext: existingModuleId ? "reconnect" : "connect",
      callbackType: "popup",
      callbackOrigin: ["https:", "", "app.notion.com"].join("/"),
      ...(clientId ? { userProvidedOAuthClientId: clientId } : {}),
      ...(rawClientSecret ? { userProvidedOAuthClientSecret: rawClientSecret } : {}),
      approvalIntent: "approve_on_connect"
    });
    return safeOAuthResponse(response, integrationId, rawClientSecret);
  }

  async listPreconfigured(): Promise<JsonObject> {
    const { spaceId } = await this.context();
    return this.api.post("getPreconfiguredMcpServers", { spaceId });
  }

  async connectPreconfigured(preconfiguredServerId: string): Promise<JsonObject> {
    const { spaceId } = await this.context();
    return this.api.post("connectPreconfiguredMcpServer", { preconfiguredServerId, spaceId });
  }
}
