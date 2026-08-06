const fs = require("fs");
const text = fs.readFileSync("chunks/63803-d82858141acb7c34.js", "utf8");
const starts = [...text.matchAll(/notionName:"([^"]+)"/g)];
const entries = [];
for (let i = 0; i < starts.length; i += 1) {
  const start = starts[i].index;
  const end = i + 1 < starts.length ? starts[i + 1].index : Math.min(text.length, start + 4000);
  const slice = text.slice(start, end);
  const pick = (name) => (slice.match(new RegExp(name + ':"([^"]+)"')) || [])[1];
  const flag = (name) => (slice.match(new RegExp(name + ":!([01])")) || [])[1] === "0";
  entries.push({
    modelId: starts[i][1],
    displayName: pick("displayName") || "",
    displayNameWithProvider: pick("displayNameWithProvider") || "",
    family: pick("modelFamily") || "",
    group: pick("displayGroup") || "",
    callable: flag("isProductionCallable"),
    pickable: flag("isProductionPickable")
  });
}
const seen = new Set();
const catalog = entries.filter((entry) => {
  if (!entry.displayName || !entry.callable || seen.has(entry.modelId)) return false;
  seen.add(entry.modelId);
  return true;
});
fs.writeFileSync(process.env.HOME + "/scratch/notion-models.json", JSON.stringify(entries, null, 2));
console.log(`parsed ${entries.length} registry entries, ${catalog.length} production-callable`);
console.log(catalog.filter((entry) => entry.pickable).map((entry) => `${entry.modelId} = ${entry.displayName} [${entry.family}/${entry.group}]`).join("\n"));
const rows = catalog.map((entry) => `  { modelId: ${JSON.stringify(entry.modelId)}, displayName: ${JSON.stringify(entry.displayName)}, displayNameWithProvider: ${JSON.stringify(entry.displayNameWithProvider)}, family: ${JSON.stringify(entry.family)}, group: ${JSON.stringify(entry.group)}, pickable: ${entry.pickable} }`).join(",\n");
const file = `// Model catalog extracted from the Notion web bundle model registry.
// Regenerate with scripts/extract-models.md when Notion ships new models.

export interface ModelInfo {
  modelId: string;
  displayName: string;
  displayNameWithProvider: string;
  family: string;
  group: string;
  pickable: boolean;
}

export const MODEL_CATALOG: ModelInfo[] = [
${rows}
];

export const KNOWN_MODEL_IDS: string[] = MODEL_CATALOG.map((entry) => entry.modelId);

/** Stable, human friendly tiers that stay valid even when Notion renames a model. */
export const BUILTIN_ALIASES: Record<string, string> = {
  fast: "almond-croissant-low",
  default: "almond-croissant-low",
  "notion-fast": "almond-croissant-low",
  standard: "almond-croissant-high",
  balanced: "almond-croissant-high",
  "notion-standard": "almond-croissant-high",
  thinking: "oatmeal-cookie",
  reasoning: "oatmeal-cookie",
  deep: "oatmeal-cookie",
  "notion-thinking": "oatmeal-cookie"
};

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\\s_]+/g, "-").replace(/-+/g, "-");
}

function addAlias(target: Record<string, string>, alias: string, modelId: string): void {
  const key = normalizeKey(alias);
  if (!key || key in target) return;
  target[key] = modelId;
}

/** Vendor names taken straight from the Notion model registry, e.g. "gpt-5.2" or "sonnet-4.6-low". */
export function catalogAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const entry of MODEL_CATALOG) {
    addAlias(aliases, entry.modelId, entry.modelId);
    addAlias(aliases, entry.displayName, entry.modelId);
    addAlias(aliases, entry.displayNameWithProvider, entry.modelId);
    addAlias(aliases, entry.displayName.replace(/[()]/g, ""), entry.modelId);
    addAlias(aliases, entry.displayNameWithProvider.replace(/^(OpenAI|Anthropic|Google|Notion)\\s+/i, "").replace(/[()]/g, ""), entry.modelId);
  }
  return aliases;
}

export function envAliases(): Record<string, string> {
  const raw = process.env.NOTION_MODEL_ALIASES;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const aliases: Record<string, string> = {};
    for (const [alias, modelId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof modelId === "string" && modelId.trim()) aliases[normalizeKey(alias)] = modelId.trim();
    }
    return aliases;
  } catch {
    return {};
  }
}

export function modelAliases(): Record<string, string> {
  return { ...catalogAliases(), ...BUILTIN_ALIASES, ...envAliases() };
}

/** Accepts an internal ID, a vendor name, or a tier alias; unknown values pass through untouched. */
export function normalizeModelName(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback.trim() ? normalizeModelName(fallback, "almond-croissant-low") : "almond-croissant-low";
  const aliases = modelAliases();
  return aliases[normalizeKey(raw)] ?? raw;
}

export function listModels(): Array<{ modelId: string; displayName: string; family: string; group: string; pickable: boolean; aliases: string[] }> {
  const aliases = modelAliases();
  const byModel = new Map<string, string[]>();
  for (const [alias, modelId] of Object.entries(aliases)) {
    if (alias === modelId) continue;
    byModel.set(modelId, [...(byModel.get(modelId) ?? []), alias]);
  }
  const known = MODEL_CATALOG.map((entry) => ({ ...entry, aliases: (byModel.get(entry.modelId) ?? []).sort() }));
  const extra = [...byModel.keys()].filter((modelId) => !KNOWN_MODEL_IDS.includes(modelId));
  return [
    ...known,
    ...extra.map((modelId) => ({ modelId, displayName: modelId, displayNameWithProvider: modelId, family: "unknown", group: "unknown", pickable: false, aliases: (byModel.get(modelId) ?? []).sort() }))
  ];
}
`;
fs.writeFileSync(process.env.HOME + "/notion-ai-mcp/src/models.ts", file);
console.log("wrote src/models.ts");
