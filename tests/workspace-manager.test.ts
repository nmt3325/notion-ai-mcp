import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSpaceScopedId, WorkspaceManager } from "../src/workspace-manager.js";
import type { AccountContext } from "../src/types.js";

const SPACE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SPACE_B = "bbbbbbbb-0000-0000-0000-000000000002";
const BASE = "https://example.invalid/api/v3";

function makeAccount(): AccountContext {
  return {
    tokenV2: "token", userId: "user-1", userName: "tester", userEmail: "tester@example.invalid",
    spaceId: SPACE_A, spaceViewId: "sv-a", spaceName: "Alpha Space",
    timezone: "Asia/Tokyo", clientVersion: "23.13.0", browserId: "browser-1", deviceId: "device-1",
    fullCookie: "token_v2=token; notion_user_id=user-1",
  } as unknown as AccountContext;
}

function makeFetch(calls: string[], options: { probeOk?: boolean } = {}) {
  let createdViewId = "";
  const userContent = () => ({
    recordMap: {
      user_root: { "user-1": { value: {
        space_views: ["sv-a", "sv-b", ...(createdViewId ? [createdViewId] : [])],
        space_view_pointers: [
          { id: "sv-a", table: "space_view", spaceId: SPACE_A },
          { id: "sv-b", table: "space_view", spaceId: SPACE_B },
          ...(createdViewId ? [{ id: createdViewId, table: "space_view", spaceId: SPACE_B }] : [])
        ]
      } } },
      space: {
        [SPACE_A]: { value: { id: SPACE_A, name: "Alpha Space", plan_type: "personal" } },
        [SPACE_B]: { value: { id: SPACE_B, name: "Beta Workspace", plan_type: "personal" } },
      },
    },
  });
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const endpoint = url.slice(BASE.length);
    calls.push(endpoint);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/loadUserContent")) return new Response(JSON.stringify(userContent()), { status: 200 });
    if (url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (url.endsWith("/saveTransactionsFanout")) {
      const transactions = body.transactions as Array<Record<string, unknown>>;
      const operations = transactions[0]?.operations as Array<Record<string, unknown>>;
      const setOperation = operations.find((operation) => (operation.pointer as Record<string, unknown>)?.table === "space_view");
      createdViewId = String((setOperation?.pointer as Record<string, unknown>)?.id ?? "");
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/syncRecordValuesMain")) {
      const requests = body.requests as Array<Record<string, unknown>>;
      const pointer = requests[0]?.pointer as Record<string, unknown>;
      const viewId = String(pointer?.id ?? "");
      return new Response(JSON.stringify({ recordMap: { space_view: {
        [viewId]: { value: { id: viewId, version: 1, space_id: SPACE_B, parent_id: "user-1", parent_table: "user_root", alive: true, joined: true } }
      } } }), { status: 200 });
    }
    if (url.endsWith("/getInferenceTranscriptsForUser")) return new Response("{}", { status: options.probeOk === false ? 403 : 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeManager(options: { probeOk?: boolean } = {}) {
  const calls: string[] = [];
  const account = makeAccount();
  return { calls, account, manager: new WorkspaceManager(account, BASE, makeFetch(calls, options)) };
}

test("listWorkspaces flags current, exhausted and pinned workspaces", async () => {
  const { manager } = makeManager();
  manager.pin(SPACE_B);
  const all = await manager.listWorkspaces();
  assert.equal(all.length, 2);
  const alpha = all.find((ws) => ws.spaceId === SPACE_A);
  const beta = all.find((ws) => ws.spaceId === SPACE_B);
  assert.ok(alpha && beta);
  assert.deepEqual([alpha.current, alpha.exhausted, alpha.pinned], [true, false, false]);
  assert.deepEqual([beta.current, beta.exhausted, beta.pinned], [false, false, true]);
  assert.equal(manager.pinnedWorkspace(), SPACE_B);
  manager.pin("   ");
  assert.equal(manager.pinnedWorkspace(), null);
});

test("switchWorkspace matches by id, dashless id and partial name", async () => {
  for (const selector of [SPACE_B, SPACE_B.replaceAll("-", "").toUpperCase(), "Beta Workspace", "beta"]) {
    const { manager, account } = makeManager();
    const target = await manager.switchWorkspace(selector);
    assert.equal(target.spaceId, SPACE_B, `selector ${selector}`);
    assert.equal(account.spaceId, SPACE_B);
    assert.equal(account.spaceViewId, "sv-b");
    assert.equal(manager.getCurrent().spaceName, "Beta Workspace");
  }
});

test("switchWorkspace rejects blank, unknown and inactivatable workspaces", async () => {
  const { manager } = makeManager();
  await assert.rejects(() => manager.switchWorkspace("  "), /requires a workspace id or name/);
  await assert.rejects(() => manager.switchWorkspace("gamma"), /was not found for this account/);
  const blocked = makeManager({ probeOk: false });
  await assert.rejects(() => blocked.manager.switchWorkspace("beta"), /could not be activated/);
});

test("createAndSwitchWorkspace creates, activates and optionally pins", async () => {
  const { manager, calls, account } = makeManager();
  const created = await manager.createAndSwitchWorkspace("scratch", { pin: true });
  assert.equal(created.spaceId, SPACE_B);
  assert.match(created.spaceViewId, /^[0-9a-f-]{36}$/);
  assert.equal(account.spaceId, SPACE_B);
  assert.equal(account.spaceViewId, created.spaceViewId);
  assert.equal(manager.pinnedWorkspace(), SPACE_B);
  assert.ok(calls.includes("/createSpace"));
  assert.ok(calls.includes("/getInferenceTranscriptsForUser"));
});

test("restorePinnedWorkspace is a no-op when the pin is already current", async () => {
  const { manager } = makeManager();
  assert.equal(await manager.restorePinnedWorkspace(), false);
  manager.pin(SPACE_A);
  assert.equal(await manager.restorePinnedWorkspace(), false);
  manager.pin(SPACE_B);
  assert.equal(await manager.restorePinnedWorkspace(), true);
  assert.equal(manager.getCurrent().spaceId, SPACE_B);
});

test("markCurrentExhausted marks the active workspace as used up", async () => {
  const { manager } = makeManager();
  await manager.switchWorkspace("beta");
  manager.markCurrentExhausted();
  const all = await manager.listWorkspaces();
  assert.equal(all.find((ws) => ws.spaceId === SPACE_A)?.exhausted, false);
  assert.equal(all.find((ws) => ws.spaceId === SPACE_B)?.exhausted, true);
});

test("rotate skips the exhausted current workspace without pre-marking its target", async () => {
  const { manager } = makeManager();
  manager.markCurrentExhausted();
  assert.equal(await manager.rotate(), true);
  const all = await manager.listWorkspaces();
  assert.equal(all.find((ws) => ws.spaceId === SPACE_A)?.exhausted, true);
  assert.equal(all.find((ws) => ws.spaceId === SPACE_B)?.exhausted, false);
  assert.equal(manager.getCurrent().spaceId, SPACE_B);
});

test("account persistence retains credentials, unknown fields and the pinned workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notion-ai-mcp-workspace-"));
  const accountPath = join(dir, "account.json");
  try {
    writeFileSync(accountPath, JSON.stringify({ unknown_marker: "keep-me", full_cookie: "stale" }), { mode: 0o644 });
    const calls: string[] = [];
    const account = makeAccount();
    account.pinnedSpaceId = SPACE_A;
    const manager = new WorkspaceManager(account, BASE, makeFetch(calls), accountPath);
    assert.equal(manager.pinnedWorkspace(), SPACE_A);

    manager.pin(SPACE_B);
    await manager.switchWorkspace("beta");
    const persisted = JSON.parse(readFileSync(accountPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.unknown_marker, "keep-me");
    assert.equal(persisted.token_v2, "token");
    assert.equal(persisted.full_cookie, account.fullCookie);
    assert.equal(persisted.browser_id, "browser-1");
    assert.equal(persisted.device_id, "device-1");
    assert.equal(persisted.space_id, SPACE_B);
    assert.equal(persisted.space_view_id, "sv-b");
    assert.equal(persisted.pinned_space_id, SPACE_B);
    assert.equal(statSync(accountPath).mode & 0o777, 0o600);

    manager.pin(null);
    const unpinned = JSON.parse(readFileSync(accountPath, "utf8")) as Record<string, unknown>;
    assert.equal("pinned_space_id" in unpinned, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("workspace creation uses the official body and commits a discoverable space_view", async () => {
  const account = makeAccount();
  const requests: Array<{ endpoint: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let createdViewId = "";
  let committed = false;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ endpoint, body, headers });
    if (endpoint === "createSpace") return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (endpoint === "saveTransactionsFanout") {
      const transactions = body.transactions as Array<Record<string, unknown>>;
      const operations = transactions[0]?.operations as Array<Record<string, unknown>>;
      const setOperation = operations.find((operation) => (operation.pointer as Record<string, unknown>)?.table === "space_view");
      createdViewId = String((setOperation?.pointer as Record<string, unknown>)?.id ?? "");
      committed = true;
      return new Response("{}", { status: 200 });
    }
    if (endpoint === "loadUserContent") {
      return new Response(JSON.stringify({ recordMap: {
        user_root: { "user-1": { value: {
          space_views: ["sv-a", ...(committed ? [createdViewId] : [])],
          space_view_pointers: [
            { id: "sv-a", table: "space_view", spaceId: SPACE_A },
            ...(committed ? [{ id: createdViewId, table: "space_view", spaceId: SPACE_B }] : [])
          ]
        } } },
        space: {
          [SPACE_A]: { value: { id: SPACE_A, name: "Alpha Space", plan_type: "personal" } },
          [SPACE_B]: { value: { id: SPACE_B, name: "Scratch Space", plan_type: "personal", created_time: 123 } }
        }
      } }), { status: 200 });
    }
    if (endpoint === "syncRecordValuesMain") {
      return new Response(JSON.stringify({ recordMap: { space_view: {
        [createdViewId]: { value: { id: createdViewId, version: 1, space_id: SPACE_B, parent_id: "user-1", parent_table: "user_root", alive: true, joined: true } }
      } } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(account, BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 2, discoveryDelayMs: 0 });
  const created = await manager.createWorkspace("Scratch Space");
  assert.equal(created.spaceId, SPACE_B);
  assert.equal(created.spaceViewId, createdViewId);
  assert.ok(createdViewId);
  const compactViewId = createdViewId.replaceAll("-", "");
  assert.equal(compactViewId.slice(3, 12), SPACE_B.replaceAll("-", "").slice(3, 12));
  assert.equal(compactViewId[12], "8");

  const createRequest = requests.find((request) => request.endpoint === "createSpace");
  assert.deepEqual(createRequest?.body, {
    name: "Scratch Space",
    planType: "personal",
    planSelection: "personal",
    initialPersona: "other",
    deviceId: "device-1",
    deviceType: "web-desktop",
    source: "sidebar_switcher"
  });
  const saveRequest = requests.find((request) => request.endpoint === "saveTransactionsFanout");
  const transaction = (saveRequest?.body.transactions as Array<Record<string, unknown>>)[0];
  const operations = transaction.operations as Array<Record<string, unknown>>;
  assert.equal(transaction.spaceId, SPACE_B);
  assert.equal(saveRequest?.headers["x-notion-space-id"], SPACE_A);
  assert.equal(operations.length, 3);
  assert.deepEqual(operations.map((operation) => operation.command), ["set", "listAfter", "keyedObjectListAfter"]);
  const setArgs = operations[0]?.args as Record<string, unknown>;
  assert.equal(setArgs.space_id, SPACE_B);
  assert.equal(setArgs.parent_id, "user-1");
  assert.equal(setArgs.parent_table, "user_root");
  assert.equal(setArgs.alive, true);
  assert.deepEqual(operations[2]?.args, { value: { table: "space_view", id: createdViewId, spaceId: SPACE_B } });
});

test("workspace creation refuses success without a discoverable space_view", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    calls.push(endpoint);
    if (endpoint === "createSpace") return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (endpoint === "saveTransactionsFanout") return new Response("{}", { status: 200 });
    if (endpoint === "loadUserContent") return new Response(JSON.stringify({ recordMap: {
      user_root: { "user-1": { value: { space_view_pointers: [{ id: "sv-a", spaceId: SPACE_A }] } } },
      space: { [SPACE_A]: { value: { name: "Alpha Space", plan_type: "personal" } } }
    } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(makeAccount(), BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 2, discoveryDelayMs: 0 });
  await assert.rejects(() => manager.createWorkspace("Missing View"), /space_view .* was not fully discoverable/);
  assert.equal(calls.filter((endpoint) => endpoint === "createSpace").length, 1);
  assert.equal(calls.filter((endpoint) => endpoint === "saveTransactionsFanout").length, 1);
  assert.equal(calls.filter((endpoint) => endpoint === "loadUserContent").length, 2);
});


test("workspace creation rejects a pointer-only partial commit", async () => {
  let createdViewId = "";
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    calls.push(endpoint);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (endpoint === "createSpace") return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (endpoint === "saveTransactionsFanout") {
      const transaction = (body.transactions as Array<Record<string, unknown>>)[0];
      const operations = transaction.operations as Array<Record<string, unknown>>;
      createdViewId = String((operations[0]?.pointer as Record<string, unknown>)?.id ?? "");
      return new Response("{}", { status: 200 });
    }
    if (endpoint === "loadUserContent") return new Response(JSON.stringify({ recordMap: {
      user_root: { "user-1": { value: {
        space_views: [createdViewId],
        space_view_pointers: [{ id: createdViewId, table: "space_view", spaceId: SPACE_B }]
      } } },
      space: { [SPACE_B]: { value: { id: SPACE_B, name: "Pointer Only", plan_type: "personal" } } }
    } }), { status: 200 });
    if (endpoint === "syncRecordValuesMain") return new Response(JSON.stringify({ recordMap: { space_view: {} } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(makeAccount(), BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 2, discoveryDelayMs: 0 });
  await assert.rejects(() => manager.createWorkspace("Pointer Only"), /root pointer was visible but the space_view record was missing or invalid/);
  assert.equal(calls.filter((endpoint) => endpoint === "createSpace").length, 1);
  assert.equal(calls.filter((endpoint) => endpoint === "saveTransactionsFanout").length, 1);
  assert.equal(calls.filter((endpoint) => endpoint === "syncRecordValuesMain").length, 2);
});

test("workspace creation waits for both pointer and record visibility", async () => {
  let createdViewId = "";
  let loadCount = 0;
  let recordCount = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (endpoint === "createSpace") return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (endpoint === "saveTransactionsFanout") {
      const transaction = (body.transactions as Array<Record<string, unknown>>)[0];
      const operations = transaction.operations as Array<Record<string, unknown>>;
      createdViewId = String((operations[0]?.pointer as Record<string, unknown>)?.id ?? "");
      return new Response("{}", { status: 200 });
    }
    if (endpoint === "loadUserContent") {
      loadCount += 1;
      const visible = loadCount >= 2;
      return new Response(JSON.stringify({ recordMap: {
        user_root: { "user-1": { value: {
          space_views: visible ? [createdViewId] : [],
          space_view_pointers: visible ? [{ id: createdViewId, table: "space_view", spaceId: SPACE_B }] : []
        } } },
        space: { [SPACE_B]: { value: { id: SPACE_B, name: "Delayed", plan_type: "personal" } } }
      } }), { status: 200 });
    }
    if (endpoint === "syncRecordValuesMain") {
      recordCount += 1;
      const visible = recordCount >= 2;
      return new Response(JSON.stringify({ recordMap: { space_view: visible ? {
        [createdViewId]: { value: { id: createdViewId, version: 1, space_id: SPACE_B, parent_id: "user-1", parent_table: "user_root", alive: true, joined: true } }
      } : {} } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(makeAccount(), BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 3, discoveryDelayMs: 0 });
  const created = await manager.createWorkspace("Delayed");
  assert.equal(created.spaceViewId, createdViewId);
  assert.equal(loadCount, 3);
  assert.equal(recordCount, 2);
});

test("workspace creation reports Retry-After and never retries createSpace", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    calls.push(endpoint);
    if (endpoint === "createSpace") return new Response('{"name":"TooManyRequestsError"}', { status: 429, headers: { "retry-after": "60" } });
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(makeAccount(), BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 2, discoveryDelayMs: 0 });
  await assert.rejects(() => manager.createWorkspace("Rate Limited"), /HTTP 429\. Retry-After: 60\./);
  assert.deepEqual(calls, ["createSpace"]);
});

test("workspace transaction failures are not retried", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const endpoint = String(input).split("/").at(-1) ?? "";
    calls.push(endpoint);
    if (endpoint === "createSpace") return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
    if (endpoint === "saveTransactionsFanout") return new Response("Bad gateway", { status: 502 });
    return new Response("{}", { status: 404 });
  };
  const manager = new WorkspaceManager(makeAccount(), BASE, fakeFetch as typeof fetch, undefined, { discoveryAttempts: 2, discoveryDelayMs: 0 });
  await assert.rejects(() => manager.createWorkspace("Broken Cell"), /transaction failed and was not retried: saveTransactionsFanout returned HTTP 502/);
  assert.equal(calls.filter((endpoint) => endpoint === "createSpace").length, 1);
  assert.equal(calls.filter((endpoint) => endpoint === "saveTransactionsFanout").length, 1);
  assert.equal(calls.includes("loadUserContent"), false);
});

test("space-scoped IDs preserve the workspace short ID", () => {
  const id = createSpaceScopedId(SPACE_B);
  const compact = id.replaceAll("-", "");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(compact.slice(3, 12), SPACE_B.replaceAll("-", "").slice(3, 12));
});
