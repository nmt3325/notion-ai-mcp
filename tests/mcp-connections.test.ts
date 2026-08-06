import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpConnectionManager, McpRegistry, buildAuthHeaders, normalizeServerUrl, toolNamesFrom, type McpApi } from "../src/mcp-connections.js";

function fakeApi(responses: Record<string, Record<string, unknown>> = {}): { api: McpApi; calls: Array<{ endpoint: string; body: Record<string, unknown> }> } {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const api: McpApi = {
    post: async (endpoint, body) => { calls.push({ endpoint, body }); return responses[endpoint] ?? {}; },
    spaceId: async () => "space-1"
  };
  return { api, calls };
}

test("buildAuthHeaders covers every supported auth style", () => {
  assert.deepEqual(buildAuthHeaders({ type: "bearer", token: "abc" }), { Authorization: "Bearer abc" });
  assert.deepEqual(buildAuthHeaders({ type: "token", token: "abc" }), { Authorization: "Bearer abc" });
  assert.deepEqual(buildAuthHeaders({ type: "apiKey", key: "k" }), { "X-API-Key": "k" });
  assert.deepEqual(buildAuthHeaders({ type: "apiKey", key: "k", headerName: "X-Custom" }), { "X-Custom": "k" });
  assert.deepEqual(buildAuthHeaders({ type: "basic", username: "u", password: "p" }), { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` });
  assert.deepEqual(buildAuthHeaders({ type: "header", headers: { "X-A": "1" } }), { "X-A": "1" });
  assert.deepEqual(buildAuthHeaders({ type: "oauth" }), {});
  assert.deepEqual(buildAuthHeaders({ type: "none" }), {});
  assert.deepEqual(buildAuthHeaders(undefined), {});
});

test("normalizeServerUrl requires https outside localhost", () => {
  assert.equal(normalizeServerUrl(" https://mcp.example.com/mcp/ "), "https://mcp.example.com/mcp");
  assert.equal(normalizeServerUrl("http://localhost:3000/mcp"), "http://localhost:3000/mcp");
  assert.throws(() => normalizeServerUrl("http://example.com/mcp"), /https/);
  assert.throws(() => normalizeServerUrl("not a url"), /valid URL/);
});

test("toolNamesFrom accepts arrays and wrapped payloads", () => {
  assert.deepEqual(toolNamesFrom([{ name: "a" }]), ["a"]);
  assert.deepEqual(toolNamesFrom({ tools: [{ name: "b" }] }), ["b"]);
  assert.deepEqual(toolNamesFrom(null), []);
});

test("add() validates, creates the module, then connects it", async () => {
  const { api, calls } = fakeApi({ validateMcpConnection: { tools: [{ name: "ask_question" }, { name: "read_wiki_contents" }] } });
  const manager = new McpConnectionManager(api);
  const record = await manager.add({ name: "DeepWiki", serverUrl: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "secret" } });
  assert.deepEqual(calls.map((call) => call.endpoint), ["validateMcpConnection", "saveTransactionsFanout", "postWorkflowsMcpServerConnect"]);
  assert.deepEqual(record.toolNames, ["ask_question", "read_wiki_contents"]);
  assert.equal(record.authType, "bearer");
  const create = calls[1]?.body as { transactions: Array<{ operations: Array<{ pointer: { table: string }; args: Record<string, unknown> }> }> };
  const operation = create.transactions[0]?.operations[0];
  assert.equal(operation?.pointer.table, "workflow_module");
  assert.equal((operation?.args as { module_type: string }).module_type, "mcp_server");
  const connect = calls[2]?.body as { authHeaders: Record<string, string> };
  assert.deepEqual(connect.authHeaders, { Authorization: "Bearer secret" });
});

test("remove() marks the module dead in Notion", async () => {
  const { api, calls } = fakeApi();
  const manager = new McpConnectionManager(api);
  await manager.remove("module-1");
  assert.deepEqual(calls.map((call) => call.endpoint), ["saveTransactionsFanout"]);
  const body = calls[0]?.body as { transactions: Array<{ operations: Array<{ args: Record<string, unknown> }> }> };
  assert.deepEqual(body.transactions[0]?.operations[0]?.args, { alive: false });
});

test("registry persists connections to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
  try {
    const path = join(dir, "registry.json");
    const registry = new McpRegistry(path);
    registry.upsert({ id: "a", name: "A", serverUrl: "https://example.com/mcp", spaceId: "s", authType: "bearer", transport: "http", toolNames: [], createdAt: new Date().toISOString() });
    assert.equal(new McpRegistry(path).list().length, 1);
    assert.equal(registry.remove("a"), true);
    assert.equal(new McpRegistry(path).list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
