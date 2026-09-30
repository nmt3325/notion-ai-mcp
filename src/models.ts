// Live Notion AI model catalog.
//
// The models a workspace can use, the surfaces that accept each one and the reasoning efforts each one
// takes all come from POST /api/v3/getAvailableModels, the call behind the model picker in the Notion
// web client. This module keeps no model list and no effort table of its own: it parses that response
// and resolves what a caller typed ("Opus 5.5", "opus-5.5-max", a codename, a tier such as "fast")
// against it, and picks the effort the same way the web client does.

export type ModelTransport = "inference_transcript" | "agent_service";

export interface ModelSurface {
  /** The name the web client sends for this surface. */
  finalModelName: string;
  beta?: boolean | undefined;
  isDisabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface ModelCard { speed?: number | undefined; intelligence?: number | undefined; cost?: number | undefined }

export interface CatalogModel {
  /** Internal codename, e.g. albuquerque-quinn. */
  codename: string;
  /** Picker label, e.g. "Opus 5.5". */
  name: string;
  family: string;
  provider: string;
  group: string;
  /** supportedReasoningEfforts in the server's order; empty when the model has no effort setting. */
  efforts: string[];
  defaultEffort?: string | undefined;
  isDisabled: boolean;
  disabledReason?: string | undefined;
  restrictedForPersonalAgent: boolean;
  restrictedForCustomAgent: boolean;
  disabledOnlyByDisasterRecovery: boolean;
  approachingRateLimit: boolean;
  billsNotionCredits?: boolean | undefined;
  supportsTokenSharing: boolean;
  restrictedAccessCodename?: string | undefined;
  card?: ModelCard | undefined;
  surfaces: { workflow?: ModelSurface | undefined; agentService?: ModelSurface | undefined; customAgent?: ModelSurface | undefined };
}

export interface RestrictedAccessModel { codename: string; name: string; family: string; billsNotionCredits?: boolean | undefined }

export interface ModelCatalog {
  spaceId: string;
  fetchedAt: number;
  models: CatalogModel[];
  modelSelectionRestricted: boolean;
  restrictedGeoPolicyApplied: boolean;
  restrictedAccessModels: RestrictedAccessModel[];
}

type Json = Record<string, unknown>;

function record(value: unknown): Json { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function parseSurface(value: unknown, codename: string): ModelSurface | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Json;
  const disabledReason = text(raw.disabledReason);
  return {
    finalModelName: text(raw.finalModelName) || codename,
    ...(typeof raw.beta === "boolean" ? { beta: raw.beta } : {}),
    ...(typeof raw.isDisabled === "boolean" ? { isDisabled: raw.isDisabled } : {}),
    ...(disabledReason ? { disabledReason } : {})
  };
}

function parseCard(value: unknown): ModelCard | undefined {
  const raw = record(value);
  const card: ModelCard = {};
  for (const key of ["speed", "intelligence", "cost"] as const) {
    const score = finite(raw[key]);
    if (score !== undefined) card[key] = score;
  }
  return Object.keys(card).length > 0 ? card : undefined;
}

/**
 * Parses a getAvailableModels response. Unknown fields are ignored and entries without a codename are
 * skipped, so a new field or a partial entry never breaks model resolution.
 */
export function parseAvailableModels(payload: unknown, spaceId: string, fetchedAt: number = Date.now()): ModelCatalog {
  const body = record(payload);
  if (!Array.isArray(body.models)) throw new Error("getAvailableModels did not return a models array");
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of body.models) {
    const raw = record(item);
    const codename = text(raw.model);
    if (!codename || seen.has(codename)) continue;
    seen.add(codename);
    const configuration = record(raw.modelConfiguration);
    const supported: unknown[] = Array.isArray(configuration.supportedReasoningEfforts) ? configuration.supportedReasoningEfforts : [];
    const efforts = [...new Set(supported.map(text).filter(Boolean))];
    const defaultEffort = text(configuration.defaultReasoningEffort);
    const disabledReason = text(raw.disabledReason);
    const restrictedAccessCodename = text(raw.restrictedAccessModelCodename);
    const card = parseCard(raw.modelCardAttributes);
    const workflow = parseSurface(raw.workflow, codename);
    const agentService = parseSurface(raw.agentService, codename);
    const customAgent = parseSurface(raw.customAgent, codename);
    models.push({
      codename,
      name: text(raw.modelMessage) || codename,
      family: text(raw.modelFamily),
      provider: text(raw.modelProvider) || text(raw.modelFamily),
      group: text(raw.displayGroup),
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      isDisabled: raw.isDisabled === true,
      ...(disabledReason ? { disabledReason } : {}),
      restrictedForPersonalAgent: raw.restrictedForPersonalAgent === true,
      restrictedForCustomAgent: raw.restrictedForCustomAgent === true,
      disabledOnlyByDisasterRecovery: raw.isDisabledOnlyByDisasterRecovery === true,
      approachingRateLimit: raw.isApproachingRateLimit === true,
      ...(typeof raw.billsNotionCredits === "boolean" ? { billsNotionCredits: raw.billsNotionCredits } : {}),
      supportsTokenSharing: raw.supportsTokenSharing === true,
      ...(restrictedAccessCodename ? { restrictedAccessCodename } : {}),
      ...(card ? { card } : {}),
      surfaces: { ...(workflow ? { workflow } : {}), ...(agentService ? { agentService } : {}), ...(customAgent ? { customAgent } : {}) }
    });
  }
  if (models.length === 0) throw new Error("getAvailableModels returned no models");
  const restrictedAccessModels: RestrictedAccessModel[] = [];
  const restricted: unknown[] = Array.isArray(body.restrictedAccessModelsInPickerConfig) ? body.restrictedAccessModelsInPickerConfig : [];
  for (const item of restricted) {
    const raw = record(item);
    const codename = text(raw.codename);
    if (!codename) continue;
    restrictedAccessModels.push({
      codename, name: text(raw.modelMessage) || codename, family: text(raw.modelFamily),
      ...(typeof raw.billsNotionCredits === "boolean" ? { billsNotionCredits: raw.billsNotionCredits } : {})
    });
  }
  return {
    spaceId, fetchedAt, models,
    modelSelectionRestricted: body.modelSelectionRestricted === true,
    restrictedGeoPolicyApplied: body.restrictedGeoPolicyApplied === true,
    restrictedAccessModels
  };
}

/** Lowercases and hyphenates, so "Opus 5.5 (Max)", "opus_5.5_max" and "opus-5.5-max" compare equal. */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[()[\]{}]/g, " ").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Other spellings of the effort names Notion uses. This only normalizes what a caller types: which
 * efforts a model accepts, and which one it defaults to, always come from the live list.
 */
const EFFORT_SPELLINGS: Record<string, string> = {
  off: "none",
  disabled: "none",
  "no-thinking": "none",
  "no-reasoning": "none",
  min: "minimal",
  med: "medium",
  "x-high": "xhigh",
  "extra-high": "xhigh",
  "very-high": "xhigh",
  maximum: "max"
};

export function canonicalEffort(value: string): string {
  const key = normalizeKey(value);
  return EFFORT_SPELLINGS[key] ?? key;
}

/** The server's own spelling of an effort the model supports, or undefined. */
export function matchEffort(model: CatalogModel, value: string): string | undefined {
  const wanted = canonicalEffort(value);
  return wanted ? model.efforts.find((effort) => canonicalEffort(effort) === wanted) : undefined;
}

/**
 * Splits a trailing effort off a normalized name: "opus-5.5-max" -> opus-5.5 + max, and old-style IDs
 * such as "oatmeal-cookie-high-thinking" -> oatmeal-cookie + high. The vocabulary is longest first.
 */
export function splitEffortSuffix(key: string, vocabulary: readonly string[]): { base: string; effort?: string | undefined } | undefined {
  const rest = key.endsWith("-thinking") && !key.endsWith("-no-thinking") ? key.slice(0, -"-thinking".length) : key;
  for (const word of vocabulary) {
    const suffix = `-${word}`;
    if (rest.length > suffix.length && rest.endsWith(suffix)) return { base: rest.slice(0, -suffix.length), effort: canonicalEffort(word) };
  }
  return rest !== key && rest ? { base: rest } : undefined;
}

interface CatalogIndex {
  codename: Map<string, CatalogModel[]>;
  finalName: Map<string, CatalogModel[]>;
  name: Map<string, CatalogModel[]>;
  base: Map<string, CatalogModel[]>;
  vocabulary: string[];
}

const PREFIX_ALIASES: Record<string, string[]> = { anthropic: ["claude"], gemini: ["google"] };

/** "Opus 5.5" is also reachable as claude-opus-5.5 and anthropic-opus-5.5. */
function nameKeys(model: CatalogModel): string[] {
  const names = new Set([normalizeKey(model.name), normalizeKey(model.name.replace(/\([^)]*\)/g, " "))].filter(Boolean));
  const prefixes = new Set<string>();
  for (const label of [model.family, model.provider]) {
    const key = normalizeKey(label);
    // "mystery" is the family Notion gives unannounced models, not a name anyone types.
    if (!key || key === "mystery") continue;
    prefixes.add(key);
    for (const extra of PREFIX_ALIASES[key] ?? []) prefixes.add(extra);
  }
  const keys = new Set(names);
  for (const name of names) for (const prefix of prefixes) if (!name.startsWith(`${prefix}-`)) keys.add(`${prefix}-${name}`);
  return [...keys];
}

const indexes = new WeakMap<ModelCatalog, CatalogIndex>();

function indexOf(catalog: ModelCatalog): CatalogIndex {
  const cached = indexes.get(catalog);
  if (cached) return cached;
  const words = new Set(Object.keys(EFFORT_SPELLINGS));
  for (const model of catalog.models) for (const effort of model.efforts) {
    const key = normalizeKey(effort);
    if (key) words.add(key);
  }
  // Longest first, so "x-high" is tried before "high".
  const vocabulary = [...words].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const index: CatalogIndex = { codename: new Map(), finalName: new Map(), name: new Map(), base: new Map(), vocabulary };
  const add = (table: Map<string, CatalogModel[]>, key: string, model: CatalogModel): void => {
    if (!key) return;
    const list = table.get(key);
    if (!list) table.set(key, [model]);
    else if (!list.includes(model)) list.push(model);
  };
  for (const model of catalog.models) {
    const codename = normalizeKey(model.codename);
    add(index.codename, codename, model);
    for (const surface of [model.surfaces.workflow, model.surfaces.agentService, model.surfaces.customAgent]) {
      if (surface) add(index.finalName, normalizeKey(surface.finalModelName), model);
    }
    for (const key of nameKeys(model)) add(index.name, key, model);
    const split = splitEffortSuffix(codename, vocabulary);
    if (split) add(index.base, split.base, model);
  }
  indexes.set(catalog, index);
  return index;
}

const SURFACE_LABELS = { workflow: "Notion AI chat", agentService: "Agent Service file chats", customAgent: "custom agents" } as const;

export function transportLabel(transport: ModelTransport): string {
  return transport === "agent_service" ? SURFACE_LABELS.agentService : SURFACE_LABELS.workflow;
}

export function modelLabel(model: CatalogModel): string {
  return model.name && model.name !== model.codename ? `${model.name} (${model.codename})` : model.codename;
}

/** Chats use the workflow surface; the Agent Service uses its own and falls back to workflow, like the web client. */
export function surfaceFor(model: CatalogModel, transport: ModelTransport): ModelSurface | undefined {
  const { workflow, agentService, customAgent } = model.surfaces;
  // An entry without any surface predates per-surface flags; its codename is then the model name.
  if (!workflow && !agentService && !customAgent) return { finalModelName: model.codename };
  return transport === "agent_service" ? agentService ?? workflow : workflow;
}

export interface ModelAvailability { available: boolean; finalModelName: string; reason?: string | undefined }

export function modelAvailability(model: CatalogModel, transport: ModelTransport): ModelAvailability {
  const surface = surfaceFor(model, transport);
  if (!surface) {
    const offered = (Object.keys(SURFACE_LABELS) as Array<keyof typeof SURFACE_LABELS>).filter((key) => model.surfaces[key]).map((key) => SURFACE_LABELS[key]);
    return { available: false, finalModelName: model.codename, reason: `not offered for ${transportLabel(transport)}${offered.length > 0 ? ` (Notion lists it only for ${offered.join(" and ")})` : ""}` };
  }
  if (surface.isDisabled ?? model.isDisabled) {
    const reasons = [...new Set([surface.disabledReason, model.disabledReason].filter((value): value is string => Boolean(value)))];
    return { available: false, finalModelName: surface.finalModelName, reason: `disabled${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}` };
  }
  if (transport === "agent_service" && model.restrictedForPersonalAgent) {
    return { available: false, finalModelName: surface.finalModelName, reason: "restricted for the personal agent" };
  }
  return { available: true, finalModelName: surface.finalModelName };
}

export interface LookupOptions {
  transport: ModelTransport;
  /** NOTION_DEFAULT_MODEL, used for the "default" tier. */
  defaultModel?: string | undefined;
  /** Send a name the live list does not contain unvalidated (NOTION_ALLOW_UNLISTED_MODELS). */
  allowUnlisted?: boolean | undefined;
  /** NOTION_MODEL_ALIASES with normalized keys. */
  aliases?: Record<string, string> | undefined;
}

export type ModelMatchSource = "alias" | "codename" | "finalModelName" | "name" | "codenameBase" | "effortSuffix" | "tier" | "unlisted";

export interface ModelMatch {
  /** Undefined when an unlisted name is passed through. */
  model?: CatalogModel | undefined;
  codename: string;
  /** Effort named by a suffix such as "-max" or "(High)". */
  impliedEffort?: string | undefined;
  via: ModelMatchSource;
  warnings: string[];
}

/**
 * Tier names kept from earlier releases. A target is resolved against the live list like any other
 * name; when the workspace does not offer it, the first usable model of the same display group is used.
 */
const TIERS: Record<string, { target: string; group: string }> = {
  fast: { target: "almond-croissant-low", group: "fast" },
  "notion-fast": { target: "almond-croissant-low", group: "fast" },
  standard: { target: "almond-croissant-high", group: "intelligent" },
  balanced: { target: "almond-croissant-high", group: "intelligent" },
  "notion-standard": { target: "almond-croissant-high", group: "intelligent" },
  thinking: { target: "oatmeal-cookie", group: "intelligent" },
  reasoning: { target: "oatmeal-cookie", group: "intelligent" },
  deep: { target: "oatmeal-cookie", group: "intelligent" },
  "notion-thinking": { target: "oatmeal-cookie", group: "intelligent" }
};

const DEFAULT_TIERS = new Set(["default", "notion-default"]);

/** Tier names shown by list_models. */
export const MODEL_TIERS: readonly string[] = ["fast", "standard", "thinking"];

function preferUsable(models: readonly CatalogModel[] | undefined, transport: ModelTransport): CatalogModel | undefined {
  if (!models || models.length === 0) return undefined;
  return models.find((model) => modelAvailability(model, transport).available) ?? models[0];
}

function exactMatch(index: CatalogIndex, key: string, transport: ModelTransport): { model: CatalogModel; via: ModelMatchSource } | undefined {
  const tables: Array<[Map<string, CatalogModel[]>, ModelMatchSource]> = [
    [index.codename, "codename"], [index.finalName, "finalModelName"], [index.name, "name"], [index.base, "codenameBase"]
  ];
  for (const [table, via] of tables) {
    const model = preferUsable(table.get(key), transport);
    if (model) return { model, via };
  }
  return undefined;
}

function resolveListed(catalog: ModelCatalog, key: string, options: LookupOptions, depth: number): ModelMatch | undefined {
  const index = indexOf(catalog);
  const exact = exactMatch(index, key, options.transport);
  if (exact) return { model: exact.model, codename: exact.model.codename, via: exact.via, warnings: [] };
  const split = splitEffortSuffix(key, index.vocabulary);
  const base = split ? exactMatch(index, split.base, options.transport) : undefined;
  if (split && base) {
    return { model: base.model, codename: base.model.codename, ...(split.effort ? { impliedEffort: split.effort } : {}), via: "effortSuffix", warnings: [] };
  }
  if (depth >= 2) return undefined;
  if (DEFAULT_TIERS.has(key)) {
    const target = normalizeKey(options.defaultModel ?? "");
    const resolved = resolveListed(catalog, target && !DEFAULT_TIERS.has(target) ? target : "fast", options, depth + 1);
    return resolved ? { ...resolved, via: "tier" } : undefined;
  }
  const tier = TIERS[key];
  if (!tier) return undefined;
  const target = resolveListed(catalog, tier.target, options, depth + 1);
  if (target?.model && modelAvailability(target.model, options.transport).available) return { ...target, via: "tier" };
  const fallback = catalog.models.find((model) => model.group === tier.group && modelAvailability(model, options.transport).available);
  if (fallback) {
    return {
      model: fallback, codename: fallback.codename, via: "tier",
      warnings: [`Tier "${key}" normally means ${tier.target}, which this workspace does not offer for ${transportLabel(options.transport)}; using ${modelLabel(fallback)} instead.`]
    };
  }
  return target ? { ...target, via: "tier" } : undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Closest listed models for a name that did not resolve, for the error message. */
export function suggestModels(catalog: ModelCatalog, input: string, limit = 3): CatalogModel[] {
  const key = normalizeKey(input);
  const index = indexOf(catalog);
  const split = splitEffortSuffix(key, index.vocabulary);
  const probes = [...new Set([key, ...(split ? [split.base] : [])])].filter(Boolean);
  const best = new Map<CatalogModel, number>();
  for (const table of [index.codename, index.name]) {
    for (const [candidate, models] of table) {
      for (const probe of probes) {
        let score = editDistance(probe, candidate);
        if (probe.length >= 3 && (candidate.includes(probe) || probe.includes(candidate))) score = Math.min(score, 1);
        if (score > Math.max(2, Math.ceil(probe.length / 3))) continue;
        for (const model of models) {
          const seen = best.get(model);
          if (seen === undefined || score < seen) best.set(model, score);
        }
      }
    }
  }
  return [...best]
    .sort((a, b) => a[1] - b[1] || catalog.models.indexOf(a[0]) - catalog.models.indexOf(b[0]))
    .slice(0, limit)
    .map(([model]) => model);
}

/**
 * Resolves a model name against the live list, in this order: NOTION_MODEL_ALIASES, codename, surface
 * finalModelName, display name (optionally prefixed with family/provider, claude- or google-), codename
 * without its effort suffix, any of those followed by an effort suffix, then a tier. A name that still
 * does not resolve is an error listing the closest models, unless NOTION_ALLOW_UNLISTED_MODELS is on.
 */
export function lookupModel(catalog: ModelCatalog, input: string, options: LookupOptions): ModelMatch {
  const raw = input.trim();
  const key = normalizeKey(raw);
  if (!key) throw new Error("model must not be empty");
  const alias = options.aliases?.[key]?.trim();
  const target = alias || raw;
  const resolved = resolveListed(catalog, normalizeKey(target), options, 0);
  if (resolved) return alias ? { ...resolved, via: "alias" } : resolved;
  const described = alias ? `"${raw}" (NOTION_MODEL_ALIASES -> "${alias}")` : `"${raw}"`;
  if (options.allowUnlisted) {
    return { codename: target, via: "unlisted", warnings: [`Model ${described} is not in this workspace's model list; it is sent unvalidated because NOTION_ALLOW_UNLISTED_MODELS is on.`] };
  }
  const hints = suggestModels(catalog, target);
  throw new Error(
    `Unknown model ${described}: workspace ${catalog.spaceId} does not offer it.` +
    (hints.length > 0 ? ` Did you mean ${hints.map((model) => `${model.codename} (${model.name})`).join(", ")}?` : "") +
    " Call list_models for the live list of models and their reasoning efforts."
  );
}

export interface EffortRequest {
  /** reasoningEffort passed by the caller. */
  explicit?: string | undefined;
  /** Effort named by the model suffix, e.g. "opus-5.5-max". */
  implied?: string | undefined;
  /** The conversation's current effort. */
  inherited?: string | undefined;
}

export interface EffortResolution {
  effort?: string | undefined;
  source?: "explicit" | "implied" | "inherited" | "default" | undefined;
  warnings: string[];
}

/**
 * Picks the effort the way the web client does: nothing for a model without an effort setting,
 * otherwise the chosen effort when the model supports it and its defaultReasoningEffort (or first
 * supported effort) when not. An effort the caller asked for and the model lacks is an error.
 */
export function resolveReasoningEffort(model: CatalogModel | undefined, request: EffortRequest): EffortResolution {
  const explicit = request.explicit?.trim();
  const implied = request.implied?.trim();
  const inherited = request.inherited?.trim();
  const warnings: string[] = [];
  if (!model) {
    // Unlisted model: nothing to validate against, and no default to add.
    const value = explicit || implied || inherited;
    return value ? { effort: canonicalEffort(value), source: explicit ? "explicit" : implied ? "implied" : "inherited", warnings } : { warnings };
  }
  const label = modelLabel(model);
  if (model.efforts.length === 0) {
    if (explicit) throw new Error(`${label} has no reasoning effort setting; omit reasoningEffort for this model.`);
    if (implied) throw new Error(`${label} has no reasoning effort setting, so the "${implied}" suffix in the model name cannot be applied; use ${model.codename}.`);
    if (inherited) warnings.push(`${label} has no reasoning effort setting, so the conversation's reasoningEffort ${inherited} is not sent.`);
    return { warnings };
  }
  const supported = `${model.efforts.join(", ")}${model.defaultEffort ? ` (default ${model.defaultEffort})` : ""}`;
  if (explicit) {
    const effort = matchEffort(model, explicit);
    if (!effort) throw new Error(`${label} does not support reasoningEffort "${explicit}". Supported: ${supported}.`);
    if (implied && matchEffort(model, implied) !== effort) warnings.push(`reasoningEffort ${effort} overrides the "${implied}" suffix in the model name.`);
    return { effort, source: "explicit", warnings };
  }
  if (implied) {
    const effort = matchEffort(model, implied);
    if (!effort) throw new Error(`${label} does not support reasoningEffort "${implied}" (taken from the model name). Supported: ${supported}.`);
    return { effort, source: "implied", warnings };
  }
  const fallback = model.defaultEffort ?? model.efforts[0];
  if (inherited) {
    const effort = matchEffort(model, inherited);
    if (effort) return { effort, source: "inherited", warnings };
    warnings.push(`${label} does not support the conversation's reasoningEffort ${inherited}; using ${fallback ?? "no effort"} instead.`);
  }
  return { ...(fallback ? { effort: fallback } : {}), source: "default", warnings };
}

export interface ModelPlanInput {
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  /** The conversation's current model and effort, for a follow-up turn. */
  inheritedModel?: string | undefined;
  inheritedEffort?: string | undefined;
  transport: ModelTransport;
}

export interface ModelPlan {
  /** Sent as config.model and debugOverrides.model, or as the Agent Service model. */
  model: string;
  codename?: string | undefined;
  modelName?: string | undefined;
  reasoningEffort?: string | undefined;
  warnings: string[];
}

export interface PlanOptions {
  defaultModel: string;
  allowUnlisted?: boolean | undefined;
  aliases?: Record<string, string> | undefined;
}

function assertUsable(match: ModelMatch, transport: ModelTransport): void {
  if (!match.model) return;
  const state = modelAvailability(match.model, transport);
  if (!state.available) throw new Error(`${modelLabel(match.model)} is ${state.reason ?? "unavailable"} in this workspace. Call list_models to pick another model.`);
}

/**
 * Chooses the model and effort for one chat turn against the live list: the caller's model, else the
 * conversation's model, else NOTION_DEFAULT_MODEL; then the effort per resolveReasoningEffort, with the
 * conversation's effort carried across a model switch when the new model supports it.
 */
export function planModel(catalog: ModelCatalog, input: ModelPlanInput, options: PlanOptions): ModelPlan {
  const warnings: string[] = [];
  const lookup: LookupOptions = { transport: input.transport, defaultModel: options.defaultModel, allowUnlisted: options.allowUnlisted, aliases: options.aliases };
  let inheritedEffort = input.inheritedEffort?.trim() || undefined;
  let match: ModelMatch | undefined;
  const requested = input.requestedModel?.trim();
  const inherited = input.inheritedModel?.trim();
  if (requested) {
    match = lookupModel(catalog, requested, lookup);
    assertUsable(match, input.transport);
  } else if (inherited) {
    try {
      // A conversation keeps the model it runs on; operator aliases only apply to names a caller types.
      const kept = lookupModel(catalog, inherited, { ...lookup, aliases: {} });
      assertUsable(kept, input.transport);
      inheritedEffort ??= kept.impliedEffort;
      match = { ...kept, impliedEffort: undefined };
    } catch (error) {
      warnings.push(`This conversation ran on ${inherited}, which cannot be used any more (${errorText(error)}); switching to NOTION_DEFAULT_MODEL.`);
    }
  }
  if (!match) {
    try {
      match = lookupModel(catalog, options.defaultModel.trim() || "fast", lookup);
      assertUsable(match, input.transport);
    } catch (error) {
      throw new Error(`NOTION_DEFAULT_MODEL "${options.defaultModel}" cannot be used: ${errorText(error)}`);
    }
  }
  warnings.push(...match.warnings);
  const effort = resolveReasoningEffort(match.model, { explicit: input.requestedEffort, implied: match.impliedEffort, inherited: inheritedEffort });
  warnings.push(...effort.warnings);
  return {
    model: match.model ? modelAvailability(match.model, input.transport).finalModelName : match.codename,
    ...(match.model ? { codename: match.model.codename, modelName: match.model.name } : {}),
    ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
    warnings
  };
}

/**
 * Resolution without the live list (NOTION_MODEL_CATALOG=0, or getAvailableModels unreachable with
 * nothing cached): aliases and tiers are expanded, anything else is sent as typed, and no effort is
 * added that the caller or the conversation did not choose.
 */
export function legacyPlan(input: ModelPlanInput, options: PlanOptions): ModelPlan {
  const aliases = options.aliases ?? {};
  const expand = (value: string, depth = 0): string => {
    const key = normalizeKey(value);
    const alias = aliases[key]?.trim();
    if (alias) return alias;
    if (DEFAULT_TIERS.has(key)) {
      const target = options.defaultModel.trim();
      return depth < 2 && target && !DEFAULT_TIERS.has(normalizeKey(target)) ? expand(target, depth + 1) : TIERS.fast?.target ?? value.trim();
    }
    return TIERS[key]?.target ?? value.trim();
  };
  const requested = input.requestedModel?.trim();
  const inherited = input.inheritedModel?.trim();
  const model = requested ? expand(requested) : inherited || expand(options.defaultModel.trim() || "fast");
  // Nothing here says whether the conversation's effort suits another model, so it only carries over with its model.
  const keepsModel = !requested || model === inherited;
  const effort = input.requestedEffort?.trim() || (keepsModel ? input.inheritedEffort?.trim() : undefined);
  return { model, ...(effort ? { reasoningEffort: canonicalEffort(effort) } : {}), warnings: [] };
}

/** NOTION_MODEL_ALIASES: a JSON object mapping extra names to models, e.g. {"my-fast":"almond-croissant-low"}. */
export function envAliases(raw: string | undefined = process.env.NOTION_MODEL_ALIASES): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const aliases: Record<string, string> = {};
    for (const [alias, target] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeKey(alias);
      if (key && typeof target === "string" && target.trim()) aliases[key] = target.trim();
    }
    return aliases;
  } catch {
    return {};
  }
}

export interface CatalogLoad { catalog: ModelCatalog; source: "live" | "cache" | "stale"; error?: string | undefined }

/**
 * Per account and workspace cache of getAvailableModels. A fresh entry is served for ttlMs; after that
 * the list is fetched again, and if that fails the last good list is served as "stale" instead of
 * failing a chat on a transient error. Concurrent callers share one request.
 */
export class ModelCatalogStore {
  private readonly entries = new Map<string, { catalog: ModelCatalog; expiresAt: number }>();
  private readonly loading = new Map<string, Promise<ModelCatalog>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async get(key: string, load: () => Promise<ModelCatalog>, options: { refresh?: boolean | undefined } = {}): Promise<CatalogLoad> {
    const entry = this.entries.get(key);
    if (entry && options.refresh !== true && this.now() < entry.expiresAt) return { catalog: entry.catalog, source: "cache" };
    try {
      return { catalog: await this.fetch(key, load), source: "live" };
    } catch (error) {
      const stale = this.entries.get(key);
      if (stale) return { catalog: stale.catalog, source: "stale", error: errorText(error) };
      throw error;
    }
  }

  private fetch(key: string, load: () => Promise<ModelCatalog>): Promise<ModelCatalog> {
    const pending = this.loading.get(key);
    if (pending) return pending;
    const work = Promise.resolve().then(load).then((catalog) => {
      if (catalog.models.length === 0) throw new Error("getAvailableModels returned no models");
      this.entries.set(key, { catalog, expiresAt: this.now() + this.ttlMs });
      return catalog;
    });
    this.loading.set(key, work);
    const settle = (): void => { if (this.loading.get(key) === work) this.loading.delete(key); };
    work.then(settle, settle);
    return work;
  }
}

export interface ModelListingEntry {
  model: string;
  name: string;
  family: string;
  provider: string;
  group: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string | undefined;
  /** notion_ai_chat without Agent Service fileIds. */
  chat: string;
  /** notion_ai_chat with fileIds from upload_attachment. */
  agentService: string;
  customAgent: string;
  finalModelName?: string | undefined;
  billsNotionCredits?: boolean | undefined;
  approachingRateLimit?: boolean | undefined;
  card?: ModelCard | undefined;
}

export interface ModelListingChoice { model?: string | undefined; name?: string | undefined; reasoningEffort?: string | undefined; warnings?: string[] | undefined; error?: string | undefined }

export interface ModelListing {
  spaceId: string;
  fetchedAt: string;
  source: CatalogLoad["source"];
  warning?: string | undefined;
  modelCount: number;
  chatModelCount: number;
  defaultModel: ModelListingChoice & { configured: string };
  tiers: Record<string, ModelListingChoice>;
  modelSelectionRestricted: boolean;
  restrictedAccessModels: RestrictedAccessModel[];
  models: ModelListingEntry[];
}

function customAgentState(model: CatalogModel): string {
  const surface = model.surfaces.customAgent;
  if (!surface) return model.surfaces.workflow || model.surfaces.agentService ? "not offered" : "available";
  if (surface.isDisabled ?? model.isDisabled) return `disabled${surface.disabledReason ? ` (${surface.disabledReason})` : ""}`;
  return model.restrictedForCustomAgent ? "restricted" : "available";
}

function listingChoice(catalog: ModelCatalog, requestedModel: string, options: PlanOptions): ModelListingChoice {
  try {
    const plan = planModel(catalog, { requestedModel, transport: "inference_transcript" }, options);
    return {
      model: plan.model, ...(plan.modelName ? { name: plan.modelName } : {}),
      ...(plan.reasoningEffort ? { reasoningEffort: plan.reasoningEffort } : {}),
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {})
    };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** Structured list_models output. */
export function describeCatalog(load: CatalogLoad, options: PlanOptions): ModelListing {
  const { catalog } = load;
  const models = catalog.models.map((model): ModelListingEntry => {
    const chat = modelAvailability(model, "inference_transcript");
    const agent = modelAvailability(model, "agent_service");
    return {
      model: model.codename, name: model.name, family: model.family, provider: model.provider, group: model.group,
      reasoningEfforts: [...model.efforts],
      ...(model.efforts.length > 0 && model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
      chat: chat.available ? "available" : chat.reason ?? "unavailable",
      agentService: agent.available ? "available" : agent.reason ?? "unavailable",
      customAgent: customAgentState(model),
      ...(chat.available && chat.finalModelName !== model.codename ? { finalModelName: chat.finalModelName } : {}),
      ...(model.billsNotionCredits === undefined ? {} : { billsNotionCredits: model.billsNotionCredits }),
      ...(model.approachingRateLimit ? { approachingRateLimit: true } : {}),
      ...(model.card ? { card: model.card } : {})
    };
  });
  const tiers: Record<string, ModelListingChoice> = {};
  for (const tier of MODEL_TIERS) tiers[tier] = listingChoice(catalog, tier, options);
  const fetchedAt = new Date(catalog.fetchedAt).toISOString();
  return {
    spaceId: catalog.spaceId, fetchedAt, source: load.source,
    ...(load.error ? { warning: `getAvailableModels failed (${load.error}); showing the list fetched at ${fetchedAt}.` } : {}),
    modelCount: models.length,
    chatModelCount: models.filter((entry) => entry.chat === "available").length,
    defaultModel: { configured: options.defaultModel, ...listingChoice(catalog, options.defaultModel.trim() || "fast", options) },
    tiers,
    modelSelectionRestricted: catalog.modelSelectionRestricted,
    restrictedAccessModels: catalog.restrictedAccessModels,
    models
  };
}

function describeChoice(choice: ModelListingChoice): string {
  if (choice.error) return `unusable: ${choice.error}`;
  const effort = choice.reasoningEffort ? `, effort ${choice.reasoningEffort}` : "";
  const warnings = choice.warnings?.length ? ` (${choice.warnings.join(" ")})` : "";
  return `${choice.name ? `${choice.name} ` : ""}[${choice.model ?? "?"}]${effort}${warnings}`;
}

/** Plain-text list_models output: one line per model. */
export function formatModelListing(listing: ModelListing): string {
  const lines = [
    `${listing.modelCount} models for workspace ${listing.spaceId} (${listing.source}, fetched ${listing.fetchedAt}); ${listing.chatModelCount} usable in notion_ai_chat.`,
    ...(listing.warning ? [`Warning: ${listing.warning}`] : []),
    `Default (NOTION_DEFAULT_MODEL=${listing.defaultModel.configured}): ${describeChoice(listing.defaultModel)}`,
    `Tiers: ${Object.entries(listing.tiers).map(([tier, choice]) => `${tier} -> ${describeChoice(choice)}`).join("; ")}`,
    "",
    "model | name | family/group | reasoning efforts (default) | chat | Agent Service"
  ];
  for (const entry of listing.models) {
    const family = entry.provider && entry.provider !== entry.family ? `${entry.family}:${entry.provider}` : entry.family;
    const efforts = entry.reasoningEfforts.length > 0
      ? `${entry.reasoningEfforts.join("|")}${entry.defaultReasoningEffort ? ` (${entry.defaultReasoningEffort})` : ""}`
      : "none offered";
    lines.push(`${entry.model} | ${entry.name} | ${family}/${entry.group} | ${efforts} | ${entry.chat} | ${entry.agentService}`);
  }
  return lines.join("\n");
}
