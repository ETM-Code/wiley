import {
  AGENT_THINKING_LEVELS,
  ALLOWED_MODEL_FAMILY,
  DEFAULT_AGENT_MODEL,
  DEFAULT_VOICE_MODEL,
  isAllowedBackendModel,
  type AgentThinkingLevel,
} from "./settings-schema";

export { ALLOWED_MODEL_FAMILY, isAllowedBackendModel };

/**
 * What the settings UI needs to know about a model. Deliberately structural
 * rather than the SDK's Model type: the catalog is data for a dropdown, and
 * keeping it plain lets the renderer and the tests handle it without the SDK.
 */
export interface ModelOption {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevels?: AgentThinkingLevel[];
}

/** The shape of a pi-ai Model that this module actually reads. */
export interface CatalogModel {
  id: string;
  provider?: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

/** The slice of ModelRuntime the catalog depends on. */
export interface ModelCatalogRuntime {
  getAvailable(providerId?: string): Promise<readonly CatalogModel[]>;
  getModels?(providerId?: string): readonly CatalogModel[];
}

/**
 * Shown when the SDK cannot answer: an offline first launch, a missing key, or
 * a catalog fetch failure. An empty dropdown would look like a broken app.
 * The allowed family as it stands, in id order like every catalog answer.
 */
export const FALLBACK_MODELS: readonly ModelOption[] = [
  { id: DEFAULT_AGENT_MODEL, name: "GPT-5.6 Luna" },
  { id: `${ALLOWED_MODEL_FAMILY}-sol`, name: "GPT-5.6 Sol" },
  { id: `${ALLOWED_MODEL_FAMILY}-terra`, name: "GPT-5.6 Terra" },
].map(({ id, name }) => ({
  id,
  provider: "openai",
  name,
  reasoning: true,
  thinkingLevels: ["off", "low", "medium", "high"] as AgentThinkingLevel[],
}));

/**
 * Known realtime models, cheapest first: the mini is the default because it
 * holds a conversation well enough for dispatch duty at a fraction of the
 * price. The picker also accepts free text, because OpenAI ships new realtime
 * ids faster than this list can be updated.
 */
export const VOICE_MODEL_OPTIONS: readonly string[] = [DEFAULT_VOICE_MODEL, "gpt-realtime-2.1"];

export const VOICE_NAME_OPTIONS: readonly string[] = ["marin", "cedar", "alloy", "shimmer", "verse"];

function thinkingLevelsOf(model: CatalogModel): AgentThinkingLevel[] | undefined {
  if (model.reasoning === false) return ["off"];
  const map = model.thinkingLevelMap;
  if (!map) return undefined;
  // A null entry marks a level the model explicitly does not support.
  const supported = AGENT_THINKING_LEVELS.filter((level) => level in map && map[level] !== null);
  return supported.length ? [...supported] : undefined;
}

function toOption(model: CatalogModel, fallbackProvider: string): ModelOption {
  const option: ModelOption = { id: model.id, provider: model.provider ?? fallbackProvider };
  if (model.name) option.name = model.name;
  if (typeof model.reasoning === "boolean") option.reasoning = model.reasoning;
  if (typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)) {
    option.contextWindow = model.contextWindow;
  }
  const thinkingLevels = thinkingLevelsOf(model);
  if (thinkingLevels) option.thinkingLevels = thinkingLevels;
  return option;
}

/**
 * One provider answer turned into a picker list: family rule, then dedupe,
 * then id order. The family rule belongs here rather than at the picker
 * because the catalog is what the app offers, and the SDK lists every model
 * the key can reach, most of them families Wiley does not run agent work on.
 */
function toCatalog(options: ModelOption[]): ModelOption[] {
  const byKey = new Map<string, ModelOption>();
  for (const option of options) {
    if (!option.id || !isAllowedBackendModel(option.id)) continue;
    byKey.set(`${option.provider}/${option.id}`, option);
  }
  return [...byKey.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/**
 * Asks the SDK what this install can actually run, and degrades to the static
 * list rather than surfacing an SDK failure as an empty picker.
 */
export async function listAvailableModels(
  runtime: ModelCatalogRuntime | undefined,
  options: { provider?: string } = {},
): Promise<ModelOption[]> {
  const provider = options.provider ?? "openai";
  if (!runtime) return [...FALLBACK_MODELS];
  try {
    const available = await runtime.getAvailable(provider);
    const mapped = toCatalog(available.map((model) => toOption(model, provider)));
    if (mapped.length) return mapped;
  } catch (error) {
    console.error("Could not read the model catalog from the Pi SDK", error);
  }
  try {
    const known = runtime.getModels?.(provider) ?? [];
    const mapped = toCatalog(known.map((model) => toOption(model, provider)));
    if (mapped.length) return mapped;
  } catch (error) {
    console.error("Could not read the static model list from the Pi SDK", error);
  }
  return [...FALLBACK_MODELS];
}

export function findModelOption(models: readonly ModelOption[], id: string): ModelOption | undefined {
  return models.find((model) => model.id === id);
}

/**
 * Keeps a requested thinking level within what the model can do: the highest
 * supported level at or below the request, or the lowest one it does support.
 */
export function clampThinkingLevel(
  model: ModelOption | undefined,
  level: AgentThinkingLevel,
): AgentThinkingLevel {
  if (!model) return level;
  if (model.reasoning === false) return "off";
  const supported = model.thinkingLevels;
  if (!supported?.length || supported.includes(level)) return level;
  const ordered = AGENT_THINKING_LEVELS.filter((candidate) => supported.includes(candidate));
  if (!ordered.length) return level;
  const requestedIndex = AGENT_THINKING_LEVELS.indexOf(level);
  for (let index = requestedIndex; index >= 0; index--) {
    const candidate = AGENT_THINKING_LEVELS[index];
    if (ordered.includes(candidate)) return candidate;
  }
  return ordered[0];
}
