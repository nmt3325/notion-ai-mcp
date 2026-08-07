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
export interface McpHeader { name: string; value: string }

export interface McpConnectionRecord {
  id: string;
  name: string;
  serverUrl: string;
  spaceId: string;
  authType: McpAuth["type"];
  transport: string;
  toolNames: string[];
  createdAt: string;
}

export interface McpApi {
  post(endpoint: string, body: JsonObject): Promise<JsonObject>;
  spaceId(): Promise<string>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }

/** Turns a declarative auth choice into the legacy header map used by callers. */
export function buildAuthHeaders(auth: McpAuth | undefined): Record<string, string> {
  if (!auth) return {};
  switch (auth.type) {
    case "none":
    case "oauth":
      return {};
    case "bearer":
    case "token":
      return { Authorization: `Bearer ${auth.token}` };
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

export interface AddConnectionInput {
  name: string;
  serverUrl: string;
  auth?: McpAuth;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
}

export class McpConnectionManager {
  private readonly registry: McpRegistry;

  constructor(private readonly api: McpApi, registryPath?: string) {
    this.registry = new McpRegistry(registryPath);
  }

  async checkOAuthSupport(serverUrl: string): Promise<JsonObject> {
    const spaceId = await this.api.spaceId();
    return this.api.post("checkMcpOAuthSupport", { serverUrl: normalizeServerUrl(serverUrl), spaceId });
  }

  async validate(serverUrl: string, auth?: McpAuth, approvalIntent: McpApprovalIntent = "approve_on_connect"): Promise<JsonObject> {
    const spaceId = await this.api.spaceId();
    const response = await this.api.post("validateMcpConnection", {
      serverUrl: normalizeServerUrl(serverUrl),
      spaceId,
      authHeaders: buildAuthHeaderList(auth),
      approvalIntent
    });
    if (response.success === false) {
      const detail = asString(object(response.error).message, "connection validation failed");
      throw new Error(`Notion rejected the MCP server: ${detail}`);
    }
    return response;
  }

  /** Notion stores custom MCP servers as workflow_module records on the space. */
  buildCreateTransaction(moduleId: string, spaceId: string, input: AddConnectionInput, toolList: unknown[]): JsonObject {
    const data: JsonObject = {
      id: moduleId,
      name: input.name,
      icon: "🤖",
      serverUrl: normalizeServerUrl(input.serverUrl),
      preferredTransport: normalizeTransport(input.transport),
      ...(toolList.length ? { tools: toolList } : {}),
      runReadToolsAutomatically: true,
      runWriteToolsAutomatically: true
    };
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId,
        operations: [
          {
            pointer: { table: "workflow_module", id: moduleId, spaceId },
            path: [],
            command: "set",
            args: {
              id: moduleId,
              version: 1,
              alive: true,
              parent_id: spaceId,
              parent_table: "space",
              space_id: spaceId,
              module_type: "mcpServer",
              data
            }
          }
        ]
      }]
    };
  }

  private deadTransaction(moduleId: string, spaceId: string): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId,
        operations: [{
          pointer: { table: "workflow_module", id: moduleId, spaceId },
          path: [],
          command: "update",
          args: { alive: false }
        }]
      }]
    };
  }

  async add(input: AddConnectionInput): Promise<McpConnectionRecord & { validation: JsonObject }> {
    const spaceId = await this.api.spaceId();
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const approvalIntent = input.approvalIntent ?? "approve_on_connect";
    const validation = await this.validate(serverUrl, input.auth, approvalIntent);
    const toolList = Array.isArray(validation.tools) ? (validation.tools as unknown[]) : [];
    const moduleId = randomUUID();
    const transport = normalizeTransport(input.transport);
    await this.api.post("saveTransactionsFanout", this.buildCreateTransaction(moduleId, spaceId, { ...input, serverUrl, transport }, toolList));
    try {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: moduleId,
        spaceId,
        authHeaders: buildAuthHeaderList(input.auth),
        initiationContext: "connect",
        approvalIntent
      });
    } catch (error) {
      await this.api.post("saveTransactionsFanout", this.deadTransaction(moduleId, spaceId)).catch(() => undefined);
      throw error;
    }
    const record: McpConnectionRecord = {
      id: moduleId,
      name: input.name,
      serverUrl,
      spaceId,
      authType: input.auth?.type ?? "none",
      transport,
      toolNames: toolNamesFrom(toolList),
      createdAt: new Date().toISOString()
    };
    this.registry.upsert(record);
    return { ...record, validation };
  }

  async update(id: string, changes: { name?: string; serverUrl?: string; auth?: McpAuth; transport?: string; approvalIntent?: McpApprovalIntent }): Promise<McpConnectionRecord> {
    const existing = this.registry.get(id);
    if (!existing) throw new Error(`MCP connection ${id} is not in the local registry`);
    const spaceId = existing.spaceId || (await this.api.spaceId());
    const serverUrl = changes.serverUrl ? normalizeServerUrl(changes.serverUrl) : existing.serverUrl;
    const name = changes.name?.trim() || existing.name;
    const transport = normalizeTransport(changes.transport || existing.transport);
    const data: JsonObject = { id, name, serverUrl, preferredTransport: transport };
    await this.api.post("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId,
        operations: [{
          pointer: { table: "workflow_module", id, spaceId },
          path: ["data"],
          command: "update",
          args: data
        }]
      }]
    });
    if (changes.auth) {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: id,
        spaceId,
        authHeaders: buildAuthHeaderList(changes.auth),
        initiationContext: "reconnect",
        approvalIntent: changes.approvalIntent ?? "approve_on_connect"
      });
    }
    const record: McpConnectionRecord = { ...existing, name, serverUrl, transport, ...(changes.auth ? { authType: changes.auth.type } : {}) };
    this.registry.upsert(record);
    return record;
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    const existing = this.registry.get(id);
    const spaceId = existing?.spaceId || (await this.api.spaceId());
    await this.api.post("saveTransactionsFanout", this.deadTransaction(id, spaceId));
    return { removed: this.registry.remove(id) || true };
  }

  list(): McpConnectionRecord[] { return this.registry.list(); }

  async status(id: string): Promise<JsonObject> {
    const spaceId = (this.registry.get(id)?.spaceId) || (await this.api.spaceId());
    return this.api.post("getMcpOAuthStatus", { moduleId: id, spaceId });
  }

  async startOAuth(serverUrl: string, name?: string): Promise<JsonObject> {
    const spaceId = await this.api.spaceId();
    const integrationId = randomUUID();
    const response = await this.api.post("initiateMcpOAuth", {
      serverUrl: normalizeServerUrl(serverUrl),
      spaceId,
      integrationId,
      selectedScopes: [],
      initiationContext: "connect",
      callbackType: "popup",
      callbackOrigin: "https://app.notion.com",
      approvalIntent: "approve_on_connect",
      ...(name ? { name } : {})
    });
    return { integrationId, ...response };
  }

  async listPreconfigured(): Promise<JsonObject> {
    const spaceId = await this.api.spaceId();
    return this.api.post("getPreconfiguredMcpServers", { spaceId });
  }

  async connectPreconfigured(preconfiguredServerId: string): Promise<JsonObject> {
    const spaceId = await this.api.spaceId();
    return this.api.post("connectPreconfiguredMcpServer", { preconfiguredServerId, spaceId });
  }
}
