import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { NotionClient } from "../src/notion-client.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const client = new NotionClient(loadConfig());
const listed = await client.listConversations({ limit: 1, maxPages: 3 });
const first = listed.conversations[0];
const detail = first ? await client.getConversation(first.id, 3) : null;
const result: Record<string, unknown> = {
  listOk: true,
  conversationCount: listed.conversations.length,
  hasMore: listed.hasMore,
  firstConversationHash: first ? hash(first.id) : null,
  getOk: Boolean(detail),
  messageCount: detail?.messages.length ?? 0,
  roles: detail?.messages.map((message) => message.role) ?? []
};

if (process.env.NOTION_SMOKE_CHAT === "1") {
  try {
    const chat = await client.chat({
      prompt: "Reply exactly with NOTION_AI_MCP_OK",
      readOnly: true
    });
    result.chat = {
      ok: true,
      conversationHash: hash(chat.conversationId),
      responseLength: chat.text.length,
      responseHash: hash(chat.text),
      usage: chat.usage
    };
  } catch (error) {
    result.chat = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
