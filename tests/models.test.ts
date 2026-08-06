import assert from "node:assert/strict";
import test from "node:test";
import { listModels, normalizeKey, normalizeModelName } from "../src/models.js";

test("friendly names map to internal model IDs", () => {
  assert.equal(normalizeModelName("fast", "almond-croissant-low"), "almond-croissant-low");
  assert.equal(normalizeModelName("Thinking", "almond-croissant-low"), "oatmeal-cookie");
  assert.equal(normalizeModelName("notion_thinking", "almond-croissant-low"), "oatmeal-cookie");
});

test("unknown model values pass through and blanks fall back", () => {
  assert.equal(normalizeModelName("custom-model-id", "almond-croissant-low"), "custom-model-id");
  assert.equal(normalizeModelName(undefined, "oatmeal-cookie"), "oatmeal-cookie");
  assert.equal(normalizeModelName("   ", "fast"), "almond-croissant-low");
});

test("NOTION_MODEL_ALIASES overrides the builtin table", () => {
  process.env.NOTION_MODEL_ALIASES = JSON.stringify({ Fast: "custom-id" });
  try { assert.equal(normalizeModelName("fast", "almond-croissant-low"), "custom-id"); }
  finally { delete process.env.NOTION_MODEL_ALIASES; }
});

test("listModels groups aliases per model", () => {
  const thinking = listModels().find((entry) => entry.modelId === "oatmeal-cookie");
  assert.ok(thinking);
  assert.ok(thinking.aliases.includes("thinking"));
  assert.equal(normalizeKey(" Deep Think "), "deep-think");
});
