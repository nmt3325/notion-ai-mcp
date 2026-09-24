import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadMatrixConfig } from "../src/matrix-config.js";

test("Matrix config supports access-token auth, E2EE, allowlists, and Notion overrides", () => {
  const config = loadMatrixConfig({
    MATRIX_BASE_URL: "https://matrix.example.com/",
    MATRIX_ACCESS_TOKEN: "matrix-token",
    MATRIX_USER_ID: "@bot:example.com",
    MATRIX_DEVICE_ID: "NOTIONBOT",
    MATRIX_RECOVERY_KEY: "recovery-key",
    MATRIX_STATE_FILE: "./tmp/matrix-state.json",
    MATRIX_BOT_USERNAME: "notion-bot",
    MATRIX_ROOM_ALLOWLIST: "!one:example.com, !two:example.com",
    MATRIX_INVITE_AUTOJOIN_ALLOWLIST: "@alice:example.com",
    MATRIX_NOTION_MODEL: "test-model",
    MATRIX_NOTION_REASONING_EFFORT: "high",
    MATRIX_NOTION_WEB_SEARCH: "0",
    MATRIX_NOTION_WORKSPACE_SEARCH: "1",
    MATRIX_NOTION_READ_ONLY: "true"
  });

  assert.equal(config.adapter.baseURL, "https://matrix.example.com");
  assert.deepEqual(config.adapter.auth, {
    type: "accessToken",
    accessToken: "matrix-token",
    userID: "@bot:example.com"
  });
  assert.equal(config.adapter.deviceID, "NOTIONBOT");
  assert.equal(config.adapter.recoveryKey, "recovery-key");
  assert.equal(config.adapter.e2ee?.useIndexedDB, false);
  assert.deepEqual(config.adapter.roomAllowlist, ["!one:example.com", "!two:example.com"]);
  assert.deepEqual(config.adapter.inviteAutoJoin, { inviterAllowlist: ["@alice:example.com"] });
  assert.equal(config.stateFilePath, resolve("./tmp/matrix-state.json"));
  assert.equal(config.botUserName, "notion-bot");
  assert.deepEqual(config.bridge, {
    pollIntervalMs: 3_000,
    responseTimeoutMs: 30 * 60_000,
    maxMessageChars: 12_000,
    model: "test-model",
    reasoningEffort: "high",
    webSearch: false,
    workspaceSearch: true,
    readOnly: true
  });
});

test("Matrix config supports password auth without enabling invitation auto-join", () => {
  const config = loadMatrixConfig({
    MATRIX_BASE_URL: "https://matrix.example.com",
    MATRIX_USERNAME: "notion-bot",
    MATRIX_PASSWORD: "password"
  });
  assert.equal(config.adapter.auth.type, "password");
  assert.equal(config.adapter.inviteAutoJoin, undefined);
  assert.equal(config.adapter.recoveryKey, undefined);
});

test("Matrix config validates authentication, URL, booleans, and numeric bounds", () => {
  assert.throws(
    () => loadMatrixConfig({ MATRIX_BASE_URL: "https://matrix.example.com" }),
    /MATRIX_ACCESS_TOKEN/
  );
  assert.throws(
    () => loadMatrixConfig({ MATRIX_BASE_URL: "not a URL", MATRIX_ACCESS_TOKEN: "x" }),
    /valid absolute URL/
  );
  assert.throws(
    () => loadMatrixConfig({
      MATRIX_BASE_URL: "https://matrix.example.com",
      MATRIX_ACCESS_TOKEN: "x",
      MATRIX_INVITE_AUTOJOIN: "maybe"
    }),
    /MATRIX_INVITE_AUTOJOIN/
  );
  assert.throws(
    () => loadMatrixConfig({
      MATRIX_BASE_URL: "https://matrix.example.com",
      MATRIX_ACCESS_TOKEN: "x",
      MATRIX_RESPONSE_TIMEOUT_MS: "10"
    }),
    /safe integer/
  );
});
