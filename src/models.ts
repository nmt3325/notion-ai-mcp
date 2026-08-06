/** Friendly model-name handling for Notion AI's internal model IDs. */

/** Internal model IDs confirmed against the Notion web client. */
export const KNOWN_MODEL_IDS = ["almond-croissant-low", "almond-croissant", "oatmeal-cookie"] as const;

const BUILTIN_ALIASES: Record<string, string> = {
  fast: "almond-croissant-low",
  default: "almond-croissant-low",
  "notion-fast": "almond-croissant-low",
  standard: "almond-croissant",
  balanced: "almond-croissant",
  "notion-standard": "almond-croissant",
  thinking: "oatmeal-cookie",
  reasoning: "oatmeal-cookie",
  deep: "oatmeal-cookie",
  "notion-thinking": "oatmeal-cookie"
};

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function envAliases(): Record<string, string> {
  const raw = process.env.NOTION_MODEL_ALIASES?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const table: Record<string, string> = {};
  for (const [alias, modelId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof modelId === "string" && modelId.trim()) table[normalizeKey(alias)] = modelId.trim();
  }
  return table;
}

/** Alias table: friendly name -> internal model ID. NOTION_MODEL_ALIASES overrides builtins. */
export function modelAliases(): Record<string, string> {
  return { ...BUILTIN_ALIASES, ...envAliases() };
}

/** Accepts a friendly name or a raw internal ID; unknown values pass through unchanged. */
export function normalizeModelName(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return normalizeModelName(fallback, "almond-croissant-low");
  return modelAliases()[normalizeKey(raw)] ?? raw;
}

export function listModels(): Array<{ modelId: string; aliases: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const id of KNOWN_MODEL_IDS) grouped.set(id, []);
  for (const [alias, modelId] of Object.entries(modelAliases())) {
    grouped.set(modelId, [...(grouped.get(modelId) ?? []), alias]);
  }
  return [...grouped.entries()].map(([modelId, aliases]) => ({ modelId, aliases: [...aliases].sort() }));
}
