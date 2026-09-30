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

for (const [label, stub] of [
  ["bare", { role: "none" }],
  ["value wrapper", { value: { role: "none" } }],
  ["double wrapper", { value: { value: { role: "none" } } }],
  ["denied wrapper with empty value", { role: "none", value: {} }]
] as const) {
  test(`permission-denied ${label} records are not usable watchdog or Continue evidence`, async () => {
    const fake: typeof fetch = async (input, init) => {
      assert.equal(String(input).split("/").at(-1), "syncRecordValuesMain");
      const body = JSON.parse(String(init?.body));
      const recordMap: Record<string, Record<string, unknown>> = {};
      for (const { pointer: { table, id } } of body.requests) {
        recordMap[table] ??= {};
        recordMap[table]![id] = stub;
      }
      return new Response(JSON.stringify({ recordMap }), { headers: { "content-type": "application/json" } });
    };
    const client = new NotionClient({ ...config, stateFilePath: undefined }, fake);
    await assert.rejects(client.threadSignals("unreadable-thread"), /unreadable.*role "none".*token_v2.*restart/i);
    await assert.rejects(client.finalStepShape("unreadable-step"), /unreadable.*role "none".*token_v2.*restart/i);
    await assert.rejects(client.nativeContinuationState("unreadable-thread"), /unreadable.*role "none".*token_v2.*restart/i);
  });
}

test("absent records retain their not-found/null semantics rather than implying permission denial", async () => {
  const fake: typeof fetch = async () => new Response(JSON.stringify({ recordMap: {} }));
  const client = new NotionClient({ ...config, stateFilePath: undefined }, fake);
  await assert.rejects(client.threadSignals("missing-thread"), /was not found/);
  assert.equal(await client.finalStepShape("missing-step"), null);
  assert.equal(await client.nativeContinuationState("missing-thread"), null);
});

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

test("deleteConversation verifies ownership and turns the thread record off", async () => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  let saveBody: Record<string, unknown> | undefined;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({
      transcripts: [{ id: threadId, title: "Doomed" }],
      hasMore: false,
      recordMap: { thread: { [threadId]: { value: { value: { alive: true, data: { title: "Doomed" }, messages: [] } } } } }
    });
    if (endpoint === "saveTransactionsFanout") {
      saveBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({});
    }
    return new Response("unexpected", { status: 500 });
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const deleted = await client.deleteConversation(threadId);
  assert.deepEqual(deleted, { conversationId: threadId, title: "Doomed", deleted: true, alreadyDeleted: false });
  const transaction = (saveBody?.transactions as Array<Record<string, unknown>>)[0];
  const operation = (transaction.operations as Array<Record<string, unknown>>)[0];
  assert.deepEqual(operation, {
    pointer: { table: "thread", id: threadId, spaceId: account.spaceId },
    path: [],
    command: "update",
    args: { alive: false }
  });
});

test("deleteConversation stays a no-op for a thread Notion already deleted", async () => {
  const threadId = "88888888-8888-4888-8888-888888888888";
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({
      transcripts: [{ id: threadId, title: "Gone" }],
      hasMore: false,
      recordMap: { thread: { [threadId]: { value: { value: { alive: false, data: { title: "Gone" }, messages: [] } } } } }
    });
    throw new Error("no transaction must run for an already deleted thread");
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  assert.deepEqual(await client.deleteConversation(threadId), { conversationId: threadId, title: "Gone", deleted: false, alreadyDeleted: true });
});

test("deleteConversation refuses a thread outside the active workspace", async () => {
  const threadId = "99999999-9999-4999-8999-999999999999";
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint === "getInferenceTranscriptsForUser") return jsonResponse({ transcripts: [], hasMore: false, recordMap: { thread: {} } });
    throw new Error("no transaction must run for an unknown thread");
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  await assert.rejects(() => client.deleteConversation(threadId), /was not found/);
});

// A getAvailableModels response trimmed to the fields the client reads, shaped like the live one.
const AVAILABLE_MODELS = {
  models: [
    {
      model: "almond-croissant-low", modelMessage: "Sonnet 4.6", modelFamily: "anthropic", modelProvider: "anthropic", displayGroup: "fast",
      modelConfiguration: { supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "low" },
      isDisabled: false, workflow: { finalModelName: "almond-croissant-low", beta: false }
    },
    {
      model: "albuquerque-quinn", modelMessage: "Opus 5.5", modelFamily: "anthropic", modelProvider: "anthropic", displayGroup: "intelligent",
      modelConfiguration: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      isDisabled: false,
      workflow: { finalModelName: "albuquerque-quinn-v2", beta: false },
      agentService: { finalModelName: "albuquerque-quinn-agent", beta: false }
    },
    {
      model: "oval-kumquat-medium", modelMessage: "GPT-5.4", modelFamily: "openai", modelProvider: "openai", displayGroup: "intelligent",
      modelConfiguration: { supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
      isDisabled: false, workflow: { finalModelName: "oval-kumquat-medium", beta: false }
    },
    {
      model: "xinomavro-cake", modelMessage: "Grok Build 0.1", modelFamily: "xai", modelProvider: "xai", displayGroup: "intelligent",
      modelConfiguration: { supportedReasoningEfforts: [] },
      isDisabled: false, workflow: { finalModelName: "xinomavro-cake", beta: true }
    },
    {
      model: "orlando-quinn", modelMessage: "GPT-6 Astra", modelFamily: "openai", modelProvider: "openai", displayGroup: "intelligent",
      modelConfiguration: { supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
      isDisabled: true, disabledReason: "credit_limit_reached",
      workflow: { finalModelName: "orlando-quinn", isDisabled: true, disabledReason: "restricted_access" }
    }
  ],
  modelSelectionRestricted: false
};

const catalogConfig: NotionConfig = {
  ...config,
  defaultModel: "almond-croissant-low",
  modelCatalog: { enabled: true, ttlMs: 60_000, allowUnlisted: false }
};

interface CatalogFake {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  catalogRequests: Array<{ body: Record<string, unknown>; spaceHeader: string | null }>;
  inference: Array<Record<string, unknown>>;
}

function catalogFake(options: { modelsStatus?: (call: number) => number } = {}): CatalogFake {
  const catalogRequests: CatalogFake["catalogRequests"] = [];
  const inference: CatalogFake["inference"] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (endpoint === "getAvailableModels") {
      catalogRequests.push({ body, spaceHeader: new Headers(init?.headers).get("x-notion-space-id") });
      const status = options.modelsStatus?.(catalogRequests.length) ?? 200;
      return status === 200 ? jsonResponse(AVAILABLE_MODELS) : new Response("catalog unavailable", { status });
    }
    if (endpoint === "runInferenceTranscript") {
      inference.push(body);
      const turn = inference.length;
      return ndjsonResponse([
        { type: "agent-inference", id: `step-${turn}`, value: [{ type: "text", content: `Answer ${turn}` }], finishedAt: Date.now(), inputTokens: 1, outputTokens: 1 }
      ]);
    }
    return new Response(`unexpected ${endpoint}`, { status: 500 });
  };
  return { fetchImpl, catalogRequests, inference };
}

function configStep(body: Record<string, unknown> | undefined): Record<string, unknown> {
  return ((body?.transcript as Array<Record<string, unknown>> | undefined)?.[0]?.value ?? {}) as Record<string, unknown>;
}

test("chat resolves the model and reasoning effort against the live getAvailableModels list", async () => {
  const fake = catalogFake();
  const client = new NotionClient(catalogConfig, fake.fetchImpl as typeof fetch);

  const first = await client.chat({ prompt: "First", model: "Opus 5.5", reasoningEffort: "xhigh" });
  assert.equal(first.model, "albuquerque-quinn-v2");
  assert.equal(first.modelName, "Opus 5.5");
  assert.equal(first.reasoningEffort, "xhigh");
  assert.equal(first.warnings, undefined);
  assert.equal(configStep(fake.inference[0]).model, "albuquerque-quinn-v2");
  assert.equal(configStep(fake.inference[0]).modelFromUser, true);
  assert.equal(configStep(fake.inference[0]).reasoningEffort, "xhigh");
  assert.equal((fake.inference[0]?.debugOverrides as Record<string, unknown> | undefined)?.model, "albuquerque-quinn-v2");

  // A later turn without model keeps the conversation's model and effort.
  const second = await client.chat({ prompt: "Second", conversationId: first.conversationId });
  assert.equal(second.model, "albuquerque-quinn-v2");
  assert.equal(second.reasoningEffort, "xhigh");
  assert.equal(configStep(fake.inference[1]).model, "albuquerque-quinn-v2");
  assert.equal(configStep(fake.inference[1]).reasoningEffort, "xhigh");

  // Switching to a model without that effort falls back to the new model's default and says so.
  const third = await client.chat({ prompt: "Third", model: "gpt-5.4", conversationId: first.conversationId });
  assert.equal(third.model, "oval-kumquat-medium");
  assert.equal(third.reasoningEffort, "medium");
  assert.match(third.warnings?.join(" ") ?? "", /GPT-5\.4 \(oval-kumquat-medium\) does not support the conversation's reasoningEffort xhigh; using medium instead/);
  assert.equal(configStep(fake.inference[2]).reasoningEffort, "medium");

  // An effort suffix in the model name picks the effort.
  const fourth = await client.chat({ prompt: "Fourth", model: "opus-5.5-max", conversationId: first.conversationId });
  assert.equal(fourth.model, "albuquerque-quinn-v2");
  assert.equal(fourth.reasoningEffort, "max");
  assert.equal(configStep(fake.inference[3]).reasoningEffort, "max");

  // A new chat without model uses NOTION_DEFAULT_MODEL and sends that model's default effort explicitly.
  const fresh = await client.chat({ prompt: "Default" });
  assert.equal(fresh.model, "almond-croissant-low");
  assert.equal(fresh.modelName, "Sonnet 4.6");
  assert.equal(fresh.reasoningEffort, "low");
  assert.equal(configStep(fake.inference[4]).reasoningEffort, "low");

  // A model without an effort setting gets none.
  const grok = await client.chat({ prompt: "Grok", model: "Grok Build 0.1" });
  assert.equal(grok.model, "xinomavro-cake");
  assert.equal(grok.reasoningEffort, undefined);
  assert.equal(configStep(fake.inference[5]).reasoningEffort, undefined);

  // One getAvailableModels call for the workspace; the other turns use the cached list.
  assert.deepEqual(fake.catalogRequests, [{ body: { spaceId: account.spaceId }, spaceHeader: account.spaceId }]);
});

test("chat rejects a model or effort the live list does not allow before anything is sent", async () => {
  const fake = catalogFake();
  const client = new NotionClient(catalogConfig, fake.fetchImpl as typeof fetch);
  await assert.rejects(
    () => client.chat({ prompt: "Hello", model: "gpt-5.4", reasoningEffort: "low" }),
    /GPT-5\.4 \(oval-kumquat-medium\) does not support reasoningEffort "low"\. Supported: medium, high \(default medium\)/
  );
  await assert.rejects(() => client.chat({ prompt: "Hello", model: "Grok Build 0.1", reasoningEffort: "high" }), /has no reasoning effort setting/);
  await assert.rejects(() => client.chat({ prompt: "Hello", model: "GPT-6 Astra" }), /GPT-6 Astra \(orlando-quinn\) is disabled/);
  await assert.rejects(() => client.chat({ prompt: "Hello", model: "opus-55" }), /Unknown model "opus-55".*Did you mean albuquerque-quinn \(Opus 5\.5\)/);
  await assert.rejects(() => client.startChat({ prompt: "Hello", model: "no-such-model" }), /Unknown model "no-such-model"/);
  assert.equal(fake.inference.length, 0);
  assert.equal(client.listChatJobs().length, 0);
});

test("chat sends the typed names with a warning when getAvailableModels fails, and uses a stale list when it has one", async () => {
  const failing = catalogFake({ modelsStatus: () => 500 });
  const client = new NotionClient(catalogConfig, failing.fetchImpl as typeof fetch);
  const unchecked = await client.chat({ prompt: "Hello", model: "Opus 5.5", reasoningEffort: "High" });
  assert.equal(unchecked.model, "Opus 5.5");
  assert.equal(unchecked.reasoningEffort, "high");
  assert.equal(unchecked.modelName, undefined);
  assert.deepEqual(unchecked.warnings, [
    "getAvailableModels failed (getAvailableModels returned HTTP 500: catalog unavailable), so model Opus 5.5 and reasoningEffort high were sent without validation."
  ]);
  assert.equal(configStep(failing.inference[0]).model, "Opus 5.5");
  assert.equal(configStep(failing.inference[0]).reasoningEffort, "high");

  // With a zero TTL every turn fetches again; after one good fetch a failure falls back to that list.
  const flaky = catalogFake({ modelsStatus: (call) => (call === 1 ? 200 : 503) });
  const staleClient = new NotionClient({ ...catalogConfig, modelCatalog: { enabled: true, ttlMs: 0, allowUnlisted: false } }, flaky.fetchImpl as typeof fetch);
  const warm = await staleClient.chat({ prompt: "Warm", model: "gpt-5.4" });
  assert.equal(warm.warnings, undefined);
  const checked = await staleClient.chat({ prompt: "Stale", model: "Opus 5.5" });
  assert.equal(checked.model, "albuquerque-quinn-v2");
  assert.equal(checked.reasoningEffort, "medium");
  assert.match(checked.warnings?.[0] ?? "", /^getAvailableModels failed \(getAvailableModels returned HTTP 503: catalog unavailable\); the model was checked against the list fetched at \d{4}-\d{2}-\d{2}T/);
  await assert.rejects(() => staleClient.chat({ prompt: "Stale", model: "gpt-5.4", reasoningEffort: "low" }), /does not support reasoningEffort "low"/);
  assert.equal(flaky.catalogRequests.length, 3);
  assert.equal(flaky.inference.length, 2);
});

test("listModels shows the live list of a workspace and reuses the cached copy until refresh", async () => {
  const fake = catalogFake();
  const client = new NotionClient(catalogConfig, fake.fetchImpl as typeof fetch);
  const otherSpace = "23000000-0000-4000-8000-000000000001";
  const listing = await client.listModels({ spaceId: otherSpace });
  assert.deepEqual(fake.catalogRequests, [{ body: { spaceId: otherSpace }, spaceHeader: otherSpace }]);
  assert.equal(listing.spaceId, otherSpace);
  assert.equal(listing.source, "live");
  assert.equal(listing.modelCount, 5);
  assert.equal(listing.chatModelCount, 4);
  const opus = listing.models.find((entry) => entry.model === "albuquerque-quinn");
  assert.deepEqual(opus?.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(opus?.defaultReasoningEffort, "medium");
  assert.equal(opus?.finalModelName, "albuquerque-quinn-v2");
  assert.equal(opus?.chat, "available");
  assert.equal(opus?.agentService, "available");
  assert.equal(listing.models.find((entry) => entry.model === "orlando-quinn")?.chat, "disabled (restricted_access, credit_limit_reached)");
  assert.deepEqual(listing.models.find((entry) => entry.model === "xinomavro-cake")?.reasoningEfforts, []);
  assert.deepEqual(listing.defaultModel, { configured: "almond-croissant-low", model: "almond-croissant-low", name: "Sonnet 4.6", reasoningEffort: "low" });
  assert.deepEqual(listing.tiers.standard, { model: "almond-croissant-low", name: "Sonnet 4.6", reasoningEffort: "high" });
  assert.equal(listing.tiers.thinking?.model, "albuquerque-quinn-v2");
  assert.match(listing.tiers.thinking?.warnings?.join(" ") ?? "", /Tier "thinking" normally means oatmeal-cookie/);

  assert.equal((await client.listModels({ spaceId: otherSpace })).source, "cache");
  assert.equal(fake.catalogRequests.length, 1);
  assert.equal((await client.listModels({ spaceId: otherSpace, refresh: true })).source, "live");
  assert.equal(fake.catalogRequests.length, 2);

  // Listing only reads, so it works with NOTION_MODEL_CATALOG off, and it flags a default the list lacks.
  const legacy = new NotionClient(config, fake.fetchImpl as typeof fetch);
  const current = await legacy.listModels();
  assert.equal(current.spaceId, account.spaceId);
  assert.deepEqual(fake.catalogRequests.at(-1), { body: { spaceId: account.spaceId }, spaceHeader: account.spaceId });
  assert.match(current.defaultModel.error ?? "", /Unknown model "test-model"/);
});

test("without the live list a conversation keeps its model and carries its effort only with that model", async () => {
  const inference: Array<Record<string, unknown>> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    if (endpoint !== "runInferenceTranscript") throw new Error(`unexpected ${endpoint}`);
    inference.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return ndjsonResponse([
      { type: "agent-inference", id: "step", value: [{ type: "text", content: "Answer" }], finishedAt: Date.now(), inputTokens: 1, outputTokens: 1 }
    ]);
  };
  const client = new NotionClient(config, fakeFetch as typeof fetch);
  const first = await client.chat({ prompt: "First", model: "oval-kumquat-medium", reasoningEffort: "High" });
  assert.equal(first.model, "oval-kumquat-medium");
  assert.equal(first.reasoningEffort, "high");
  assert.equal(first.warnings, undefined);

  const second = await client.chat({ prompt: "Second", conversationId: first.conversationId });
  assert.equal(second.model, "oval-kumquat-medium");
  assert.equal(second.reasoningEffort, "high");
  assert.equal(configStep(inference[1]).model, "oval-kumquat-medium");
  assert.equal(configStep(inference[1]).reasoningEffort, "high");

  // Nothing says whether "high" suits another model, so a switch drops it.
  const third = await client.chat({ prompt: "Third", model: "fast", conversationId: first.conversationId });
  assert.equal(third.model, "almond-croissant-low");
  assert.equal(third.reasoningEffort, undefined);
  assert.equal(configStep(inference[2]).reasoningEffort, undefined);

  const fourth = await client.chat({ prompt: "Fourth", reasoningEffort: "max", conversationId: first.conversationId });
  assert.equal(fourth.model, "almond-croissant-low");
  assert.equal(fourth.reasoningEffort, "max");
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


test("explicitly disabling live model validation sends typed names with a warning", async () => {
  const fake = catalogFake();
  const client = new NotionClient({ ...catalogConfig, modelCatalog: { enabled: false, ttlMs: 300_000, allowUnlisted: false } }, fake.fetchImpl as typeof fetch);
  const answer = await client.chat({ prompt: "Hello", model: "Opus 5.5", reasoningEffort: "ultra" });
  assert.equal(answer.model, "Opus 5.5");
  assert.equal(answer.reasoningEffort, "ultra");
  assert.deepEqual(answer.warnings, ["Live model validation is disabled (NOTION_MODEL_CATALOG=0); model and reasoningEffort are sent without validation."]);
  assert.equal(fake.catalogRequests.length, 0);
  assert.equal(configStep(fake.inference[0]).model, "Opus 5.5");
});
