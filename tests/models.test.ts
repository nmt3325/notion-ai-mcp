import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CATALOG, listModels, modelReasoningEfforts, normalizeKey, normalizeModelName, normalizeReasoningEffort } from "../src/models.js";

test("tier aliases map to internal model IDs", () => {
  assert.equal(normalizeModelName("fast", "almond-croissant-low"), "almond-croissant-low");
  assert.equal(normalizeModelName("Thinking", "almond-croissant-low"), "oatmeal-cookie");
  assert.equal(normalizeModelName("notion_thinking", "almond-croissant-low"), "oatmeal-cookie");
});

test("vendor names from the Notion model registry resolve to internal IDs", () => {
  assert.equal(normalizeModelName("GPT 5.2", "almond-croissant-low"), "oatmeal-cookie");
  assert.equal(normalizeModelName("gpt-5.4-high", "almond-croissant-low"), "oval-kumquat-high");
  assert.equal(normalizeModelName("gpt-5.4", "almond-croissant-low"), "oval-kumquat-medium");
  assert.equal(normalizeModelName("opus-4.6", "almond-croissant-low"), "avocado-froyo-medium");
  assert.equal(normalizeModelName("sonnet-4.6", "oatmeal-cookie"), "almond-croissant-low");
  assert.equal(normalizeModelName("Sonnet 4.6 (Low)", "oatmeal-cookie"), "almond-croissant-low");
  assert.equal(normalizeModelName("Claude Opus 4.5", "oatmeal-cookie"), "apple-danish");
  assert.equal(normalizeModelName("Gemini 3.5 Flash", "oatmeal-cookie"), "vertex-gemini-3.5-flash");
  assert.ok(MODEL_CATALOG.length >= 50, "catalog should carry the production-callable registry");
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
  assert.equal(thinking.displayName, "GPT 5.2");
  assert.equal(normalizeKey(" Deep Think "), "deep-think");
  assert.equal(listModels().find((entry) => entry.modelId === "openai-gpt-4o-mini")?.pickable, false);
  assert.equal(listModels().find((entry) => entry.modelId === "anthropic-haiku-4.5")?.pickable, false);
});

test("reasoning efforts follow the Notion model registry", () => {
  assert.deepEqual(modelReasoningEfforts("oatmeal-cookie"), { supported: ["medium", "high"], default: "medium" });
  assert.deepEqual(modelReasoningEfforts("oval-kumquat-high"), { supported: ["medium", "high"], default: "high" });
  assert.deepEqual(modelReasoningEfforts("almond-croissant-low"), { supported: ["low", "medium", "high", "max"], default: "low" });
  assert.deepEqual(modelReasoningEfforts("olive-jellyroll")?.supported, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelReasoningEfforts("vertex-gemini-3.5-flash"), { supported: ["low", "medium", "high"], default: "low" });
  assert.equal(modelReasoningEfforts("apple-danish"), undefined);
});

test("reasoning effort aliases resolve and unsupported values are rejected", () => {
  assert.equal(normalizeReasoningEffort("oatmeal-cookie", "High"), "high");
  assert.equal(normalizeReasoningEffort("olive-jellyroll", " X-High "), "xhigh");
  assert.equal(normalizeReasoningEffort("olive-jellyroll", "no thinking"), "none");
  assert.equal(normalizeReasoningEffort("almond-croissant-low", "maximum"), "max");
  assert.equal(normalizeReasoningEffort("oatmeal-cookie", undefined), undefined);
  assert.equal(normalizeReasoningEffort("oatmeal-cookie", "   "), undefined);
  assert.equal(normalizeReasoningEffort("brand-new-model", "high"), "high");
  assert.throws(() => normalizeReasoningEffort("oatmeal-cookie", "turbo"), /Unknown reasoningEffort "turbo"/);
  assert.throws(() => normalizeReasoningEffort("oval-kumquat-medium", "low"), /does not support reasoningEffort "low". Supported: medium, high \(default medium\)/);
  assert.throws(() => normalizeReasoningEffort("apple-danish", "high"), /has no reasoningEffort picker/);
});
