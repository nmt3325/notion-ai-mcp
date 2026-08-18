import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const KEYS = [
  "NOTION_TOKEN_V2",
  "NOTION_ACCOUNT_FILE",
  "NOTION_MAX_WORKSPACE_RETRIES",
  "NOTION_DEFAULT_WEB_SEARCH",
  "NOTION_DEFAULT_WORKSPACE_SEARCH",
  "NOTION_DEFAULT_READ_ONLY"
] as const;

function withCleanConfigEnvironment(run: () => void): void {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    process.env.NOTION_TOKEN_V2 = "test-token";
    run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadConfig defaults Ask/read-only mode to false", () => {
  withCleanConfigEnvironment(() => {
    assert.equal(loadConfig().defaultReadOnly, false);
  });
});

test("loadConfig can explicitly enable Ask/read-only mode", () => {
  withCleanConfigEnvironment(() => {
    process.env.NOTION_DEFAULT_READ_ONLY = "1";
    assert.equal(loadConfig().defaultReadOnly, true);
  });
});

test("loadConfig accepts zero workspace retries", () => {
  withCleanConfigEnvironment(() => {
    process.env.NOTION_MAX_WORKSPACE_RETRIES = "0";
    assert.equal(loadConfig().maxWorkspaceRetries, 0);
  });
});

test("loadConfig rejects invalid workspace retry counts", () => {
  withCleanConfigEnvironment(() => {
    for (const value of ["-1", "1.5", "NaN", String(Number.MAX_SAFE_INTEGER + 1)]) {
      process.env.NOTION_MAX_WORKSPACE_RETRIES = value;
      assert.throws(() => loadConfig(), /non-negative safe integer/);
    }
  });
});

test("loadConfig tolerates an account file that has not been created yet", () => {
  withCleanConfigEnvironment(() => {
    const dir = mkdtempSync(join(tmpdir(), "notion-account-"));
    try {
      const path = join(dir, "account.json");
      process.env.NOTION_ACCOUNT_FILE = path;
      const config = loadConfig();
      assert.equal(config.accountFilePath, path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("loadConfig still rejects an account file it cannot parse", () => {
  withCleanConfigEnvironment(() => {
    const dir = mkdtempSync(join(tmpdir(), "notion-account-"));
    try {
      const path = join(dir, "account.json");
      writeFileSync(path, "{ not json");
      process.env.NOTION_ACCOUNT_FILE = path;
      assert.throws(() => loadConfig(), /Cannot read NOTION_ACCOUNT_FILE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
