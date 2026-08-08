import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rawUrl = process.env.NOTION_MCP_REMOTE_URL?.trim() ?? "";
const bearerToken = process.env.NOTION_MCP_HTTP_BEARER_TOKEN?.trim() ?? "";
if (!rawUrl) throw new Error("NOTION_MCP_REMOTE_URL is required");
if (bearerToken.length < 32 || /[\r\n]/.test(bearerToken)) {
  throw new Error("NOTION_MCP_HTTP_BEARER_TOKEN must be a valid token with at least 32 characters");
}

const endpoint = new URL(rawUrl);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error("NOTION_MCP_REMOTE_URL must be a credential-free HTTPS URL without query or fragment");
}
if (endpoint.pathname === "/" || endpoint.pathname === "") endpoint.pathname = "/mcp";
else if (endpoint.pathname !== "/mcp") throw new Error("NOTION_MCP_REMOTE_URL path must be / or /mcp");

const unauthenticated = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  signal: AbortSignal.timeout(30_000)
});
assert.equal(unauthenticated.status, 401, "Remote endpoint must reject an unauthenticated MCP request");
await unauthenticated.body?.cancel();

const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${bearerToken}` } }
});
const client = new Client({ name: "notion-ai-mcp-remote-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.equal(toolNames.length, 19);
  assert.ok(toolNames.includes("notion_ai_chat"));
  assert.ok(toolNames.includes("complete_mcp_oauth"));

  let readToolExecution = false;
  if (process.env.NOTION_MCP_REMOTE_CALL_READ === "1") {
    const current = await client.callTool({ name: "get_current_workspace", arguments: {} });
    assert.notEqual(current.isError, true);
    readToolExecution = true;
  }

  process.stdout.write(`${JSON.stringify({
    handshake: true,
    tls: endpoint.protocol === "https:",
    host: endpoint.hostname,
    unauthorizedStatus: unauthenticated.status,
    toolCount: toolNames.length,
    toolNames,
    readToolExecution
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
}
