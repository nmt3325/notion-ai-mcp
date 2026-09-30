import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalEffort, describeCatalog, envAliases, formatModelListing, legacyPlan, lookupModel,
  matchEffort, ModelCatalogStore, modelAvailability, modelLabel, normalizeKey, parseAvailableModels,
  planModel, resolveReasoningEffort, splitEffortSuffix, suggestModels, surfaceFor,
  type CatalogModel, type LookupOptions, type ModelCatalog, type PlanOptions
} from "../src/models.js";

const SPACE = "22222222-2222-4222-8222-222222222222";
const FETCHED_AT = Date.UTC(2026, 8, 30, 1, 2, 3);
const options: LookupOptions = { transport: "inference_transcript", defaultModel: "almond-croissant-low" };
const planOptions: PlanOptions = { defaultModel: "almond-croissant-low" };
function entry(model: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model, modelMessage: name, modelFamily: "openai", modelProvider: "openai",
    displayGroup: "intelligent", workflow: { finalModelName: model }, ...extra
  };
}
const payload = {
  modelSelectionRestricted: true,
  restrictedGeoPolicyApplied: true,
  models: [
    entry("almond-croissant-low", "Sonnet 4.6", {
      modelFamily: "anthropic", modelProvider: "anthropic", displayGroup: "fast",
      modelConfiguration: { supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "low" },
      agentService: { finalModelName: "almond-croissant-low" }, customAgent: { finalModelName: "almond-croissant-low" },
      modelCardAttributes: { speed: 4, intelligence: 3, cost: 2, ignored: 100 }, billsNotionCredits: false
    }),
    entry("albuquerque-quinn", "Opus 5.5", {
      modelFamily: "anthropic", modelProvider: "anthropic",
      modelConfiguration: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      agentService: { finalModelName: "albuquerque-quinn" }, customAgent: { finalModelName: "albuquerque-quinn" },
      billsNotionCredits: true, supportsTokenSharing: true
    }),
    entry("oval-kumquat-medium", "GPT-5.4", {
      modelConfiguration: { supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
      agentService: { finalModelName: "oval-kumquat-medium" }
    }),
    entry("oatmeal-cookie", "GPT-5.2", {
      modelConfiguration: { supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }
    }),
    entry("baseten-deepseek-v4-pro", "DeepSeek V4 Pro", {
      modelFamily: "mystery", modelProvider: "baseten", restrictedForPersonalAgent: true,
      modelConfiguration: { supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "max", "xhigh"], defaultReasoningEffort: "high" }
    }),
    entry("xinomavro-cake", "Grok Build 0.1", {
      modelFamily: "xai", modelProvider: "xai", isApproachingRateLimit: true,
      workflow: { finalModelName: "xinomavro-cake", beta: true }
    }),
    entry("oregon-grape-medium", "GPT-5.4 Mini", {
      displayGroup: "fast", workflow: undefined, customAgent: { finalModelName: "oregon-grape-medium" }
    }),
    entry("orlando-quinn", "GPT-6 Astra", {
      isDisabled: true, disabledReason: "credit_limit_reached", restrictedAccessModelCodename: "astra-access",
      workflow: { finalModelName: "orlando-quinn", isDisabled: true, disabledReason: "restricted_access" },
      modelConfiguration: { supportedReasoningEfforts: ["medium", "high", "xhigh"], defaultReasoningEffort: "high" }
    }),
    entry("quince-tart", "Gemini 4 Pro", {
      modelFamily: "gemini", modelProvider: "vertex",
      modelConfiguration: { supportedReasoningEfforts: ["low", "high", "ultra"], defaultReasoningEffort: "high" },
      workflow: { finalModelName: "quince-tart-2026-09" }, agentService: { finalModelName: "quince-tart-agent" }
    }),
    entry("anthropic-haiku-4.5", "Haiku 4.5", {
      modelFamily: "anthropic", modelProvider: "anthropic", workflow: undefined,
      agentService: { finalModelName: "anthropic-haiku-4.5" }
    }),
    { modelMessage: "missing codename" },
    entry("almond-croissant-low", "duplicate must be ignored")
  ],
  restrictedAccessModelsInPickerConfig: [
    { codename: "assam-chai", modelMessage: "Assam Chai", modelFamily: "openai", billsNotionCredits: true },
    { modelMessage: "missing restricted codename" }
  ]
};
function catalog(): ModelCatalog { return parseAvailableModels(payload, SPACE, FETCHED_AT); }
function model(id: string, source = catalog()): CatalogModel {
  const found = source.models.find((value) => value.codename === id);
  assert.ok(found, `fixture model ${id}`);
  return found;
}

test("parseAvailableModels preserves live efforts, surfaces, restrictions and scores", () => {
  const value = catalog();
  assert.equal(value.models.length, 10);
  assert.equal(value.spaceId, SPACE);
  assert.equal(value.fetchedAt, FETCHED_AT);
  assert.equal(value.modelSelectionRestricted, true);
  assert.equal(value.restrictedGeoPolicyApplied, true);
  assert.deepEqual(value.restrictedAccessModels, [
    { codename: "assam-chai", name: "Assam Chai", family: "openai", billsNotionCredits: true }
  ]);
  const sonnet = model("almond-croissant-low", value);
  assert.equal(sonnet.name, "Sonnet 4.6");
  assert.deepEqual(sonnet.card, { speed: 4, intelligence: 3, cost: 2 });
  assert.equal(sonnet.billsNotionCredits, false);
  assert.deepEqual(sonnet.efforts, ["low", "medium", "high", "max"]);
  assert.equal(sonnet.defaultEffort, "low");
  assert.equal(model("albuquerque-quinn", value).supportsTokenSharing, true);
  assert.equal(model("orlando-quinn", value).restrictedAccessCodename, "astra-access");
  assert.equal(model("xinomavro-cake", value).surfaces.workflow?.beta, true);
});

test("partial and future entries are parsed without a builtin effort vocabulary", () => {
  const value = parseAvailableModels({ models: [
    null, [], { model: "  " },
    { model: " new-model ", modelFamily: "new-provider", workflow: {},
      modelConfiguration: { supportedReasoningEfforts: [" cosmic ", "cosmic", 42, "", "ultra"], defaultReasoningEffort: " cosmic " },
      modelCardAttributes: { speed: Infinity, intelligence: "high", cost: 0 },
      isDisabledOnlyByDisasterRecovery: true, restrictedForCustomAgent: true }
  ] }, SPACE, FETCHED_AT);
  const fresh = model("new-model", value);
  assert.equal(fresh.name, "new-model");
  assert.equal(fresh.provider, "new-provider");
  assert.deepEqual(fresh.efforts, ["cosmic", "ultra"]);
  assert.equal(fresh.defaultEffort, "cosmic");
  assert.deepEqual(fresh.card, { cost: 0 });
  assert.equal(fresh.disabledOnlyByDisasterRecovery, true);
  assert.equal(fresh.restrictedForCustomAgent, true);
  assert.deepEqual(fresh.surfaces.workflow, { finalModelName: "new-model" });
  assert.equal(planModel(value, { requestedModel: "new-model-ultra", transport: "inference_transcript" }, planOptions).reasoningEffort, "ultra");
});

test("invalid or empty API responses fail instead of manufacturing a catalog", () => {
  for (const value of [null, [], {}, { models: {} }]) {
    assert.throws(() => parseAvailableModels(value, SPACE), /did not return a models array/);
  }
  for (const value of [{ models: [] }, { models: [null, {}, { model: "" }] }]) {
    assert.throws(() => parseAvailableModels(value, SPACE), /returned no models/);
  }
});

test("model names resolve from live codenames, labels, providers and surface names", () => {
  const value = catalog();
  const cases = [
    ["albuquerque-quinn", "albuquerque-quinn", "codename"],
    [" Opus 5.5 ", "albuquerque-quinn", "name"],
    ["Claude Opus 5.5", "albuquerque-quinn", "name"],
    ["anthropic-opus_5.5", "albuquerque-quinn", "name"],
    ["openai-gpt-5.4", "oval-kumquat-medium", "name"],
    ["baseten-deepseek-v4-pro", "baseten-deepseek-v4-pro", "codename"],
    ["DeepSeek V4 Pro", "baseten-deepseek-v4-pro", "name"],
    ["google-gemini-4-pro", "quince-tart", "name"],
    ["quince-tart-2026-09", "quince-tart", "finalModelName"],
    ["quince-tart-agent", "quince-tart", "finalModelName"],
    ["almond-croissant", "almond-croissant-low", "codenameBase"],
    ["oval-kumquat", "oval-kumquat-medium", "codenameBase"]
  ] as const;
  for (const [input, codename, via] of cases) {
    const found = lookupModel(value, input, options);
    assert.equal(found.codename, codename, input);
    assert.equal(found.via, via, input);
  }
  assert.throws(() => lookupModel(value, "mystery-deepseek-v4-pro", options), /Unknown model/);
});

test("effort suffixes use the live vocabulary and do not manufacture model IDs", () => {
  const value = catalog();
  const cases = [
    ["opus-5.5-max", "albuquerque-quinn", "max"],
    ["Claude Opus 5.5 (X-High)", "albuquerque-quinn", "xhigh"],
    ["Sonnet 4.6 (High)", "almond-croissant-low", "high"],
    ["gpt-5.4-high", "oval-kumquat-medium", "high"],
    ["oval-kumquat-high", "oval-kumquat-medium", "high"],
    ["oatmeal-cookie-high-thinking", "oatmeal-cookie", "high"],
    ["gpt-5.2-thinking", "oatmeal-cookie", undefined],
    ["gemini-4-pro-ultra", "quince-tart", "ultra"]
  ] as const;
  for (const [input, codename, effort] of cases) {
    const found = lookupModel(value, input, options);
    assert.equal(found.codename, codename, input);
    assert.equal(found.impliedEffort, effort, input);
    assert.equal(found.via, "effortSuffix", input);
  }
  assert.equal(lookupModel(value, "almond-croissant-low", options).impliedEffort, undefined);
  assert.deepEqual(splitEffortSuffix("foo-x-high", ["x-high", "high"]), { base: "foo", effort: "xhigh" });
  assert.deepEqual(splitEffortSuffix("foo-no-thinking", ["no-thinking", "high"]), { base: "foo", effort: "none" });
  assert.equal(splitEffortSuffix("foo", ["high"]), undefined);
});

test("tiers are compatibility aliases validated against the workspace's live list", () => {
  const value = catalog();
  for (const [name, target, effort] of [
    ["fast", "almond-croissant-low", "low"],
    ["standard", "almond-croissant-low", "high"],
    ["balanced", "almond-croissant-low", "high"],
    ["thinking", "oatmeal-cookie", "medium"]
  ] as const) {
    const found = planModel(value, { requestedModel: name, transport: "inference_transcript" }, planOptions);
    assert.equal(found.model, target);
    assert.equal(found.reasoningEffort, effort);
    assert.deepEqual(found.warnings, []);
  }
  assert.equal(lookupModel(value, "default", { ...options, defaultModel: "Opus 5.5" }).codename, "albuquerque-quinn");
  assert.equal(lookupModel(value, "notion-default", { ...options, defaultModel: "default" }).codename, "almond-croissant-low");
  const withoutThinking = { ...value, models: value.models.filter((item) => item.codename !== "oatmeal-cookie") };
  const fallback = lookupModel(withoutThinking, "thinking", options);
  assert.equal(fallback.codename, "albuquerque-quinn");
  assert.deepEqual(fallback.warnings, [
    'Tier "thinking" normally means oatmeal-cookie, which this workspace does not offer for Notion AI chat; using Opus 5.5 (albuquerque-quinn) instead.'
  ]);
});

test("operator aliases override resolution, while unknown names require explicit opt-in", () => {
  const value = catalog();
  const aliased = lookupModel(value, "fast", { ...options, aliases: { fast: "Opus 5.5 (Max)" } });
  assert.equal(aliased.codename, "albuquerque-quinn");
  assert.equal(aliased.impliedEffort, "max");
  assert.equal(aliased.via, "alias");
  assert.throws(() => lookupModel(value, " ", options), /model must not be empty/);
  assert.throws(() => lookupModel(value, "opus-55", options), /Unknown model.*Did you mean albuquerque-quinn \(Opus 5.5\).*Call list_models/);
  assert.throws(() => lookupModel(value, "mine", { ...options, aliases: { mine: "zzzz" } }), /NOTION_MODEL_ALIASES -> "zzzz"/);
  const unknown = lookupModel(value, " New Model ", { ...options, allowUnlisted: true });
  assert.equal(unknown.codename, "New Model");
  assert.equal(unknown.via, "unlisted");
  assert.equal(unknown.model, undefined);
  assert.match(unknown.warnings[0] ?? "", /sent unvalidated because NOTION_ALLOW_UNLISTED_MODELS is on/);
  assert.equal(lookupModel(value, "mine", { ...options, allowUnlisted: true, aliases: { mine: "New ID" } }).codename, "New ID");
});

test("suggestions identify typos without treating mystery as a provider prefix", () => {
  const value = catalog();
  assert.equal(suggestModels(value, "opus-55")[0]?.codename, "albuquerque-quinn");
  assert.equal(suggestModels(value, "sonet 4.6")[0]?.codename, "almond-croissant-low");
  assert.equal(suggestModels(value, "mystery-deepseek-v4-pro")[0]?.codename, "baseten-deepseek-v4-pro");
  assert.deepEqual(suggestModels(value, "zzzz"), []);
  assert.equal(suggestModels(value, "opus", 1).length, 1);
});

test("availability respects per-surface disable flags and personal agent restrictions", () => {
  const value = catalog();
  assert.equal(modelAvailability(model("anthropic-haiku-4.5", value), "inference_transcript").reason,
    "not offered for Notion AI chat (Notion lists it only for Agent Service file chats)");
  assert.equal(modelAvailability(model("oregon-grape-medium", value), "agent_service").reason,
    "not offered for Agent Service file chats (Notion lists it only for custom agents)");
  assert.equal(modelAvailability(model("orlando-quinn", value), "inference_transcript").reason,
    "disabled (restricted_access, credit_limit_reached)");
  assert.equal(modelAvailability(model("baseten-deepseek-v4-pro", value), "agent_service").reason,
    "restricted for the personal agent");
  assert.equal(modelAvailability(model("baseten-deepseek-v4-pro", value), "inference_transcript").available, true);
  assert.equal(surfaceFor(model("oatmeal-cookie", value), "agent_service")?.finalModelName, "oatmeal-cookie");
  assert.equal(surfaceFor(model("quince-tart", value), "agent_service")?.finalModelName, "quince-tart-agent");
  assert.equal(surfaceFor(model("quince-tart", value), "inference_transcript")?.finalModelName, "quince-tart-2026-09");
  const twins = parseAvailableModels({ models: [
    entry("twin-a", "Twin", { isDisabled: true }),
    entry("twin-b", "Twin", { isDisabled: true, workflow: { finalModelName: "twin-b", isDisabled: false } })
  ] }, SPACE);
  assert.equal(lookupModel(twins, "Twin", options).codename, "twin-b");
  assert.equal(modelAvailability(model("twin-a", twins), "inference_transcript").reason, "disabled");
  const bare = model("bare-model", parseAvailableModels({ models: [{ model: "bare-model" }] }, SPACE));
  assert.deepEqual(modelAvailability(bare, "inference_transcript"), { available: true, finalModelName: "bare-model" });
  assert.equal(modelLabel(bare), "bare-model");
  assert.equal(modelLabel(model("albuquerque-quinn", value)), "Opus 5.5 (albuquerque-quinn)");
});

test("effort spellings are normalized, but support is always read from the model", () => {
  assert.equal(normalizeKey(" Opus_5.5 (Max) "), "opus-5.5-max");
  for (const [typed, effort] of [["off", "none"], ["no thinking", "none"], ["med", "medium"],
    ["X-High", "xhigh"], ["extra high", "xhigh"], ["maximum", "max"], ["cosmic", "cosmic"]]) {
    assert.equal(canonicalEffort(typed!), effort);
  }
  const opus = model("albuquerque-quinn");
  assert.equal(matchEffort(opus, "maximum"), "max");
  assert.equal(matchEffort(opus, "turbo"), undefined);
  assert.equal(matchEffort(opus, "none"), undefined);
  assert.equal(matchEffort({ ...opus, efforts: ["XHigh"] }, "extra high"), "XHigh");
  assert.equal(matchEffort(model("quince-tart"), "ultra"), "ultra");
});

test("effort priority is explicit, suffix, inherited, then server default", () => {
  const opus = model("albuquerque-quinn");
  assert.deepEqual(resolveReasoningEffort(opus, {}), { effort: "medium", source: "default", warnings: [] });
  assert.deepEqual(resolveReasoningEffort(opus, { inherited: "max" }), { effort: "max", source: "inherited", warnings: [] });
  assert.deepEqual(resolveReasoningEffort(opus, { implied: "high", inherited: "max" }), { effort: "high", source: "implied", warnings: [] });
  assert.deepEqual(resolveReasoningEffort(opus, { explicit: "maximum", implied: "max" }), { effort: "max", source: "explicit", warnings: [] });
  const override = resolveReasoningEffort(opus, { explicit: "low", implied: "max", inherited: "high" });
  assert.equal(override.effort, "low");
  assert.equal(override.source, "explicit");
  assert.deepEqual(override.warnings, ['reasoningEffort low overrides the "max" suffix in the model name.']);
  assert.deepEqual(resolveReasoningEffort({ ...opus, defaultEffort: undefined }, {}), { effort: "low", source: "default", warnings: [] });
});

test("unsupported explicit and suffix efforts fail; incompatible inherited effort warns", () => {
  const gpt = model("oval-kumquat-medium");
  assert.throws(() => resolveReasoningEffort(gpt, { explicit: "max" }), /does not support reasoningEffort "max".*medium, high \(default medium\)/);
  assert.throws(() => resolveReasoningEffort(gpt, { implied: "low" }), /does not support reasoningEffort "low" \(taken from the model name\)/);
  const inherited = resolveReasoningEffort(gpt, { inherited: "max" });
  assert.equal(inherited.effort, "medium");
  assert.equal(inherited.source, "default");
  assert.deepEqual(inherited.warnings, [
    "GPT-5.4 (oval-kumquat-medium) does not support the conversation's reasoningEffort max; using medium instead."
  ]);
});

test("models with no effort setting omit it and reject an explicit setting", () => {
  const grok = model("xinomavro-cake");
  assert.deepEqual(resolveReasoningEffort(grok, {}), { warnings: [] });
  assert.throws(() => resolveReasoningEffort(grok, { explicit: "high" }), /has no reasoning effort setting; omit reasoningEffort/);
  assert.throws(() => resolveReasoningEffort(grok, { implied: "high" }), /suffix in the model name cannot be applied/);
  assert.deepEqual(resolveReasoningEffort(grok, { inherited: "max" }), {
    warnings: ["Grok Build 0.1 (xinomavro-cake) has no reasoning effort setting, so the conversation's reasoningEffort max is not sent."]
  });
  assert.deepEqual(resolveReasoningEffort(undefined, { explicit: "X-High", implied: "max" }), { effort: "xhigh", source: "explicit", warnings: [] });
  assert.deepEqual(resolveReasoningEffort(undefined, {}), { warnings: [] });
});

test("plans send each transport's finalModelName and the server's default effort", () => {
  const value = catalog();
  const chat = planModel(value, { requestedModel: "Gemini 4 Pro", transport: "inference_transcript" }, planOptions);
  assert.deepEqual(chat, { model: "quince-tart-2026-09", codename: "quince-tart", modelName: "Gemini 4 Pro", reasoningEffort: "high", warnings: [] });
  const agent = planModel(value, { requestedModel: "Gemini 4 Pro", transport: "agent_service" }, planOptions);
  assert.equal(agent.model, "quince-tart-agent");
  assert.equal(planModel(value, { transport: "inference_transcript" }, planOptions).reasoningEffort, "low");
  assert.throws(() => planModel(value, { requestedModel: "orlando-quinn", transport: "inference_transcript" }, { ...planOptions, allowUnlisted: true }), /disabled \(restricted_access, credit_limit_reached\)/);
  assert.throws(() => planModel(value, { requestedModel: "oregon-grape-medium", transport: "inference_transcript" }, planOptions), /only for custom agents/);
  assert.throws(() => planModel(value, { requestedModel: "baseten-deepseek-v4-pro", transport: "agent_service" }, planOptions), /restricted for the personal agent/);
  assert.throws(() => planModel(value, { transport: "inference_transcript" }, { defaultModel: "zzzz" }), /NOTION_DEFAULT_MODEL "zzzz" cannot be used: Unknown model/);
});

test("a conversation keeps its model and effort regardless of default or operator aliases", () => {
  const value = catalog();
  const kept = planModel(value, { inheritedModel: "albuquerque-quinn", inheritedEffort: "max", transport: "inference_transcript" },
    { ...planOptions, aliases: { "albuquerque-quinn": "Sonnet 4.6" } });
  assert.equal(kept.model, "albuquerque-quinn");
  assert.equal(kept.reasoningEffort, "max");
  assert.deepEqual(kept.warnings, []);
  const keptSuffix = planModel(value, { inheritedModel: "almond-croissant-high", transport: "inference_transcript" }, planOptions);
  assert.equal(keptSuffix.model, "almond-croissant-low");
  assert.equal(keptSuffix.reasoningEffort, "high");
  const changed = planModel(value, { requestedModel: "GPT-5.4", inheritedModel: "albuquerque-quinn", inheritedEffort: "high", transport: "inference_transcript" }, planOptions);
  assert.equal(changed.model, "oval-kumquat-medium");
  assert.equal(changed.reasoningEffort, "high");
  assert.deepEqual(changed.warnings, []);
  const incompatible = planModel(value, { requestedModel: "GPT-5.4", inheritedEffort: "max", transport: "inference_transcript" }, planOptions);
  assert.equal(incompatible.reasoningEffort, "medium");
  assert.match(incompatible.warnings[0] ?? "", /conversation's reasoningEffort max/);
});

test("an unavailable inherited model falls back with an actionable warning", () => {
  const result = planModel(catalog(), { inheritedModel: "orlando-quinn", inheritedEffort: "xhigh", transport: "inference_transcript" }, planOptions);
  assert.equal(result.model, "almond-croissant-low");
  assert.equal(result.reasoningEffort, "low");
  assert.match(result.warnings[0] ?? "", /This conversation ran on orlando-quinn, which cannot be used any more.*switching to NOTION_DEFAULT_MODEL/);
  assert.match(result.warnings[1] ?? "", /does not support the conversation's reasoningEffort xhigh/);
  const unlisted = planModel(catalog(), { requestedModel: "new-model", requestedEffort: "cosmic", transport: "inference_transcript" }, { ...planOptions, allowUnlisted: true });
  assert.equal(unlisted.model, "new-model");
  assert.equal(unlisted.reasoningEffort, "cosmic");
  assert.match(unlisted.warnings[0] ?? "", /sent unvalidated/);
});

test("legacy mode expands only tiers and aliases, without a static model or effort table", () => {
  const input = { transport: "inference_transcript" as const };
  assert.deepEqual(legacyPlan(input, planOptions), { model: "almond-croissant-low", warnings: [] });
  assert.equal(legacyPlan({ ...input, requestedModel: "standard" }, planOptions).model, "almond-croissant-high");
  assert.equal(legacyPlan({ ...input, requestedModel: "Opus 5.5" }, planOptions).model, "Opus 5.5");
  assert.equal(legacyPlan({ ...input, requestedModel: "opus-5.5-max" }, planOptions).reasoningEffort, undefined);
  assert.equal(legacyPlan({ ...input, requestedModel: "default" }, { defaultModel: "default" }).model, "almond-croissant-low");
  assert.equal(legacyPlan({ ...input, requestedModel: "mine" }, { ...planOptions, aliases: { mine: "unlisted-id" } }).model, "unlisted-id");
  assert.deepEqual(legacyPlan({ ...input, inheritedModel: "existing-id", inheritedEffort: "maximum" }, planOptions), { model: "existing-id", reasoningEffort: "max", warnings: [] });
  assert.equal(legacyPlan({ ...input, requestedModel: "new-id", inheritedModel: "existing-id", inheritedEffort: "high" }, planOptions).reasoningEffort, undefined);
  assert.equal(legacyPlan({ ...input, requestedModel: "existing-id", inheritedModel: "existing-id", inheritedEffort: "high" }, planOptions).reasoningEffort, "high");
  assert.equal(legacyPlan({ ...input, requestedModel: "new-id", requestedEffort: "ultra" }, planOptions).reasoningEffort, "ultra");
});

test("envAliases accepts only nonempty string mappings and normalizes alias keys", () => {
  assert.deepEqual(envAliases(' {" My Fast ":" Opus 5.5 "," ":"ignored","bad":42,"empty":" "} '), { "my-fast": "Opus 5.5" });
  for (const raw of ["", "not json", "[]", "null", "42"]) assert.deepEqual(envAliases(raw), {});
  const before = process.env.NOTION_MODEL_ALIASES;
  try {
    process.env.NOTION_MODEL_ALIASES = '{"My_Model":"quince-tart"}';
    assert.deepEqual(envAliases(), { "my-model": "quince-tart" });
  } finally {
    if (before === undefined) delete process.env.NOTION_MODEL_ALIASES;
    else process.env.NOTION_MODEL_ALIASES = before;
  }
});

test("model catalog cache honors TTL boundaries, account/workspace keys and forced refresh", async () => {
  let now = 1000;
  let calls = 0;
  const store = new ModelCatalogStore(100, () => now);
  const load = async (): Promise<ModelCatalog> => { calls += 1; return catalog(); };
  assert.equal((await store.get("account:a:space:a", load)).source, "live");
  now = 1099;
  assert.equal((await store.get("account:a:space:a", load)).source, "cache");
  assert.equal(calls, 1);
  now = 1100;
  assert.equal((await store.get("account:a:space:a", load)).source, "live");
  assert.equal(calls, 2);
  assert.equal((await store.get("account:a:space:a", load, { refresh: true })).source, "live");
  assert.equal((await store.get("account:a:space:b", load)).source, "live");
  assert.equal((await store.get("account:b:space:a", load)).source, "live");
  assert.equal(calls, 5);
});

test("concurrent catalog requests share one fetch", async () => {
  const store = new ModelCatalogStore(100);
  let calls = 0;
  let release!: (value: ModelCatalog) => void;
  const pending = new Promise<ModelCatalog>((resolve) => { release = resolve; });
  const load = async (): Promise<ModelCatalog> => { calls += 1; return pending; };
  const first = store.get("same", load);
  const second = store.get("same", load, { refresh: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  const value = catalog();
  release(value);
  const responses = await Promise.all([first, second]);
  assert.equal(responses[0]?.catalog, value);
  assert.equal(responses[1]?.catalog, value);
  assert.equal(responses[0]?.source, "live");
  assert.equal(responses[1]?.source, "live");
});

test("fetch errors serve the last good catalog as stale, but never invent a first entry", async () => {
  const store = new ModelCatalogStore(0);
  const value = catalog();
  await store.get("same", async () => value);
  const stale = await store.get("same", async () => { throw new Error("HTTP 502"); });
  assert.deepEqual(stale, { catalog: value, source: "stale", error: "HTTP 502" });
  await assert.rejects(store.get("new", async () => { throw new Error("HTTP 401"); }), /HTTP 401/);
  const recovered = await store.get("new", async () => value);
  assert.equal(recovered.source, "live");
  const empty = { ...value, models: [] };
  await assert.rejects(store.get("empty", async () => empty), /returned no models/);
  await assert.rejects(store.get("empty", async () => { throw new Error("not cached"); }), /not cached/);
});

test("list_models describes live efforts, credit metadata, surface availability and tiers", () => {
  const listing = describeCatalog({ catalog: catalog(), source: "live" }, planOptions);
  assert.equal(listing.modelCount, 10);
  assert.equal(listing.chatModelCount, 7);
  assert.equal(listing.fetchedAt, "2026-09-30T01:02:03.000Z");
  assert.equal(listing.source, "live");
  assert.equal(listing.defaultModel.configured, "almond-croissant-low");
  assert.equal(listing.defaultModel.reasoningEffort, "low");
  assert.equal(listing.tiers.standard?.model, "almond-croissant-low");
  assert.equal(listing.tiers.standard?.reasoningEffort, "high");
  assert.equal(listing.tiers.thinking?.model, "oatmeal-cookie");
  const opus = listing.models.find((item) => item.model === "albuquerque-quinn");
  assert.deepEqual(opus?.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(opus?.defaultReasoningEffort, "medium");
  assert.equal(opus?.billsNotionCredits, true);
  assert.equal(listing.models.find((item) => item.model === "xinomavro-cake")?.approachingRateLimit, true);
  assert.equal(listing.models.find((item) => item.model === "quince-tart")?.finalModelName, "quince-tart-2026-09");
  assert.equal(listing.models.find((item) => item.model === "oval-kumquat-medium")?.customAgent, "not offered");
  assert.equal(listing.models.find((item) => item.model === "oregon-grape-medium")?.customAgent, "available");
  assert.deepEqual(listing.models.find((item) => item.model === "almond-croissant-low")?.card, { speed: 4, intelligence: 3, cost: 2 });
  const text = formatModelListing(listing);
  assert.equal(text.split("\n").length, 15);
  assert.match(text, /10 models.*7 usable in notion_ai_chat/);
  assert.ok(text.includes("baseten-deepseek-v4-pro | DeepSeek V4 Pro | mystery:baseten/intelligent | none|minimal|low|medium|high|max|xhigh (high) | available | restricted for the personal agent"));
  assert.ok(text.includes("xinomavro-cake | Grok Build 0.1 | xai/intelligent | none offered | available | available"));
});

test("list_models exposes stale fetch warnings and invalid defaults instead of hiding them", () => {
  const listing = describeCatalog({ catalog: catalog(), source: "stale", error: "HTTP 502" }, { defaultModel: "zzzz" });
  assert.equal(listing.warning, "getAvailableModels failed (HTTP 502); showing the list fetched at 2026-09-30T01:02:03.000Z.");
  assert.match(listing.defaultModel.error ?? "", /Unknown model "zzzz"/);
  const text = formatModelListing(listing);
  assert.match(text, /Warning: getAvailableModels failed \(HTTP 502\)/);
  assert.match(text, /Default \(NOTION_DEFAULT_MODEL=zzzz\): unusable:/);
  const restricted = catalog();
  restricted.models = restricted.models.map((item) => item.codename === "almond-croissant-low"
    ? { ...item, restrictedForCustomAgent: true } : item);
  assert.equal(describeCatalog({ catalog: restricted, source: "cache" }, planOptions).models[0]?.customAgent, "restricted");
});
