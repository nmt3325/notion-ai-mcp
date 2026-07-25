import assert from "node:assert/strict";
import test from "node:test";
import type { NotionConfig } from "../src/config.js";
import {
  NotionClient,
  notionRichTextToMarkdown,
  parseConversationMessages,
  parseInferenceLines
} from "../src/notion-client.js";

const account = {
  tokenV2: "secret-token",
  userId: "11111111-1111-4111-8111-111111111111",
  userName: "Test User",
  userEmail: "test@example.com",
  spaceId: "22222222-2222-4222-8222-222222222222",
  spaceName: "Test Space",
  spaceViewId: "33333333-3333-4333-8333-333333333333",
  timezone: "Asia/Tokyo",
  clientVersion: "23.13.test",
  browserId: "44444444-4444-4444-8444-444444444444",
  deviceId: "55555555-5555-4555-8555-555555555555"
};

const config: NotionConfig = {
  apiBase: "https://www.notion.so/api/v3",
  defaultModel: "test-model",
  requestTimeoutMs: 5_000,
  account
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function ndjsonResponse(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

test("Notion rich text is converted to Markdown", () => {
  assert.equal(
    notionRichTextToMarkdown([["bold", [["b"]]], [" and "], ["link", [["a", "https://example.com"]]]]),
    "**bold** and [link](https://example.com)"
  );
});

test("conversation records keep only user-visible user and assistant text", () => {
  const ids = ["config", "user", "thinking", "assistant"];
  const records = {
    config: { value: { value: { step: { type: "config", value: {} } } } },
    user: {
      value: {
        value: {
          created_time: 10,
          step: { type: "user", value: [["Hello ", [["b"]]], ["Notion"]] }
        }
      }
    },
    thinking: {
      value: { value: { step: { type: "agent-inference", value: [{ type: "thinking", content: "hidden" }] } } }
    },
    assistant: {
      value: {
        value: {
          created_time: 20,
          step: {
            type: "agent-inference",
            value: [{ type: "thinking", content: "hidden" }, { type: "text", content: "Visible answer" }]
          }
        }
      }
    }
  };
  assert.deepEqual(parseConversationMessages(ids, records), [
    { id: "user", role: "user", text: "**Hello **Notion", createdAt: 10 },
    { id: "assistant", role: "assistant", text: "Visible answer", createdAt: 20 }
  ]);
});

test("cumulative agent-inference NDJSON returns only the final text and usage", () => {
  const result = parseInferenceLines([
    JSON.stringify({ type: "agent-inference", id: "step", value: [{ type: "text", content: "Hel" }] }),
    JSON.stringify({
      type: "agent-inference",
      id: "step",
      value: [{ type: "text", content: "Hello" }],
      finishedAt: 1,
      inputTokens: 3,
      outputTokens: 2
    })
  ]);
  assert.equal(result.text, "Hello");
  assert.equal(result.inputTokens, 3);
  assert.equal(result.outputTokens, 2);
});

test("SSE data framing is accepted in addition to native NDJSON", () => {
  const result = parseInferenceLines([
    "event: message",
    `data: ${JSON.stringify({ type: "agent-inference", value: [{ type: "text", content: "SSE response" }] })}`,
    "data: [DONE]"
  ]);
  assert.equal(result.text, "SSE response");
});

test("patch NDJSON ignores thinking and aggregates text", () => {
  const result = parseInferenceLines([
    JSON.stringify({
      type: "patch",
      v: [
        { o: "a", p: "/s/0/value/-", v: { type: "thinking", content: "" } },
        { o: "x", p: "/s/0/value/0/content", v: "secret" },
        { o: "a", p: "/s/0/value/-", v: { type: "text", content: "" } },
        { o: "x", p: "/s/0/value/1/content", v: "Hello " },
        { o: "x", p: "/s/0/value/1/content", v: "world" },
        { o: "a", p: "/s/0/inputTokens", v: 4 },
        { o: "a", p: "/s/0/outputTokens", v: 2 }
      ]
    })
  ]);
  assert.deepEqual(result, {
    text: "Hello world",
    inputTokens: 4,
    outputTokens: 2,
    eventTypes: { patch: 1 }
  });
});

test("history endpoints use transcript listing then batched thread_message sync", async () => {
  const threadId = "66666666-6666-4666-8666-666666666666";
  const requestBodies: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requestBodies.push({ endpoint, body });
    if (endpoint === "getInferenceTranscriptsForUser") {
      return jsonResponse({
        transcripts: [{ id: threadId, title: "Captured chat", type: "workflow", created_at: 100, updated_at: 200 }],
        unreadThreadIds: [threadId],
        hasMore: false,
        nextCursor: null,
        recordMap: {
          thread: {
            [threadId]: {
              value: { value: { messages: ["m1", "m2"], type: "workflow", data: { title: "Captured chat" } } }
            }
          }
        }
      });
    }
    if (endpoint === "syncRecordValuesMain") {
      return jsonResponse({
        recordMap: {
          thread_message: {
            m1: { value: { value: { created_time: 101, step: { type: "user", value: [["Question"]] } } } },
            m2: {
              value: {
                value: {
                  created_time: 102,
                  step: { type: "agent-inference", value: [{ type: "text", content: "Answer" }] }
                }
              }
            }
          }
        }
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const listed = await client.listConversations({ limit: 10 });
  assert.equal(listed.conversations[0]?.messageCount, 2);
  assert.equal(listed.conversations[0]?.unread, true);

  const conversation = await client.getConversation(threadId);
  assert.deepEqual(conversation.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Question" },
    { role: "assistant", text: "Answer" }
  ]);
  const sync = requestBodies.find((request) => request.endpoint === "syncRecordValuesMain");
  assert.deepEqual(sync?.body, {
    requests: [
      { pointer: { table: "thread_message", id: "m1", spaceId: account.spaceId }, version: -1 },
      { pointer: { table: "thread_message", id: "m2", spaceId: account.spaceId }, version: -1 }
    ]
  });
});

test("list cursor preserves unreturned conversations within one Notion page", async () => {
  const ids = [
    "70000000-0000-4000-8000-000000000001",
    "70000000-0000-4000-8000-000000000002",
    "70000000-0000-4000-8000-000000000003"
  ];
  const fakeFetch = async (): Promise<Response> => jsonResponse({
    transcripts: ids.map((id, index) => ({ id, title: `Chat ${index + 1}`, type: "workflow" })),
    hasMore: false,
    nextCursor: null,
    recordMap: { thread: Object.fromEntries(ids.map((id) => [id, { value: { value: { messages: [] } } }])) }
  });
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const first = await client.listConversations({ limit: 2 });
  assert.deepEqual(first.conversations.map((item) => item.id), ids.slice(0, 2));
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor?.startsWith("mcpv1."));
  const second = await client.listConversations({ limit: 2, cursor: first.nextCursor ?? undefined });
  assert.deepEqual(second.conversations.map((item) => item.id), ids.slice(2));
  assert.equal(second.hasMore, false);
});

test("chat creates a workflow thread and continues it with a partial transcript", async () => {
  const inferenceBodies: Record<string, unknown>[] = [];
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inferenceBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const turn = inferenceBodies.length;
    return ndjsonResponse([
      { type: "agent-inference", id: `step-${turn}`, value: [{ type: "text", content: `Answer ${turn}` }] },
      {
        type: "agent-inference",
        id: `step-${turn}`,
        value: [{ type: "text", content: `Answer ${turn}` }],
        finishedAt: Date.now(),
        inputTokens: turn,
        outputTokens: turn + 1
      }
    ]);
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const first = await client.chat({ prompt: "First" });
  const second = await client.chat({ prompt: "Second", conversationId: first.conversationId });

  assert.equal(first.text, "Answer 1");
  assert.equal(second.text, "Answer 2");
  assert.equal(inferenceBodies[0]?.createThread, true);
  assert.equal(inferenceBodies[0]?.isPartialTranscript, false);
  assert.equal(inferenceBodies[1]?.createThread, false);
  assert.equal(inferenceBodies[1]?.isPartialTranscript, true);
  const secondTranscript = inferenceBodies[1]?.transcript as Array<Record<string, unknown>>;
  assert.equal(secondTranscript.filter((entry) => entry.type === "updated-config").length, 1);
});
