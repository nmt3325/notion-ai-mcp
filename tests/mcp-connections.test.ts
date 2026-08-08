import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  McpConnectionManager, McpRegistry, buildAuthHeaderList, buildAuthHeaders,
  normalizeEnabledToolNames, normalizeOAuthScopes, normalizeServerUrl, normalizeTransport, toolNamesFrom, type McpApi
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
              connectionPointer: { table: "external_connection", id: "connection-1", spaceId: context.spaceId },
              resources: [{ uri: "resource://preserved" }],
              futureField: { nested: ["preserved"] },
              ...(id === "remote-only" ? {
                enabledToolNames: ["__NONE__"],
                runReadToolsAutomatically: false,
                runWriteToolsAutomatically: true
              } : {})
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
  assert.deepEqual(buildAuthHeaders({ type: "token", token: "abc" }), { Authorization: "Token abc" });
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

test("enabled tool selections trim, deduplicate, and reject unknown names", () => {
  assert.deepEqual(normalizeEnabledToolNames([" read ", "read"], ["read", "write"]), ["read"]);
  assert.deepEqual(normalizeEnabledToolNames([], ["read"]), []);
  assert.throws(() => normalizeEnabledToolNames(["missing"], ["read"]), /Unknown MCP tool name/);
  assert.throws(() => normalizeEnabledToolNames(["__NONE__"], ["__NONE__"]), /Unknown MCP tool name/);
  assert.throws(() => normalizeEnabledToolNames(["  "], ["read"]), /empty names/);
});

test("OAuth scopes trim, deduplicate, and reject explicit empty selections", () => {
  assert.equal(normalizeOAuthScopes(undefined), undefined);
  assert.deepEqual(normalizeOAuthScopes([" read ", "write", "read"]), ["read", "write"]);
  assert.throws(() => normalizeOAuthScopes([]), /at least one scope/);
  assert.throws(() => normalizeOAuthScopes(["  "]), /empty scopes/);
});

test("startOAuth sends the current payload and never returns or persists a BYO secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  try {
    const registryPath = join(dir, "registry.json");
    const secret = "test-client-secret";
    const { api, calls } = fakeApi({
      initiateMcpOAuth: {
        authorizationUrl: "https://provider.example.com/authorize",
        completionFlowId: "completion-1",
        oauthFlowId: "flow-1",
        userProvidedOAuthClientSecret: secret,
        futureResponseField: { echoedSecret: secret }
      }
    });
    const result = await new McpConnectionManager(api, registryPath).startOAuth(" https://mcp.example.com/mcp/ ", {
      selectedScopes: [" read ", "write", "read"],
      workflowId: "workflow-1",
      userProvidedOAuthClientId: " client-id ",
      userProvidedOAuthClientSecret: secret
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endpoint, "initiateMcpOAuth");
    const body = calls[0]?.body ?? {};
    const integrationId = body.integrationId;
    assert.equal(typeof integrationId, "string");
    assert.deepEqual(body, {
      serverUrl: "https://mcp.example.com/mcp",
      spaceId: context.spaceId,
      integrationId,
      workflowId: "workflow-1",
      selectedScopes: ["read", "write"],
      initiationContext: "connect",
      callbackType: "popup",
      callbackOrigin: "https://app.notion.com",
      userProvidedOAuthClientId: "client-id",
      userProvidedOAuthClientSecret: secret,
      approvalIntent: "approve_on_connect"
    });
    assert.deepEqual(result, {
      integrationId,
      authorizationUrl: "https://provider.example.com/authorize",
      completionFlowId: "completion-1",
      oauthFlowId: "flow-1"
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(existsSync(registryPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startOAuth rejects partial BYO credentials and unsafe explicit scope input before initiation", async () => {
  const { api, calls } = fakeApi();
  const manager = new McpConnectionManager(api);
  await assert.rejects(manager.startOAuth("https://mcp.example.com/mcp", {
    userProvidedOAuthClientId: "client-id"
  }), /must be provided together/);
  await assert.rejects(manager.startOAuth("https://mcp.example.com/mcp", {
    userProvidedOAuthClientSecret: "secret"
  }), /must be provided together/);
  await assert.rejects(manager.startOAuth("https://mcp.example.com/mcp", {
    selectedScopes: []
  }), /at least one scope/);
  assert.equal(calls.length, 0);
});

test("startOAuth uses reconnect context only after verifying the existing MCP module", async () => {
  const moduleRecord = { recordMap: { workflow_module: { "module-1": { value: {
    id: "module-1", alive: true, module_type: "mcpServer", space_id: context.spaceId,
    data: { serverUrl: "https://mcp.example.com/mcp" }
  } } } } };
  const connected = fakeApi({
    syncRecordValues: moduleRecord,
    initiateMcpOAuth: { authorizationUrl: "https://provider.example.com/authorize" }
  });
  const result = await new McpConnectionManager(connected.api).startOAuth("https://mcp.example.com/mcp", {
    existingModuleId: "module-1"
  });
  assert.deepEqual(connected.calls.map((call) => call.endpoint), ["syncRecordValues", "initiateMcpOAuth"]);
  assert.equal(connected.calls[1]?.body.initiationContext, "reconnect");
  assert.equal(result.authorizationUrl, "https://provider.example.com/authorize");

  const mismatched = fakeApi({ syncRecordValues: moduleRecord });
  await assert.rejects(new McpConnectionManager(mismatched.api).startOAuth("https://other.example.com/mcp", {
    existingModuleId: "module-1"
  }), /must match/);
  assert.deepEqual(mismatched.calls.map((call) => call.endpoint), ["syncRecordValues"]);
});

test("list() discovers linked modules and merges only current-workspace registry metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-list-"));
  try {
    const registryPath = join(dir, "registry.json");
    const registry = new McpRegistry(registryPath);
    const baseRecord = { name: "Local", serverUrl: "https://local.example.com/mcp", spaceId: context.spaceId, spaceViewId: context.spaceViewId, authType: "bearer" as const, transport: "streamableHttp", toolNames: ["local_tool"], createdAt: "2026-08-07T00:00:00.000Z" };
    registry.upsert({ id: "existing-module", ...baseRecord });
    registry.upsert({
      id: "stale-local", ...baseRecord,
      enabledToolNames: [], runReadToolsAutomatically: false, runWriteToolsAutomatically: true
    });
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
    assert.equal(merged?.enabledToolNames, null);
    assert.equal(merged?.runReadToolsAutomatically, true);
    assert.equal(merged?.runWriteToolsAutomatically, false);
    const remote = listed.find((item) => item.id === "remote-only");
    assert.equal(remote?.source, "notion");
    assert.equal(remote?.authType, "unknown");
    assert.equal(remote?.defaultEnabled, true);
    assert.deepEqual(remote?.enabledToolNames, []);
    assert.equal(remote?.runReadToolsAutomatically, false);
    assert.equal(remote?.runWriteToolsAutomatically, true);
    const stale = listed.find((item) => item.id === "stale-local");
    assert.equal(stale?.source, "registry_only");
    assert.equal(stale?.linked, false);
    assert.equal(stale?.alive, null);
    assert.deepEqual(stale?.enabledToolNames, []);
    assert.equal(stale?.runReadToolsAutomatically, false);
    assert.equal(stale?.runWriteToolsAutomatically, true);
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
  assert.equal("enabledToolNames" in data, false);
  assert.equal(data.runReadToolsAutomatically, true);
  assert.equal(data.runWriteToolsAutomatically, false);

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

test("update() renames a linked Notion-only module while preserving its full data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-update-name-"));
  try {
    const registryPath = join(dir, "registry.json");
    const { api, calls } = fakeApi();
    const manager = new McpConnectionManager(api, registryPath);
    const record = await manager.update("existing-module", { name: "Renamed MCP" });
    assert.deepEqual(calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues", "saveTransactionsFanout"]);
    const args = operations(calls[2])[0]?.args as Record<string, unknown>;
    assert.equal(args.name, "Renamed MCP");
    assert.equal(args.serverUrl, record.serverUrl);
    assert.deepEqual(args.connectionPointer, { table: "external_connection", id: "connection-1", spaceId: context.spaceId });
    assert.deepEqual(args.tools, [{ name: "ask_question" }]);
    assert.equal(record.authType, "unknown");
    assert.equal(new McpRegistry(registryPath).get("existing-module")?.name, "Renamed MCP");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("update() validates and reconnects when changing server settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-update-connect-"));
  try {
    const registryPath = join(dir, "registry.json");
    const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "new_tool" }] } });
    const manager = new McpConnectionManager(api, registryPath);
    const record = await manager.update("existing-module", {
      serverUrl: "https://new.example.com/mcp",
      transport: "sse",
      auth: { type: "bearer", token: "replacement-secret" },
      enabledToolNames: []
    });
    assert.deepEqual(calls.map((call) => call.endpoint), [
      "syncRecordValuesMain", "syncRecordValues", "validateMcpConnection", "saveTransactionsFanout", "postWorkflowsMcpServerConnect"
    ]);
    assert.deepEqual(calls[2]?.body.authHeaders, [{ name: "Authorization", value: "Bearer replacement-secret" }]);
    const args = operations(calls[3])[0]?.args as Record<string, unknown>;
    assert.equal(args.serverUrl, "https://new.example.com/mcp");
    assert.equal(args.preferredTransport, "sse");
    assert.deepEqual(args.tools, [{ name: "new_tool" }]);
    assert.deepEqual(args.enabledToolNames, ["__NONE__"]);
    assert.deepEqual(args.connectionPointer, { table: "external_connection", id: "connection-1", spaceId: context.spaceId });
    assert.equal(calls[4]?.body.initiationContext, "reconnect");
    assert.equal(record.authType, "bearer");
    assert.deepEqual(record.toolNames, ["new_tool"]);
    assert.deepEqual(record.enabledToolNames, []);
    assert.equal(readFileSync(registryPath, "utf8").includes("replacement-secret"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("update() rejects unlinked, cross-workspace, and unauthenticated server changes", async () => {
  const unlinked = fakeApi({ syncRecordValuesMain: spaceViewResponse([]) });
  await assert.rejects(() => new McpConnectionManager(unlinked.api).update("missing", { name: "Nope" }), /not linked/);
  assert.deepEqual(unlinked.calls.map((call) => call.endpoint), ["syncRecordValuesMain"]);

  const wrongWorkspaceRecord = { recordMap: { workflow_module: { "existing-module": { value: {
    id: "existing-module", alive: true, module_type: "mcpServer", space_id: "space-2",
    data: { name: "Wrong", serverUrl: "https://wrong.example.com/mcp", preferredTransport: "streamableHttp" }
  } } } } };
  const wrongWorkspace = fakeApi({ syncRecordValues: wrongWorkspaceRecord });
  await assert.rejects(() => new McpConnectionManager(wrongWorkspace.api).update("existing-module", { name: "Nope" }), /active workspace/);
  assert.deepEqual(wrongWorkspace.calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues"]);

  const missingAuth = fakeApi();
  await assert.rejects(
    () => new McpConnectionManager(missingAuth.api).update("existing-module", { serverUrl: "https://new.example.com/mcp" }),
    /requires auth/
  );
  assert.deepEqual(missingAuth.calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues"]);
});


test("add() persists an explicit tool selection and approval policy", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "read" }, { name: "write" }] } });
  const record = await new McpConnectionManager(api).add({
    name: "Scoped",
    serverUrl: ["https:", "", "mcp.example.com", "mcp"].join("/"),
    enabledToolNames: [" write ", "write"],
    runReadToolsAutomatically: false,
    runWriteToolsAutomatically: true
  });
  const data = (operations(calls[1])[0]?.args as Record<string, unknown>).data as Record<string, unknown>;
  assert.deepEqual(data.enabledToolNames, ["write"]);
  assert.equal(data.runReadToolsAutomatically, false);
  assert.equal(data.runWriteToolsAutomatically, true);
  assert.deepEqual(record.enabledToolNames, ["write"]);
  assert.equal(record.runReadToolsAutomatically, false);
  assert.equal(record.runWriteToolsAutomatically, true);
});

test("add() encodes an explicit disable-all selection without exposing the sentinel", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "read" }] } });
  const record = await new McpConnectionManager(api).add({
    name: "Disabled",
    serverUrl: ["https:", "", "mcp.example.com", "mcp"].join("/"),
    enabledToolNames: []
  });
  const data = (operations(calls[1])[0]?.args as Record<string, unknown>).data as Record<string, unknown>;
  assert.deepEqual(data.enabledToolNames, ["__NONE__"]);
  assert.deepEqual(record.enabledToolNames, []);
});

test("tool filters reject unknown names before any persistence", async () => {
  const add = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "read" }] } });
  await assert.rejects(() => new McpConnectionManager(add.api).add({
    name: "Scoped",
    serverUrl: ["https:", "", "mcp.example.com", "mcp"].join("/"),
    enabledToolNames: ["missing"]
  }), /Unknown MCP tool name/);
  assert.deepEqual(add.calls.map((call) => call.endpoint), ["validateMcpConnection"]);

  const update = fakeApi();
  await assert.rejects(
    () => new McpConnectionManager(update.api).update("existing-module", { enabledToolNames: ["missing"] }),
    /Unknown MCP tool name/
  );
  assert.deepEqual(update.calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues"]);
});

test("update() changes and clears tool policy without reconnecting", async () => {
  const changed = fakeApi();
  const changedRecord = await new McpConnectionManager(changed.api).update("existing-module", {
    enabledToolNames: [],
    runReadToolsAutomatically: false,
    runWriteToolsAutomatically: true
  });
  assert.deepEqual(changed.calls.map((call) => call.endpoint), ["syncRecordValuesMain", "syncRecordValues", "saveTransactionsFanout"]);
  const changedData = operations(changed.calls[2])[0]?.args as Record<string, unknown>;
  assert.deepEqual(changedData.enabledToolNames, ["__NONE__"]);
  assert.equal(changedData.runReadToolsAutomatically, false);
  assert.equal(changedData.runWriteToolsAutomatically, true);
  assert.deepEqual(changedData.connectionPointer, { table: "external_connection", id: "connection-1", spaceId: context.spaceId });
  assert.deepEqual(changedData.resources, [{ uri: "resource://preserved" }]);
  assert.deepEqual(changedData.futureField, { nested: ["preserved"] });
  assert.deepEqual(changedRecord.enabledToolNames, []);

  const filteredRecord = { recordMap: { workflow_module: { "existing-module": { value: {
    id: "existing-module", alive: true, module_type: "mcpServer", space_id: context.spaceId,
    data: {
      name: "Filtered",
      serverUrl: ["https:", "", "mcp.example.com", "mcp"].join("/"),
      preferredTransport: "streamableHttp",
      tools: [{ name: "read" }],
      enabledToolNames: ["read"]
    }
  } } } } };
  const cleared = fakeApi({ syncRecordValues: filteredRecord });
  const clearedRecord = await new McpConnectionManager(cleared.api).update("existing-module", { enabledToolNames: null });
  const clearedOperation = operations(cleared.calls[2])[0];
  const clearedData = clearedOperation?.args as Record<string, unknown>;
  assert.equal(clearedOperation?.command, "set");
  assert.equal("enabledToolNames" in clearedData, false);
  assert.equal(clearedRecord.enabledToolNames, undefined);
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

test("status decodes Notion's disable-all sentinel and effective run policy", async () => {
  const linked = { pointer: { table: "workflow_module", id: "module-1", spaceId: context.spaceId }, defaultEnabled: false };
  const records = { recordMap: {
    workflow_module: { "module-1": { value: {
      id: "module-1", alive: true, module_type: "mcpServer", space_id: context.spaceId,
      data: {
        name: "Disabled", serverUrl: "https://mcp.example.com/mcp", preferredTransport: "streamableHttp",
        tools: [{ name: "read" }], enabledToolNames: ["__NONE__"],
        runReadToolsAutomatically: false, runWriteToolsAutomatically: true,
        connectionPointer: { table: "external_connection", id: "connection-1", spaceId: context.spaceId }
      }
    } } },
    external_connection: { "connection-1": { value: {
      id: "connection-1", alive: true, space_id: context.spaceId, data: { authenticated: true }
    } } }
  } };
  const { api } = fakeApi({
    syncRecordValuesMain: spaceViewResponse([existingModule, linked]),
    syncRecordValues: records
  });
  const status = await new McpConnectionManager(api).status("module-1");
  assert.deepEqual(status.enabledToolNames, []);
  assert.equal(status.runReadToolsAutomatically, false);
  assert.equal(status.runWriteToolsAutomatically, true);
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
