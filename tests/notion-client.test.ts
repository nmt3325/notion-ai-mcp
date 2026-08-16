import assert from "node:assert/strict";
import test from "node:test";
import type { NotionConfig } from "../src/config.js";
import {
  NotionClient,
  answerSegment,
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
  const firstConfig = ((inferenceBodies[0]?.transcript as Array<Record<string, unknown>>)[0]?.value ?? {}) as Record<string, unknown>;
  assert.equal(firstConfig.model, "test-model");
  assert.equal(firstConfig.modelFromUser, true);
  assert.equal(firstConfig.reasoningEffort, undefined);
  assert.equal(firstConfig.isThreadStartedByAdmin, undefined);
  assert.equal(inferenceBodies[1]?.createThread, false);
  assert.equal(inferenceBodies[1]?.isPartialTranscript, true);
  const secondTranscript = inferenceBodies[1]?.transcript as Array<Record<string, unknown>>;
  assert.equal(secondTranscript.filter((entry) => entry.type === "updated-config").length, 1);
  const secondConfig = (secondTranscript[0]?.value ?? {}) as Record<string, unknown>;
  assert.equal(secondConfig.model, "test-model");
  assert.equal(secondConfig.modelFromUser, true);
  assert.equal(secondConfig.isThreadStartedByAdmin, true);
});


test("premium limits do not rotate workspace-bound conversations", async () => {
  let inferenceCalls = 0;
  let workspaceDiscoveryCalls = 0;
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "runInferenceTranscript") {
      inferenceCalls += 1;
      if (inferenceCalls === 1) return ndjsonResponse([{ type: "agent-inference", value: [{ type: "text", content: "Started" }] }]);
      return ndjsonResponse([{ type: "premium-feature-unavailable", featureAvailability: { limit: { current: 5, total: 5 } } }]);
    }
    if (endpoint === "loadUserContent") {
      workspaceDiscoveryCalls += 1;
      return jsonResponse({});
    }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient({ ...config, maxWorkspaceRetries: 5, account: { ...account } }, fakeFetch as typeof fetch);
  const first = await client.chat({ prompt: "Start" });
  await assert.rejects(
    () => client.chat({ prompt: "Continue", conversationId: first.conversationId }),
    /AI credit limit reached in the current workspace and this conversation or attachment is workspace-bound; switch workspace, then start a new chat and upload again/
  );
  assert.equal(inferenceCalls, 2);
  assert.equal(workspaceDiscoveryCalls, 0);
});


test("workspace switching and creation stay active in the same client process", async () => {
  const spaceA = "81000000-0000-4000-8000-000000000001";
  const spaceB = "81000000-0000-4000-8000-000000000002";
  const spaceC = "81000000-0000-4000-8000-000000000003";
  const viewA = "82000000-0000-4000-8000-000000000001";
  const viewB = "82000000-0000-4000-8000-000000000002";
  let viewC = "";
  const localAccount = { ...account, spaceId: spaceA, spaceViewId: viewA, spaceName: "Alpha" };
  const localConfig: NotionConfig = { ...config, account: localAccount };
  const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ endpoint, body });
    if (endpoint === "loadUserContent") {
      const pointers = [
        { id: viewA, table: "space_view", spaceId: spaceA },
        { id: viewB, table: "space_view", spaceId: spaceB },
        ...(viewC ? [{ id: viewC, table: "space_view", spaceId: spaceC }] : [])
      ];
      return jsonResponse({ recordMap: {
        user_root: { [account.userId]: { value: {
          space_views: [viewA, viewB, ...(viewC ? [viewC] : [])],
          space_view_pointers: pointers
        } } },
        space: {
          [spaceA]: { value: { name: "Alpha", plan_type: "personal" } },
          [spaceB]: { value: { name: "Beta", plan_type: "personal" } },
          [spaceC]: { value: { name: "Gamma", plan_type: "personal" } }
        }
      } });
    }
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({});
    if (endpoint === "createSpace") return jsonResponse({ spaceId: spaceC });
    if (endpoint === "saveTransactionsMain") {
      const transaction = (body.transactions as Array<Record<string, unknown>>)[0];
      const operations = transaction.operations as Array<Record<string, unknown>>;
      const operation = operations.find((candidate) => (candidate.pointer as Record<string, unknown>)?.table === "space_view");
      viewC = String((operation?.pointer as Record<string, unknown>)?.id ?? "");
      return jsonResponse({});
    }
    if (endpoint === "syncRecordValuesMain") {
      return jsonResponse({ recordMap: { space_view: {
        [viewC]: { value: { id: viewC, version: 1, space_id: spaceC, parent_id: account.userId, parent_table: "user_root", alive: true, joined: true } }
      } } });
    }
    return new Response("unexpected", { status: 500 });
  };

  const client = new NotionClient(localConfig, fakeFetch as typeof fetch);
  await client.switchWorkspace("Beta");
  assert.equal((await client.getCurrentWorkspace()).spaceId, spaceB);

  const created = await client.createWorkspace("Gamma", { pin: true });
  assert.equal(created.spaceId, spaceC);
  assert.equal(created.spaceViewId, viewC);
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceId, spaceC);
  assert.equal(current.spaceViewId, viewC);
  assert.equal(current.pinnedSpaceId, spaceC);
  assert.equal(localConfig.account.spaceId, spaceC);
  assert.equal((requests.find((request) => request.endpoint === "createSpace")?.body).planSelection, "personal");
});

const FIRST_SPACE = "90000000-0000-4000-8000-000000000001";
const FIRST_VIEW = "91000000-0000-4000-8000-000000000001";
const READABLE_SPACE = "90000000-0000-4000-8000-000000000002";
const READABLE_VIEW = "91000000-0000-4000-8000-000000000002";
const OTHER_SPACE = "90000000-0000-4000-8000-000000000003";
const OTHER_VIEW = "91000000-0000-4000-8000-000000000003";
const DISCOVERY_USER = "92000000-0000-4000-8000-000000000001";

function discoveryFetch(
  calls: string[] = [],
  options: { firstSpaceRecord?: Record<string, unknown>; extraUsers?: Record<string, unknown> } = {}
): typeof fetch {
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    calls.push(endpoint);
    if (endpoint !== "loadUserContent") return new Response("unexpected", { status: 500 });
    return jsonResponse({
      recordMap: {
        notion_user: {
          ...(options.extraUsers ?? {}),
          [DISCOVERY_USER]: { value: { id: DISCOVERY_USER, name: "Discovered User", email: "discovered@example.com" } }
        },
        user_root: { [DISCOVERY_USER]: { value: { space_view_pointers: [
          { id: FIRST_VIEW, table: "space_view", spaceId: FIRST_SPACE },
          { id: READABLE_VIEW, table: "space_view", spaceId: READABLE_SPACE },
          { id: OTHER_VIEW, table: "space_view", spaceId: OTHER_SPACE }
        ] } } },
        space: {
          ...(options.firstSpaceRecord ? { [FIRST_SPACE]: { value: options.firstSpaceRecord } } : {}),
          [READABLE_SPACE]: { value: { id: READABLE_SPACE, name: "Reachable", plan_type: "personal" } },
          [OTHER_SPACE]: { value: { id: OTHER_SPACE, name: "Other", plan_type: "personal" } }
        },
        user_settings: { [DISCOVERY_USER]: { value: { settings: { time_zone: "Asia/Tokyo" } } } }
      }
    });
  };
  return fakeFetch as typeof fetch;
}

test("workspace discovery skips pointers whose space record is missing", async () => {
  const client = new NotionClient({ ...config, account: { tokenV2: "secret-token" } }, discoveryFetch());
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceId, READABLE_SPACE);
  assert.equal(current.spaceViewId, READABLE_VIEW);
  assert.equal(current.spaceName, "Reachable");
  assert.equal(current.userEmail, "discovered@example.com");
});

test("workspace discovery skips pointers whose space is deleted", async () => {
  const client = new NotionClient(
    { ...config, account: { tokenV2: "secret-token" } },
    discoveryFetch([], { firstSpaceRecord: { id: FIRST_SPACE, name: "Trashed", plan_type: "personal", deleted: true } })
  );
  assert.equal((await client.getCurrentWorkspace()).spaceId, READABLE_SPACE);
});

test("workspace discovery keeps the first pointer when its space is readable", async () => {
  const client = new NotionClient(
    { ...config, account: { tokenV2: "secret-token" } },
    discoveryFetch([], { firstSpaceRecord: { id: FIRST_SPACE, name: "First", plan_type: "personal" } })
  );
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceId, FIRST_SPACE);
  assert.equal(current.spaceViewId, FIRST_VIEW);
});

test("an explicitly configured space id is never replaced by discovery", async () => {
  const client = new NotionClient({ ...config, account: { tokenV2: "secret-token", spaceId: OTHER_SPACE } }, discoveryFetch());
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceId, OTHER_SPACE);
  assert.equal(current.spaceViewId, OTHER_VIEW);
  assert.equal(current.spaceName, "Other");
});

test("a pinned space id wins over discovery ranking", async () => {
  const client = new NotionClient({ ...config, account: { tokenV2: "secret-token", pinnedSpaceId: OTHER_SPACE } }, discoveryFetch());
  assert.equal((await client.getCurrentWorkspace()).spaceId, OTHER_SPACE);
});

test("display names are backfilled when only ids are configured", async () => {
  const calls: string[] = [];
  const client = new NotionClient(
    { ...config, account: { tokenV2: "secret-token", userId: DISCOVERY_USER, spaceId: READABLE_SPACE, spaceViewId: READABLE_VIEW } },
    discoveryFetch(calls)
  );
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceName, "Reachable");
  assert.equal(current.userEmail, "discovered@example.com");
  assert.equal(calls.filter((endpoint) => endpoint === "loadUserContent").length, 1);
});

test("discovery picks the notion_user that owns the user_root", async () => {
  const bot = "92000000-0000-4000-8000-0000000000bb";
  const client = new NotionClient(
    { ...config, account: { tokenV2: "secret-token" } },
    discoveryFetch([], { extraUsers: { [bot]: { value: { id: bot, name: "Bot" } } } })
  );
  const current = await client.getCurrentWorkspace();
  assert.equal(current.spaceId, READABLE_SPACE);
  assert.equal(current.userEmail, "discovered@example.com");
});

test("a fully configured account never calls discovery", async () => {
  const calls: string[] = [];
  const client = new NotionClient({ ...config, account: { ...account } }, discoveryFetch(calls));
  assert.equal((await client.getCurrentWorkspace()).spaceId, account.spaceId);
  assert.equal(calls.length, 0);
});

test("pagination reports the end of the list when the last page fills the limit exactly", async () => {
  const transcript = (id: string) => ({ id, title: `Thread ${id}`, type: "workflow", created_at: 1, updated_at: 2 });
  const requestedCursors: Array<string | undefined> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint !== "getInferenceTranscriptsForUser") return new Response("unexpected", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { cursor?: string };
    requestedCursors.push(body.cursor);
    if (!body.cursor) return jsonResponse({ transcripts: [transcript("a"), transcript("b")], hasMore: true, nextCursor: "page-2", recordMap: { thread: {} } });
    if (body.cursor === "page-2") return jsonResponse({ transcripts: [transcript("c"), transcript("d")], hasMore: false, nextCursor: null, recordMap: { thread: {} } });
    return new Response("unexpected cursor", { status: 500 });
  };
  const client = new NotionClient({ ...config, account: { ...account } }, fakeFetch as typeof fetch);
  const listed = await client.listConversations({ limit: 4 });
  assert.deepEqual(listed.conversations.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(listed.hasMore, false);
  assert.equal(listed.nextCursor, null);
  assert.deepEqual(requestedCursors, [undefined, "page-2"]);
});

test("pagination still resumes mid-page when more results remain", async () => {
  const transcript = (id: string) => ({ id, title: `Thread ${id}`, type: "workflow", created_at: 1, updated_at: 2 });
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint !== "getInferenceTranscriptsForUser") return new Response("unexpected", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { cursor?: string };
    if (!body.cursor) return jsonResponse({ transcripts: [transcript("a"), transcript("b"), transcript("c")], hasMore: true, nextCursor: "page-2", recordMap: { thread: {} } });
    return jsonResponse({ transcripts: [transcript("d")], hasMore: false, nextCursor: null, recordMap: { thread: {} } });
  };
  const client = new NotionClient({ ...config, account: { ...account } }, fakeFetch as typeof fetch);
  const first = await client.listConversations({ limit: 2 });
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await client.listConversations({ limit: 2, cursor: first.nextCursor ?? undefined });
  assert.deepEqual(second.conversations.map((item) => item.id), ["c", "d"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("list_conversations rejects a cursor it never issued", async () => {
  const fakeFetch = async (): Promise<Response> => {
    throw new Error("fetch must not run for an invalid cursor");
  };
  const client = new NotionClient({ ...config, account: { ...account } }, fakeFetch as unknown as typeof fetch);
  await assert.rejects(client.listConversations({ limit: 2, cursor: "not-a-cursor" }), /Invalid list_conversations cursor/);
});

test("list_conversations rejects a corrupted cursor payload", async () => {
  const fakeFetch = async (): Promise<Response> => {
    throw new Error("fetch must not run for an invalid cursor");
  };
  const client = new NotionClient({ ...config, account: { ...account } }, fakeFetch as unknown as typeof fetch);
  await assert.rejects(client.listConversations({ limit: 2, cursor: "mcpv1.bm90LWpzb24" }), /Invalid list_conversations cursor/);
});

test("renameConversation verifies ownership and updates thread data", async () => {
  const threadId = "66666666-6666-4666-8666-666666666666";
  let saveBody: Record<string, unknown> | undefined;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({
      transcripts: [{ id: threadId, title: "Before" }],
      hasMore: false,
      recordMap: { thread: { [threadId]: { value: { value: { data: { title: "Before" }, messages: [] } } } } }
    });
    if (endpoint === "saveTransactionsFanout") {
      saveBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({});
    }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const renamed = await client.renameConversation(threadId, " After ");
  assert.deepEqual(renamed, { conversationId: threadId, previousTitle: "Before", title: "After", changed: true });
  const transaction = (saveBody?.transactions as Array<Record<string, unknown>>)[0];
  const operation = (transaction.operations as Array<Record<string, unknown>>)[0];
  assert.deepEqual(operation, {
    pointer: { table: "thread", id: threadId, spaceId: account.spaceId },
    path: ["data"],
    command: "update",
    args: { title: "After" }
  });
  await assert.rejects(() => client.renameConversation(threadId, "bad\nname"), /one line/);
});

test("chat persists the requested reasoning effort and reuses it for later turns", async () => {
  const inferenceBodies: Record<string, unknown>[] = [];
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    inferenceBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return ndjsonResponse([
      { type: "agent-inference", id: "step", value: [{ type: "text", content: "Answer" }], finishedAt: Date.now(), inputTokens: 1, outputTokens: 1 }
    ]);
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const first = await client.chat({ prompt: "First", model: "gpt-5.4", reasoningEffort: "high" });
  assert.equal(first.model, "oval-kumquat-medium");
  assert.equal(first.reasoningEffort, "high");
  const firstConfig = ((inferenceBodies[0]?.transcript as Array<Record<string, unknown>>)[0]?.value ?? {}) as Record<string, unknown>;
  assert.equal(firstConfig.model, "oval-kumquat-medium");
  assert.equal(firstConfig.modelFromUser, true);
  assert.equal(firstConfig.reasoningEffort, "high");

  const second = await client.chat({ prompt: "Second", model: "gpt-5.4", conversationId: first.conversationId });
  assert.equal(second.reasoningEffort, "high");
  const secondConfig = ((inferenceBodies[1]?.transcript as Array<Record<string, unknown>>)[0]?.value ?? {}) as Record<string, unknown>;
  assert.equal(secondConfig.reasoningEffort, "high");

  const third = await client.chat({ prompt: "Third", model: "gpt-5.4", reasoningEffort: "medium", conversationId: first.conversationId });
  assert.equal(third.reasoningEffort, "medium");
  const thirdConfig = ((inferenceBodies[2]?.transcript as Array<Record<string, unknown>>)[0]?.value ?? {}) as Record<string, unknown>;
  assert.equal(thirdConfig.reasoningEffort, "medium");
});

test("chat rejects an effort the selected model does not expose", async () => {
  let calls = 0;
  const fakeFetch = async (): Promise<Response> => {
    calls += 1;
    return ndjsonResponse([{ type: "agent-inference", value: [{ type: "text", content: "unexpected" }] }]);
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  await assert.rejects(
    () => client.chat({ prompt: "Hello", model: "gpt-5.4", reasoningEffort: "low" }),
    /does not support reasoningEffort "low"/
  );
  await assert.rejects(
    () => client.chat({ prompt: "Hello", model: "Claude Opus 4.5", reasoningEffort: "high" }),
    /has no reasoningEffort picker/
  );
  assert.equal(calls, 0);
});

test("a resumed conversation replays the config and context ids stored on the thread", async () => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  const configStepId = "aaaaaaa1-0000-4000-8000-000000000001";
  const contextStepId = "aaaaaaa1-0000-4000-8000-000000000002";
  const userStepId = "aaaaaaa1-0000-4000-8000-000000000003";
  const updatedConfigStepId = "aaaaaaa1-0000-4000-8000-000000000004";
  let inferenceBody: Record<string, unknown> | undefined;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({
      transcripts: [{ id: threadId, title: "Earlier chat" }],
      hasMore: false,
      recordMap: { thread: { [threadId]: { value: { value: {
        id: threadId, created_time: 1_700_000_000_000,
        messages: [configStepId, contextStepId, userStepId, updatedConfigStepId]
      } } } } }
    });
    if (endpoint === "syncRecordValuesMain") return jsonResponse({ recordMap: { thread_message: {
      [configStepId]: { value: { value: { step: { id: configStepId, type: "config", value: { model: "orange-mousse", reasoningEffort: "max" } } } } },
      [contextStepId]: { value: { value: { step: { id: contextStepId, type: "context", value: {} } } } },
      [userStepId]: { value: { value: { step: { id: userStepId, type: "user", value: [["Earlier question"]] } } } },
      [updatedConfigStepId]: { value: { value: { step: { id: updatedConfigStepId, type: "updated-config" } } } }
    } } });
    if (endpoint === "runInferenceTranscript") {
      inferenceBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return ndjsonResponse([{ type: "agent-inference", value: [{ type: "text", content: "Resumed answer" }] }]);
    }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const resumed = await client.chat({ prompt: "Continue", conversationId: threadId });
  assert.equal(resumed.text, "Resumed answer");
  assert.equal(resumed.model, "orange-mousse");
  assert.equal(resumed.reasoningEffort, "max");
  const transcript = (inferenceBody?.transcript ?? []) as Array<Record<string, unknown>>;
  assert.equal(inferenceBody?.isPartialTranscript, true);
  assert.equal(inferenceBody?.threadId, threadId);
  assert.equal(transcript[0]?.id, configStepId);
  assert.equal(transcript[0]?.type, "config");
  assert.equal(transcript[1]?.id, contextStepId);
  assert.equal(transcript[1]?.type, "context");
  assert.deepEqual(
    transcript.filter((step) => step.type === "updated-config").map((step) => step.id),
    [updatedConfigStepId]
  );
});

test("resuming a thread whose config steps are gone refuses instead of sending an invalid transcript", async () => {
  const threadId = "88888888-8888-4888-8888-888888888888";
  const userStepId = "bbbbbbb1-0000-4000-8000-000000000001";
  let inferenceCalls = 0;
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({
      transcripts: [{ id: threadId, title: "Broken" }],
      hasMore: false,
      recordMap: { thread: { [threadId]: { value: { value: { id: threadId, messages: [userStepId] } } } } }
    });
    if (endpoint === "syncRecordValuesMain") return jsonResponse({ recordMap: { thread_message: {
      [userStepId]: { value: { value: { step: { id: userStepId, type: "user", value: [["Only question"]] } } } }
    } } });
    if (endpoint === "runInferenceTranscript") { inferenceCalls += 1; return ndjsonResponse([]); }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  await assert.rejects(() => client.chat({ prompt: "Continue", conversationId: threadId }), /cannot be resumed/);
  assert.equal(inferenceCalls, 0);
});

test("a text-less stream reports the workspace and stream events instead of an empty response", async () => {
  const fakeFetch = async (): Promise<Response> => ndjsonResponse([
    { type: "agent-instruction-state" },
    { type: "record-map", recordMap: {} }
  ]);
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  await assert.rejects(() => client.chat({ prompt: "Hello" }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /streamed no answer text/);
    assert.match(message, new RegExp(account.spaceId));
    assert.match(message, /record-map=1/);
    assert.match(message, /AI credits/);
    return true;
  });
});

// Reproduces a live incident: a slow request and a fast request sharing one thread.
const parallelThread = [
  { id: "user-a", role: "user" as const, text: "slow request", createdAt: 1786848450636 },
  { id: "step-a-progress", role: "assistant" as const, text: "素数を数えています…", createdAt: 1786848455000 },
  { id: "step-a-answer", role: "assistant" as const, text: "【遅い方の回答A】168個", createdAt: 1786848460153 },
  { id: "user-b", role: "user" as const, text: "fast request", createdAt: 1786848530560 },
  { id: "step-b-answer", role: "assistant" as const, text: "【速い方の回答B】2", createdAt: 1786848532324 }
];

test("an answer is taken from the turn its own request opened, never from a parallel request", () => {
  const slow = answerSegment(parallelThread, "user-a");
  assert.equal(slow.text, "【遅い方の回答A】168個");
  assert.equal(slow.matchedBy, "userMessageId");
  assert.equal(slow.closed, true);

  const fast = answerSegment(parallelThread, "user-b");
  assert.equal(fast.text, "【速い方の回答B】2");
});

test("progress notes of an unfinished turn are not reported as the finished answer", () => {
  const segment = answerSegment(parallelThread.slice(0, 2), "user-a");
  assert.equal(segment.text, "素数を数えています…");
  assert.equal(segment.closed, false);
  assert.equal(segment.askedFound, true);
});

test("a request step missing from the thread is reported as a guess, not as a match", () => {
  const segment = answerSegment(parallelThread, "user-missing");
  assert.equal(segment.matchedBy, "latestAssistant");
  assert.equal(segment.askedFound, false);
});

test("thread steps stay separable so a progress note never merges into the answer", () => {
  const ids = ["one", "two"];
  const step = (content: string, createdTime: number) => ({
    value: { value: { created_time: createdTime, step: { type: "agent-inference", value: [{ type: "text", content }] } } }
  });
  const records = { one: step("working on it", 1), two: step("final answer", 2) };
  const merged = parseConversationMessages(ids, records);
  const separate = parseConversationMessages(ids, records, { merge: false });
  assert.equal(merged.length, 1);
  assert.equal(separate.length, 2);
  assert.equal(separate.at(-1)?.text, "final answer");
});
