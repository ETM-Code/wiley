import type { SettingsView, WorkerProbes } from "../../shared/contracts";
import { createTerminalAppDetector } from "../workers/terminal-handoff";
import { listAvailableModels, type ModelCatalogRuntime, type ModelOption } from "./model-catalog";
import { resolveOpenAiKey, type SecretName } from "./secret-store";
import { effectiveProvider, type SettingsPatch, type WileySettings, WORKER_KINDS } from "./settings-schema";
import type { SettingsStore } from "./settings-store";

/**
 * The answer when a host wires up no probe of its own. Both real hosts inject
 * the worker connector's probe; this keeps a headless or test harness honest
 * rather than letting it claim a CLI is available without having looked.
 */
export function probeWorkersStub(): WorkerProbes {
  return Object.fromEntries(
    WORKER_KINDS.map((kind) => [kind, { available: false, reason: "this host does not check for worker CLIs" }]),
  ) as WorkerProbes;
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  /** Read lazily: the Pi runtime finishes initializing after the store opens. */
  modelRuntime?: () => ModelCatalogRuntime | undefined;
  env?: Record<string, string | undefined>;
  probeWorkers?: () => WorkerProbes | Promise<WorkerProbes>;
  /** Injected so a test can describe a machine without owning one. */
  terminalApps?: () => string[];
}

/**
 * The host-agnostic half of the settings surface. Both the Electron IPC layer
 * and the browser HTTP layer call into this, so the two shells cannot drift.
 */
export class SettingsService {
  #models?: ModelOption[];
  #modelsProvider?: string;
  readonly #detectTerminalApps = createTerminalAppDetector();

  constructor(private readonly options: SettingsServiceOptions) {}

  get store(): SettingsStore {
    return this.options.store;
  }

  get settings(): WileySettings {
    return this.options.store.get();
  }

  /** The resolved OpenAI key, env first. Host-side only; never serialized. */
  resolveApiKey(): ReturnType<typeof resolveOpenAiKey> {
    return resolveOpenAiKey({
      env: this.options.env ?? process.env,
      store: this.options.store.secrets,
    });
  }

  async probeWorkers(): Promise<WorkerProbes> {
    return (await this.options.probeWorkers?.()) ?? probeWorkersStub();
  }

  async view(): Promise<SettingsView> {
    const settings = this.options.store.get();
    const key = this.resolveApiKey();
    const backend = this.options.store.secrets.backend;
    return {
      ...settings,
      secrets: {
        openaiApiKey: {
          present: Boolean(key.key),
          source: key.source,
          stored: key.source === "store" || key.envOverride,
          backend,
        },
        cloudSessionToken: {
          stored: Boolean(this.options.store.secrets.get("cloudSessionToken")),
          backend,
        },
      },
      models: await this.models(settings),
      probes: await this.probeWorkers(),
      terminalApps: this.terminalApps(),
    };
  }

  /** Cheap enough to answer on every view: a handful of existsSync calls. */
  terminalApps(): string[] {
    return (this.options.terminalApps ?? this.#detectTerminalApps)();
  }

  async update(patch: SettingsPatch): Promise<SettingsView> {
    this.options.store.update(patch);
    return this.view();
  }

  async setSecret(name: SecretName, value: string): Promise<SettingsView> {
    this.options.store.secrets.set(name, value);
    // A saved credential is a configuration change even though settings.json
    // did not move, so the runtime re-reads which key it should be using.
    this.options.store.notifyChanged();
    return this.view();
  }

  async clearSecret(name: SecretName): Promise<SettingsView> {
    this.options.store.secrets.clear(name);
    this.options.store.notifyChanged();
    return this.view();
  }

  /** Cached once it succeeds: the catalog is a network read behind the SDK. */
  async models(settings = this.options.store.get()): Promise<ModelOption[]> {
    // Switching between a local key and a hosted account changes which
    // provider's catalog applies, so the cache is keyed on it.
    const provider = effectiveProvider(settings);
    if (this.#models && provider === this.#modelsProvider) return this.#models;
    const models = await listAvailableModels(this.options.modelRuntime?.(), { provider });
    // Only cache a real answer, so a failed first read retries next time.
    if (this.options.modelRuntime?.()) {
      this.#models = models;
      this.#modelsProvider = provider;
    }
    return models;
  }
}

/**
 * Key names a settings patch must never carry. Settings hold no secret values
 * at all (those live in the secret store, behind their own calls), so a patch
 * naming one is either a mistake or an attempt, and both deserve a refusal
 * rather than a silent drop during normalization.
 */
const SECRET_PATCH_KEYS: ReadonlySet<string> = new Set([
  "secrets",
  "secret",
  "openaiapikey",
  "cloudsessiontoken",
  "apikey",
  "token",
  "password",
]);

export function assertNoSecretPaths(patch: unknown, path = "settings"): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    if (SECRET_PATCH_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `${path}.${key} cannot be changed this way. API keys and tokens are entered by the user `
        + "in Settings and never travel through a settings patch.",
      );
    }
    assertNoSecretPaths(value, `${path}.${key}`);
  }
}

/** Rejects anything that is not a known secret name before it reaches the store. */
export function assertSecretName(value: unknown): SecretName {
  if (value === "openaiApiKey" || value === "cloudSessionToken") return value;
  throw new Error(`Unknown secret: ${String(value)}`);
}
