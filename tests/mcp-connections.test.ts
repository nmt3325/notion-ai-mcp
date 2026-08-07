import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  McpConnectionManager, McpRegistry, buildAuthHeaderList, buildAuthHeaders,
  normalizeServerUrl, normalizeTransport, toolNamesFrom, type McpApi
} from "../src/mcp-connections.js";

const context = { spaceId: "space-1", userId: "user-1", spaceViewId: "view-1" };
const existingModule = { pointer: { table: "workflow_module", id: "existing-module", spaceId: context.spaceId }, defaultEnabled: false };
function spaceViewResponse(agentChatModules: unknown[] = [existingModule]): Record<string, unknown> {
  return { recordMap: { space_view: { [context.spaceViewId]: { value: {
    id: context.spaceViewId,
    space_id: context.spaceId,
    alive: true,
    settings: { retained_setting: { enabled: true }, agent_chat_modules: agentChatModules }
  } } } } };
}
type FakeResponse = Record<string, unknown> | Error;
function fakeApi(responses: Record<string, FakeResponse> = {}): { api: McpApi; calls: Array<{ endpoint: string; body: Record<string, unknown> }> } {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const api: McpApi = {
    post: async (endpoint, body) => {
      calls.push({ endpoint, body });
      const configured = responses[endpoint];
      if (configured instanceof Error) throw configured;
      if (configured) return configured;
      if (endpoint === "syncRecordValuesMain") return spaceViewResponse();
      if (endpoint === "syncRecordValues") {
        const recordMap: Record<string, Record<string, unknown>> = {};
        for (const request of body.requests as Array<Record<string, unknown>>) {
          const pointer = request.pointer as Record<string, unknown>;
          const table = String(pointer?.table ?? "");
          const id = String(pointer?.id ?? "");
          recordMap[table] ??= {};
          if (table === "workflow_module") recordMap[table][id] = { value: {
            id, alive: true, module_type: "mcpServer", space_id: context.spaceId, created_time: 1_700_000_000_000,
            data: {
              name: `Remote ${id}`,
              serverUrl: `https://${id}.example.com/mcp`,
              preferredTransport: "streamableHttp",
              tools: [{ name: "ask_question" }],
              connectionPointer: { table: "external_connection", id: "connection-1", spaceId: context.spaceId }
            }
          } };
          if (table === "external_connection") recordMap[table][id] = { value: {
            id, alive: true, space_id: context.spaceId, data: { authenticated: true }
          } };
        }
        return { recordMap };
      }
      return {};
    },
    context: async () => context
  };
  return { api, calls };
}
function operations(call: { body: Record<string, unknown> } | undefined): Array<Record<string, unknown>> {
  const transactions = call?.body.transactions as Array<Record<string, unknown>> | undefined;
  return (transactions?.[0]?.operations as Array<Record<string, unknown>> | undefined) ?? [];
}

test("auth helpers cover every supported auth style and current wire shape", () => {
  assert.deepEqual(buildAuthHeaders({ type: "bearer", token: "abc" }), { Authorization: "Bearer abc" });
  assert.deepEqual(buildAuthHeaders({ type: "token", token: "abc" }), { Authorization: "Bearer abc" });
  assert.deepEqual(buildAuthHeaders({ type: "apiKey", key: "k" }), { "X-API-Key": "k" });
  assert.deepEqual(buildAuthHeaders({ type: "apiKey", key: "k", headerName: "X-Custom" }), { "X-Custom": "k" });
  assert.deepEqual(buildAuthHeaders({ type: "basic", username: "u", password: "p" }), { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` });
  assert.deepEqual(buildAuthHeaders({ type: "header", headers: { "X-A": "1" } }), { "X-A": "1" });
  assert.deepEqual(buildAuthHeaders({ type: "oauth" }), {});
  assert.deepEqual(buildAuthHeaders({ type: "none" }), {});
  assert.deepEqual(buildAuthHeaders(undefined), {});
  assert.deepEqual(buildAuthHeaderList({ type: "bearer", token: "abc" }), [{ name: "Authorization", value: "Bearer abc" }]);
  assert.deepEqual(buildAuthHeaderList({ type: "none" }), []);
});

test("normalizeServerUrl requires https outside localhost", () => {
  assert.equal(normalizeServerUrl(" https://mcp.example.com/mcp/ "), "https://mcp.example.com/mcp");
  assert.equal(normalizeServerUrl("http://localhost:3000/mcp"), "http://localhost:3000/mcp");
  assert.throws(() => normalizeServerUrl("http://example.com/mcp"), /https/);
  assert.throws(() => normalizeServerUrl("not a url"), /valid URL/);
});

test("normalizeTransport accepts current values and old http alias", () => {
  assert.equal(normalizeTransport(), "streamableHttp");
  assert.equal(normalizeTransport("http"), "streamableHttp");
  assert.equal(normalizeTransport("streamable-http"), "streamableHttp");
  assert.equal(normalizeTransport("sse"), "sse");
  assert.throws(() => normalizeTransport("stdio"), /streamableHttp or sse/);
});

test("toolNamesFrom accepts arrays and wrapped payloads", () => {
  assert.deepEqual(toolNamesFrom([{ name: "a" }]), ["a"]);
  assert.deepEqual(toolNamesFrom({ tools: [{ name: "b" }] }), ["b"]);
  assert.deepEqual(toolNamesFrom(null), []);
});

test("list() discovers linked modules and merges only current-workspace registry metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-list-"));
  try {
    const registryPath = join(dir, "registry.json");
    const registry = new McpRegistry(registryPath);
    const baseRecord = { name: "Local", serverUrl: "https://local.example.com/mcp", spaceId: context.spaceId, spaceViewId: context.spaceViewId, authType: "bearer" as const, transport: "streamableHttp", toolNames: ["local_tool"], createdAt: "2026-08-07T00:00:00.000Z" };
    registry.upsert({ id: "existing-module", ...baseRecord });
    registry.upsert({ id: "stale-local", ...baseRecord });
    registry.upsert({ id: "other-workspace", ...baseRecord, spaceId: "space-2" });
    const remoteOnly = { pointer: { table: "workflow_module", id: "remote-only", spaceId: context.spaceId }, defaultEnabled: true };
    const { api, calls } = fakeApi({ syncRecordValuesMain: spaceViewResponse([existingModule, remoteOnly]) });
    const manager = new McpConnectionManager(api, registryPath);
    const listed = await manager.list();
    assert.deepEqual(calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues"]);
    assert.equal(((calls[1]?.body.requests as unknown[]) ?? []).length, 2);
    assert.equal(listed.length, 3);
    const merged = listed.find((item) => item.id === "existing-module");
    assert.equal(merged?.source, "notion_and_registry");
    assert.equal(merged?.authType, "bearer");
    assert.equal(merged?.name, "Remote existing-module");
    assert.deepEqual(merged?.toolNames, ["ask_question"]);
    const remote = listed.find((item) => item.id === "remote-only");
    assert.equal(remote?.source, "notion");
    assert.equal(remote?.authType, "unknown");
    assert.equal(remote?.defaultEnabled, true);
    const stale = listed.find((item) => item.id === "stale-local");
    assert.equal(stale?.source, "registry_only");
    assert.equal(stale?.linked, false);
    assert.equal(stale?.alive, null);
    assert.equal(listed.some((item) => item.id === "other-workspace"), false);
    assert.equal(listed.some((item) => "connectionPointer" in item), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("add() uses the current factory record and preserves space-view modules", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "ask_question" }, { name: "read_wiki_contents" }] } });
  const manager = new McpConnectionManager(api);
  const record = await manager.add({ name: "DeepWiki", serverUrl: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "secret" } });
  assert.deepEqual(calls.map((call) => call.endpoint), [
    "validateMcpConnection", "saveTransactionsFanout", "postWorkflowsMcpServerConnect", "syncRecordValuesMain", "saveTransactionsFanout"
  ]);
  assert.deepEqual(record.toolNames, ["ask_question", "read_wiki_contents"]);
  assert.equal(record.authType, "bearer");
  assert.equal(record.transport, "streamableHttp");
  assert.equal(record.spaceViewId, context.spaceViewId);
  assert.deepEqual(calls[0]?.body.authHeaders, [{ name: "Authorization", value: "Bearer secret" }]);
  assert.equal(calls[0]?.body.approvalIntent, "approve_on_connect");

  const createOperation = operations(calls[1])[0];
  assert.equal((createOperation?.pointer as Record<string, unknown>)?.table, "workflow_module");
  const createArgs = createOperation?.args as Record<string, unknown>;
  assert.equal(createArgs.module_type, "mcpServer");
  assert.equal(createArgs.created_by_id, context.userId);
  assert.equal(createArgs.created_by_table, "notion_user");
  assert.equal(createArgs.last_edited_by_id, context.userId);
  assert.equal(createArgs.last_edited_by_table, "notion_user");
  assert.equal(createArgs.parent_id, context.userId);
  assert.equal(createArgs.parent_table, "notion_user");
  assert.equal(typeof createArgs.created_time, "number");
  assert.equal(createArgs.created_time, createArgs.last_edited_time);
  const data = createArgs.data as Record<string, unknown>;
  assert.equal(data.preferredTransport, "streamableHttp");

  const connect = calls[2]?.body as { authHeaders: Array<{ name: string; value: string }>; initiationContext: string; approvalIntent: string };
  assert.deepEqual(connect.authHeaders, [{ name: "Authorization", value: "Bearer secret" }]);
  assert.equal(connect.initiationContext, "connect");
  assert.equal(connect.approvalIntent, "approve_on_connect");

  const settingsOperation = operations(calls[4])[0];
  assert.equal((settingsOperation?.pointer as Record<string, unknown>)?.table, "space_view");
  assert.deepEqual(settingsOperation?.path, ["settings"]);
  assert.equal(settingsOperation?.command, "update");
  const settingsArgs = settingsOperation?.args as Record<string, unknown>;
  assert.deepEqual(settingsArgs.retained_setting, { enabled: true });
  const linked = settingsArgs.agent_chat_modules as Array<Record<string, unknown>>;
  assert.equal(linked.length, 2);
  assert.deepEqual(linked[0], existingModule);
  assert.equal(((linked[1]?.pointer as Record<string, unknown>)?.id), record.id);
});

test("add() supports an unauthenticated MCP server with an empty header list", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "ping" }] } });
  const manager = new McpConnectionManager(api);
  const record = await manager.add({ name: "Public", serverUrl: "https://mcp.example.com/mcp", auth: { type: "none" } });
  assert.equal(record.authType, "none");
  assert.deepEqual(calls[0]?.body.authHeaders, []);
  assert.deepEqual(calls[2]?.body.authHeaders, []);
});

test("add() deactivates and unlinks a module when connect fails", async () => {
  const { api, calls } = fakeApi({
    validateMcpConnection: { success: true, tools: [{ name: "ping" }] },
    postWorkflowsMcpServerConnect: new Error("connect failed")
  });
  const manager = new McpConnectionManager(api);
  await assert.rejects(() => manager.add({ name: "Broken", serverUrl: "https://mcp.example.com/mcp" }), /connect failed/);
  assert.deepEqual(calls.map((call) => call.endpoint), [
    "validateMcpConnection", "saveTransactionsFanout", "postWorkflowsMcpServerConnect", "syncRecordValuesMain", "saveTransactionsFanout"
  ]);
  const createdId = ((operations(calls[1])[0]?.pointer as Record<string, unknown>)?.id);
  const cleanup = operations(calls[4]);
  assert.equal((cleanup[0]?.pointer as Record<string, unknown>)?.id, createdId);
  assert.deepEqual(cleanup[0]?.args, { alive: false });
  const remaining = ((cleanup[1]?.args as Record<string, unknown>).agent_chat_modules as Array<Record<string, unknown>>);
  assert.deepEqual(remaining, [existingModule]);
});

test("remove() marks the module dead and preserves unrelated space-view settings", async () => {
  const { api, calls } = fakeApi();
  const manager = new McpConnectionManager(api);
  await manager.remove("module-1");
  assert.deepEqual(calls.map((call) => call.endpoint), ["syncRecordValuesMain", "saveTransactionsFanout"]);
  const cleanup = operations(calls[1]);
  assert.deepEqual(cleanup[0]?.args, { alive: false });
  assert.deepEqual((cleanup[1]?.args as Record<string, unknown>).retained_setting, { enabled: true });
  assert.deepEqual((cleanup[1]?.args as Record<string, unknown>).agent_chat_modules, [existingModule]);
});

test("status derives global-module health without the workflow-only OAuth endpoint", async () => {
  const linked = { pointer: { table: "workflow_module", id: "module-1", spaceId: context.spaceId }, defaultEnabled: false };
  const { api, calls } = fakeApi({ syncRecordValuesMain: spaceViewResponse([existingModule, linked]) });
  const manager = new McpConnectionManager(api);
  const status = await manager.status("module-1");
  assert.deepEqual(calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues", "syncRecordValues"]);
  assert.equal(status.status, "connected");
  assert.equal(status.connected, true);
  assert.equal(status.alive, true);
  assert.equal(status.linked, true);
  assert.equal(status.transport, "streamableHttp");
  assert.equal((status.connectionPointer as Record<string, unknown>).table, "external_connection");
});

test("registry persists connections to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
  try {
    const path = join(dir, "registry.json");
    const registry = new McpRegistry(path);
    registry.upsert({ id: "a", name: "A", serverUrl: "https://example.com/mcp", spaceId: "s", spaceViewId: "v", authType: "bearer", transport: "streamableHttp", toolNames: [], createdAt: new Date().toISOString() });
    assert.equal(new McpRegistry(path).list().length, 1);
    assert.equal(registry.remove("a"), true);
    assert.equal(new McpRegistry(path).list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
