import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  env: {
    ...cleanEnv,
    NOTION_TOKEN_V2: "stdio-smoke-placeholder-not-a-real-token",
    NOTION_USER_ID: "00000000-0000-4000-8000-000000000001",
    NOTION_SPACE_ID: "00000000-0000-4000-8000-000000000002",
    NOTION_SPACE_VIEW_ID: "00000000-0000-4000-8000-000000000003",
    NOTION_API_BASE: "http://127.0.0.1:9"
  },
  stderr: "pipe"
});
const client = new Client({ name: "notion-ai-mcp-command-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const response = await client.listTools();
  const names = response.tools.map((tool) => tool.name).sort();
  for (const required of ["notion_ai_chat", "upload_attachment", "download_attachment", "add_mcp_connection", "remove_mcp_connection"]) {
    assert.ok(names.includes(required), `missing required tool: ${required}`);
  }
  assert.equal(names.length, 18, `expected 18 tools, got ${names.length}`);
  process.stdout.write(`${JSON.stringify({ started: true, transport: "stdio", toolCount: names.length, tools: names }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
}
