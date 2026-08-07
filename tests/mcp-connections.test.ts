import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  McpConnectionManager, McpRegistry, buildAuthHeaderList, buildAuthHeaders,
  normalizeServerUrl, normalizeTransport, toolNamesFrom, type McpApi
} from "../src/mcp-connections.js";

function fakeApi(responses: Record<string, Record<string, unknown>> = {}): { api: McpApi; calls: Array<{ endpoint: string; body: Record<string, unknown> }> } {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const api: McpApi = {
    post: async (endpoint, body) => { calls.push({ endpoint, body }); return responses[endpoint] ?? {}; },
    spaceId: async () => "space-1"
  };
  return { api, calls };
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

test("add() validates, creates the module, then connects it with current payloads", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "ask_question" }, { name: "read_wiki_contents" }] } });
  const manager = new McpConnectionManager(api);
  const record = await manager.add({ name: "DeepWiki", serverUrl: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "secret" } });
  assert.deepEqual(calls.map((call) => call.endpoint), ["validateMcpConnection", "saveTransactionsFanout", "postWorkflowsMcpServerConnect"]);
  assert.deepEqual(record.toolNames, ["ask_question", "read_wiki_contents"]);
  assert.equal(record.authType, "bearer");
  assert.equal(record.transport, "streamableHttp");
  assert.deepEqual(calls[0]?.body.authHeaders, [{ name: "Authorization", value: "Bearer secret" }]);
  assert.equal(calls[0]?.body.approvalIntent, "approve_on_connect");
  const create = calls[1]?.body as { transactions: Array<{ operations: Array<{ pointer: { table: string }; args: Record<string, unknown> }> }> };
  const operation = create.transactions[0]?.operations[0];
  assert.equal(operation?.pointer.table, "workflow_module");
  assert.equal((operation?.args as { module_type: string }).module_type, "mcpServer");
  const data = (operation?.args as { data: Record<string, unknown> }).data;
  assert.equal(data.preferredTransport, "streamableHttp");
  const connect = calls[2]?.body as { authHeaders: Array<{ name: string; value: string }>; initiationContext: string; approvalIntent: string };
  assert.deepEqual(connect.authHeaders, [{ name: "Authorization", value: "Bearer secret" }]);
  assert.equal(connect.initiationContext, "connect");
  assert.equal(connect.approvalIntent, "approve_on_connect");
});

test("add() supports an unauthenticated MCP server with an empty header list", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { success: true, tools: [{ name: "ping" }] } });
  const manager = new McpConnectionManager(api);
  const record = await manager.add({ name: "Public", serverUrl: "https://mcp.example.com/mcp", auth: { type: "none" } });
  assert.equal(record.authType, "none");
  assert.deepEqual(calls[0]?.body.authHeaders, []);
  assert.deepEqual(calls[2]?.body.authHeaders, []);
});

test("remove() marks the module dead in Notion", async () => {
  const { api, calls } = fakeApi();
  const manager = new McpConnectionManager(api);
  await manager.remove("module-1");
  assert.deepEqual(calls.map((call) => call.endpoint), ["saveTransactionsFanout"]);
  const body = calls[0]?.body as { transactions: Array<{ operations: Array<{ args: Record<string, unknown> }> }> };
  assert.deepEqual(body.transactions[0]?.operations[0]?.args, { alive: false });
});

test("status uses the current moduleId payload key", async () => {
  const { api, calls } = fakeApi();
  const manager = new McpConnectionManager(api);
  await manager.status("module-1");
  assert.deepEqual(calls[0], { endpoint: "getMcpOAuthStatus", body: { moduleId: "module-1", spaceId: "space-1" } });
});

test("registry persists connections to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
  try {
    const path = join(dir, "registry.json");
    const registry = new McpRegistry(path);
    registry.upsert({ id: "a", name: "A", serverUrl: "https://example.com/mcp", spaceId: "s", authType: "bearer", transport: "streamableHttp", toolNames: [], createdAt: new Date().toISOString() });
    assert.equal(new McpRegistry(path).list().length, 1);
    assert.equal(registry.remove("a"), true);
    assert.equal(new McpRegistry(path).list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
