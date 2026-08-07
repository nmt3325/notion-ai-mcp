import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceManager } from "../src/workspace-manager.js";
import type { AccountContext } from "../src/types.js";

const SPACE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SPACE_B = "bbbbbbbb-0000-0000-0000-000000000002";
const BASE = "https://example.invalid/api/v3";

function makeAccount(): AccountContext {
  return {
    tokenV2: "token", userId: "user-1", userName: "tester", userEmail: "tester@example.invalid",
    spaceId: SPACE_A, spaceViewId: "sv-a", spaceName: "Alpha Space",
    timezone: "Asia/Tokyo", clientVersion: "23.13.0", browserId: "browser-1", deviceId: "device-1",
  } as unknown as AccountContext;
}

function makeFetch(calls: string[], options: { probeOk?: boolean } = {}) {
  const userContent = {
    recordMap: {
      user_root: { "user-1": { value: { space_view_pointers: [
        { id: "sv-a", spaceId: SPACE_A },
        { id: "sv-b", spaceId: SPACE_B },
      ] } } },
      space: {
        [SPACE_A]: { value: { name: "Alpha Space", plan_type: "personal" } },
        [SPACE_B]: { value: { name: "Beta Workspace", plan_type: "personal" } },
      },
    },
  };
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url.slice(BASE.length));
    if (url.endsWith("/loadUserContent")) return new Response(JSON.stringify(userContent), { status: 200 });
    if (url.endsWith("/createSpace")) return new Response(JSON.stringify({ spaceId: SPACE_B }), { status: 200 });
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
  assert.deepEqual([alpha.current, alpha.exhausted, alpha.pinned], [true, true, false]);
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
  assert.equal(created.spaceViewId, "sv-b");
  assert.equal(account.spaceId, SPACE_B);
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
  assert.ok(all.every((ws) => ws.exhausted));
});
