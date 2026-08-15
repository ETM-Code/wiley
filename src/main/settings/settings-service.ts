import type { SettingsView, WorkerProbes } from "../../shared/contracts";
import { listAvailableModels, type ModelCatalogRuntime, type ModelOption } from "./model-catalog";
import { resolveOpenAiKey, type SecretName } from "./secret-store";
import { type SettingsPatch, type WileySettings, WORKER_KINDS } from "./settings-schema";
import type { SettingsStore } from "./settings-store";

/**
 * Placeholder until the worker connector lands. It owns the real probe (does
 * the CLI exist, which version, can it be spawned), and replaces this.
 */
export function probeWorkersStub(): WorkerProbes {
  return Object.fromEntries(
    WORKER_KINDS.map((kind) => [kind, { available: false, reason: "probe not implemented" }]),
  ) as WorkerProbes;
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  /** Read lazily: the Pi runtime finishes initializing after the store opens. */
  modelRuntime?: () => ModelCatalogRuntime | undefined;
  env?: Record<string, string | undefined>;
  probeWorkers?: () => WorkerProbes | Promise<WorkerProbes>;
}

/**
 * The host-agnostic half of the settings surface. Both the Electron IPC layer
 * and the browser HTTP layer call into this, so the two shells cannot drift.
 */
export class SettingsService {
  #models?: ModelOption[];

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
    return {
      ...settings,
      secrets: {
        openaiApiKey: {
          present: Boolean(key.key),
          source: key.source,
          stored: key.source === "store" || key.envOverride,
          backend: this.options.store.secrets.backend,
        },
      },
      models: await this.models(settings),
      probes: await this.probeWorkers(),
    };
  }

  async update(patch: SettingsPatch): Promise<SettingsView> {
    this.options.store.update(patch);
    return this.view();
  }

  async setSecret(name: SecretName, value: string): Promise<SettingsView> {
    this.options.store.secrets.set(name, value);
    return this.view();
  }

  async clearSecret(name: SecretName): Promise<SettingsView> {
    this.options.store.secrets.clear(name);
    return this.view();
  }

  /** Cached once it succeeds: the catalog is a network read behind the SDK. */
  async models(settings = this.options.store.get()): Promise<ModelOption[]> {
    if (this.#models) return this.#models;
    const models = await listAvailableModels(this.options.modelRuntime?.(), { provider: settings.agent.provider });
    // Only cache a real answer, so a failed first read retries next time.
    if (this.options.modelRuntime?.()) this.#models = models;
    return models;
  }
}

/** Rejects anything that is not a known secret name before it reaches the store. */
export function assertSecretName(value: unknown): SecretName {
  if (value === "openaiApiKey" || value === "cloudSessionToken") return value;
  throw new Error(`Unknown secret: ${String(value)}`);
}
