/**
 * The single source of truth for Wiley's user-configurable surface.
 *
 * Pure and dependency-free on purpose: the renderer, the Electron host, and the
 * browser host all normalize through the same code, so a hand-edited
 * settings.json, an old file from a previous version, and a patch from the UI
 * all converge on the same shape.
 */

export const SETTINGS_VERSION = 1;

export type VoiceReasoningEffort = "low" | "medium" | "high";
export const VOICE_REASONING_EFFORTS: readonly VoiceReasoningEffort[] = ["low", "medium", "high"];

export interface VoiceSettings {
  /** Realtime model id. Free text: the picker only suggests the known ones. */
  model: string;
  voice: string;
  reasoningEffort: VoiceReasoningEffort;
  transcriptionModel: string;
}

export type AgentThinkingLevel = "off" | "low" | "medium" | "high";
export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = ["off", "low", "medium", "high"];

export interface AgentSettings {
  provider: string;
  model: string;
  thinkingLevel: AgentThinkingLevel;
  /**
   * Latency over depth. While on, the root session runs at "low" thinking
   * regardless of thinkingLevel; see effectiveThinkingLevel.
   */
  fastMode: boolean;
  /** Falls back to `model` when unset. */
  subagentModel?: string;
  approvalEnabled: boolean;
  approvalModel: string;
  /** Models a spawned agent is allowed to run on. */
  allowedModels: string[];
}

export type WorkerSandbox = "read-only" | "workspace-write";
export const WORKER_SANDBOXES: readonly WorkerSandbox[] = ["read-only", "workspace-write"];

export type WorkerApprovalBridge = "canUseTool" | "hook" | "none";
export const WORKER_APPROVAL_BRIDGES: readonly WorkerApprovalBridge[] = ["canUseTool", "hook", "none"];

export type WorkerKind = "claude" | "codex";
export const WORKER_KINDS: readonly WorkerKind[] = ["claude", "codex"];

export const DEFAULT_DENY_RULES: readonly string[] = ["Bash(sudo *)", "Read(./.env)", "Read(./.env.*)"];

export const MIN_WORKER_CONCURRENCY = 1;
export const MAX_WORKER_CONCURRENCY = 8;
export const MIN_TURN_TIMEOUT_MS = 10_000;
export const MAX_TURN_TIMEOUT_MS = 3_600_000;

export interface WorkerSettings {
  enabled: boolean;
  /** Explicit binary path; the connector resolves from PATH when unset. */
  command?: string;
  model?: string;
  effort?: string;
  /** Claude Code only. */
  permissionMode?: string;
  /**
   * Codex only. "danger-full-access" is deliberately absent from the type:
   * Wiley never runs a worker outside a sandbox.
   */
  sandbox?: WorkerSandbox;
  allowedTools?: string[];
  disallowedTools?: string[];
  denyRules: string[];
  /**
   * Whether a worker's tool calls also get the approval judge's opinion.
   * "canUseTool" asks it for anything the engine would have prompted about;
   * "hook" and "none" skip the model. The hard floor (deny rules, the
   * catastrophic-command guard, the write scope) is not configurable and runs
   * on every call regardless.
   */
  approvalBridge: WorkerApprovalBridge;
  maxConcurrent: number;
  turnTimeoutMs: number;
  budgetUsd?: number;
  /** Extra directories a worker may touch, beyond the project dir. */
  extraDirs: string[];
}

export type AuthMode = "byok" | "cloud";
export const AUTH_MODES: readonly AuthMode[] = ["byok", "cloud"];

export interface AuthSettings {
  mode: AuthMode;
  relayBaseUrl: string;
  accountEmail?: string;
}

/** The provider id the app registers with the SDK when a relay is in use. */
export const CLOUD_PROVIDER_ID = "wiley-cloud";

export interface WileySettings {
  version: number;
  auth: AuthSettings;
  voice: VoiceSettings;
  agent: AgentSettings;
  workers: Record<WorkerKind, WorkerSettings>;
  /**
   * The workspace the agent may edit. Unset means the launch directory when
   * running from a checkout and ~/Wiley in a packaged app, which is the only
   * sane default for an app launched from Finder with "/" as its cwd. Read
   * once at startup, so a change takes effect the next time Wiley opens.
   */
  projectDir?: string;
  /**
   * Which terminal emulator a worker handoff opens in, by application name.
   * Free text rather than an enum: the panel offers what it found installed,
   * and an unlisted emulator should still be launchable by name.
   */
  terminalApp: string;
}

export const DEFAULT_VOICE_MODEL = "gpt-realtime-mini-2.1";
export const DEFAULT_VOICE_NAME = "marin";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

/**
 * The only model family Wiley runs agent work on. Everything the backend
 * offers, accepts, or spawns is checked against this one constant: the picker,
 * the allowlist, the approval judge, the relay registration, and the spawn
 * guard. Older families still exist in the provider's catalog and still answer
 * requests, which is exactly why the refusal has to be explicit rather than
 * left to whatever the catalog happens to return.
 *
 * Realtime voice models are a separate family with separate ids and are not
 * governed by this rule. Neither are claude or codex workers, which run on the
 * user's own CLI and its own model namespace.
 */
export const ALLOWED_MODEL_FAMILY = "gpt-5.6";

/** True for an id in the allowed family, and only for a well-formed one. */
export function isAllowedBackendModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const id = model.trim();
  return id === ALLOWED_MODEL_FAMILY || id.startsWith(`${ALLOWED_MODEL_FAMILY}-`);
}

export const DEFAULT_AGENT_MODEL = "gpt-5.6-luna";
/**
 * The judge reviews a tool call and answers in a sentence, so it wants the
 * cheapest model in the family: Luna is an order of magnitude below Terra and
 * Sol per token. The family ships no mini or nano variant, so this is also the
 * whole of the cheap end. The judge runs it at low reasoning effort; see
 * APPROVAL_REASONING_EFFORT.
 */
export const DEFAULT_APPROVAL_MODEL_ID = "gpt-5.6-luna";
/** Every mac has it, so the handoff always has somewhere to land. */
export const DEFAULT_TERMINAL_APP = "Terminal";

function defaultWorkerSettings(kind: WorkerKind): WorkerSettings {
  return {
    enabled: false,
    denyRules: [...DEFAULT_DENY_RULES],
    approvalBridge: "canUseTool",
    maxConcurrent: 2,
    turnTimeoutMs: 1_200_000,
    extraDirs: [],
    ...(kind === "claude" ? { permissionMode: "default" } : { sandbox: "workspace-write" as WorkerSandbox }),
  };
}

export const DEFAULT_SETTINGS: WileySettings = {
  version: SETTINGS_VERSION,
  auth: { mode: "byok", relayBaseUrl: "" },
  voice: {
    model: DEFAULT_VOICE_MODEL,
    voice: DEFAULT_VOICE_NAME,
    reasoningEffort: "low",
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  },
  agent: {
    provider: "openai",
    model: DEFAULT_AGENT_MODEL,
    thinkingLevel: "medium",
    fastMode: true,
    approvalEnabled: true,
    approvalModel: DEFAULT_APPROVAL_MODEL_ID,
    allowedModels: [...new Set([DEFAULT_AGENT_MODEL, DEFAULT_APPROVAL_MODEL_ID])],
  },
  workers: {
    claude: defaultWorkerSettings("claude"),
    codex: defaultWorkerSettings("codex"),
  },
  terminalApp: DEFAULT_TERMINAL_APP,
};

/**
 * Which provider the agent actually runs on. Derived from the account mode
 * rather than stored alongside it, so choosing the hosted path is one switch
 * instead of two that can disagree with each other.
 */
export function effectiveProvider(settings: WileySettings): string {
  return settings.auth.mode === "cloud" ? CLOUD_PROVIDER_ID : settings.agent.provider;
}

/** Fast mode trades depth for latency, so it wins over the stored level. */
export function effectiveThinkingLevel(settings: AgentSettings | WileySettings): AgentThinkingLevel {
  const agent = "agent" in settings ? settings.agent : settings;
  return agent.fastMode ? "low" : agent.thinkingLevel;
}

/** The model a spawned agent should run on, before allowlist enforcement. */
export function subagentModelFor(settings: AgentSettings | WileySettings): string {
  const agent = "agent" in settings ? settings.agent : settings;
  return agent.subagentModel ?? agent.model;
}

export type SettingsPatch = DeepPartial<WileySettings>;

/** `null` is meaningful here: it clears a field back to its default. */
export type DeepPartial<T> = T extends Array<infer U>
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Patch semantics for settings: objects merge key by key, arrays and scalars
 * replace wholesale. `undefined` in the patch means "leave alone"; `null`
 * clears an optional field back to its default.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch as T;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged as T;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function optionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const cleaned = value.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(cleaned)];
}

/** An empty list would block every spawn, which is never what a user meant. */
function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const cleaned = strings(value, fallback);
  return cleaned.length ? cleaned : [...fallback];
}

function optionalStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return strings(value, []);
}

function normalizeAuth(raw: unknown): AuthSettings {
  const source = isPlainObject(raw) ? raw : {};
  const relayBaseUrl = typeof source.relayBaseUrl === "string"
    ? source.relayBaseUrl.trim()
    : DEFAULT_SETTINGS.auth.relayBaseUrl;
  const mode = oneOf(source.mode, AUTH_MODES, DEFAULT_SETTINGS.auth.mode);
  const auth: AuthSettings = {
    // Cloud mode with no relay to talk to is not a state the app can act on:
    // nothing could be minted and no model could be resolved. It normalizes
    // back to the local path so an unconfigured relay leaves the product
    // working exactly as it does without one.
    mode: relayBaseUrl ? mode : "byok",
    relayBaseUrl,
  };
  const accountEmail = optionalStr(source.accountEmail);
  if (accountEmail) auth.accountEmail = accountEmail;
  return auth;
}

function normalizeVoice(raw: unknown): VoiceSettings {
  const source = isPlainObject(raw) ? raw : {};
  return {
    model: str(source.model, DEFAULT_SETTINGS.voice.model),
    voice: str(source.voice, DEFAULT_SETTINGS.voice.voice),
    reasoningEffort: oneOf(source.reasoningEffort, VOICE_REASONING_EFFORTS, DEFAULT_SETTINGS.voice.reasoningEffort),
    transcriptionModel: str(source.transcriptionModel, DEFAULT_SETTINGS.voice.transcriptionModel),
  };
}

/** Anything outside the family becomes the default, rather than persisting. */
function familyModel(value: unknown, fallback: string): string {
  const id = str(value, fallback);
  return isAllowedBackendModel(id) ? id : fallback;
}

function normalizeAgent(raw: unknown): AgentSettings {
  const source = isPlainObject(raw) ? raw : {};
  const model = familyModel(source.model, DEFAULT_SETTINGS.agent.model);
  const approvalModel = familyModel(source.approvalModel, DEFAULT_SETTINGS.agent.approvalModel);
  const rawSubagentModel = optionalStr(source.subagentModel);
  // An out-of-family worker model clears rather than clamping: unset already
  // means "same as the root model", which is the right place to land.
  const subagentModel = rawSubagentModel && isAllowedBackendModel(rawSubagentModel) ? rawSubagentModel : undefined;
  // Never widened, only narrowed: the allowlist is the user's answer to "what
  // may Wiley spawn work on", so entries survive as written unless they name a
  // model outside the family, which the app will not run at all.
  const allowedModels = nonEmptyStrings(
    strings(source.allowedModels, DEFAULT_SETTINGS.agent.allowedModels).filter(isAllowedBackendModel),
    DEFAULT_SETTINGS.agent.allowedModels,
  );
  const agent: AgentSettings = {
    provider: str(source.provider, DEFAULT_SETTINGS.agent.provider),
    model,
    thinkingLevel: oneOf(source.thinkingLevel, AGENT_THINKING_LEVELS, DEFAULT_SETTINGS.agent.thinkingLevel),
    fastMode: bool(source.fastMode, DEFAULT_SETTINGS.agent.fastMode),
    approvalEnabled: bool(source.approvalEnabled, DEFAULT_SETTINGS.agent.approvalEnabled),
    approvalModel,
    allowedModels,
  };
  if (subagentModel) agent.subagentModel = subagentModel;
  return agent;
}

function normalizeWorker(raw: unknown, kind: WorkerKind): WorkerSettings {
  const source = isPlainObject(raw) ? raw : {};
  const defaults = defaultWorkerSettings(kind);
  const worker: WorkerSettings = {
    enabled: bool(source.enabled, defaults.enabled),
    denyRules: strings(source.denyRules, defaults.denyRules),
    approvalBridge: oneOf(source.approvalBridge, WORKER_APPROVAL_BRIDGES, defaults.approvalBridge),
    maxConcurrent: clamp(source.maxConcurrent, MIN_WORKER_CONCURRENCY, MAX_WORKER_CONCURRENCY, defaults.maxConcurrent),
    turnTimeoutMs: clamp(source.turnTimeoutMs, MIN_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS, defaults.turnTimeoutMs),
    extraDirs: strings(source.extraDirs, defaults.extraDirs),
  };
  const command = optionalStr(source.command);
  if (command) worker.command = command;
  const model = optionalStr(source.model);
  if (model) worker.model = model;
  const effort = optionalStr(source.effort);
  if (effort) worker.effort = effort;
  const allowedTools = optionalStrings(source.allowedTools);
  if (allowedTools) worker.allowedTools = allowedTools;
  const disallowedTools = optionalStrings(source.disallowedTools);
  if (disallowedTools) worker.disallowedTools = disallowedTools;
  if (typeof source.budgetUsd === "number" && Number.isFinite(source.budgetUsd) && source.budgetUsd >= 0) {
    worker.budgetUsd = source.budgetUsd;
  }
  if (kind === "claude") {
    const permissionMode = optionalStr(source.permissionMode) ?? defaults.permissionMode;
    if (permissionMode) worker.permissionMode = permissionMode;
  } else {
    // Unknown or escalated sandbox values fall back to the sandboxed default.
    worker.sandbox = optionalOneOf(source.sandbox, WORKER_SANDBOXES) ?? defaults.sandbox;
  }
  return worker;
}

/** Fills defaults, clamps ranges, coerces bad enums, and drops unknown keys. */
export function normalizeSettings(raw: unknown): WileySettings {
  const source = isPlainObject(raw) ? raw : {};
  const workers = isPlainObject(source.workers) ? source.workers : {};
  const settings: WileySettings = {
    version: SETTINGS_VERSION,
    auth: normalizeAuth(source.auth),
    voice: normalizeVoice(source.voice),
    agent: normalizeAgent(source.agent),
    workers: {
      claude: normalizeWorker(workers.claude, "claude"),
      codex: normalizeWorker(workers.codex, "codex"),
    },
    terminalApp: str(source.terminalApp, DEFAULT_TERMINAL_APP),
  };
  const projectDir = optionalStr(source.projectDir);
  if (projectDir) settings.projectDir = projectDir;
  return settings;
}

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Indexed by the version being migrated *from*. A file with no version is
 * treated as v0, which is exactly what pre-settings installs produce.
 */
const MIGRATIONS: Record<number, Migration> = {
  0: (raw) => ({ ...raw, version: 1 }),
};

/** Walks a raw settings object up to SETTINGS_VERSION. Normalization is separate. */
export function migrateSettings(raw: unknown): Record<string, unknown> {
  let current: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
  let version = typeof current.version === "number" && Number.isFinite(current.version)
    ? Math.max(0, Math.floor(current.version))
    : 0;
  while (version < SETTINGS_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) break;
    current = migrate(current);
    version += 1;
  }
  current.version = SETTINGS_VERSION;
  return current;
}

/** Load path: migrate the stored shape, then normalize it into a usable one. */
export function loadSettings(raw: unknown): WileySettings {
  return normalizeSettings(migrateSettings(raw));
}

/** Update path: merge the patch onto a known-good base, then re-validate. */
export function applyPatch(base: WileySettings, patch: SettingsPatch): WileySettings {
  return normalizeSettings(deepMerge(base as unknown as Record<string, unknown>, patch));
}

/**
 * The dotted paths that actually differ, which is not the same as the paths a
 * patch named: normalization clamps, coerces, and drops, so what the caller
 * asked for and what landed can differ. Reporting the difference is what makes
 * "it did not take" visible instead of silent.
 */
export function changedSettingsPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .flatMap((key) => changedSettingsPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [prefix];
}
