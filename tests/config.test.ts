import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const KEYS = ["NOTION_TOKEN_V2", "NOTION_ACCOUNT_FILE", "NOTION_MAX_WORKSPACE_RETRIES"] as const;

function withCleanConfigEnvironment(run: () => void): void {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.NOTION_TOKEN_V2 = "test-token";
    delete process.env.NOTION_ACCOUNT_FILE;
    run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
