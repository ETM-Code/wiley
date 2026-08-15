import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSecretStore, type SecretStore } from "./secret-store";
import { applyPatch, loadSettings, type SettingsPatch, type WileySettings } from "./settings-schema";

const SETTINGS_FILE = "settings.json";

export type SettingsListener = (settings: WileySettings) => void;

/**
 * The host-side owner of settings.json. Reads are synchronous snapshots so
 * request handlers never await, and every write goes through normalization so
 * a hand-edited file can never put the runtime into an impossible state.
 */
export class SettingsStore {
  readonly #file: string;
  #settings: WileySettings;
  #listeners = new Set<SettingsListener>();

  private constructor(
    readonly dir: string,
    readonly secrets: SecretStore,
    initial: WileySettings,
  ) {
    this.#file = path.join(dir, SETTINGS_FILE);
    this.#settings = initial;
  }

  static open(dir: string, secrets?: SecretStore): SettingsStore {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SETTINGS_FILE);
    return new SettingsStore(dir, secrets ?? createSecretStore({ dir }), readSettingsFile(file));
  }

  /** A normalized snapshot. Callers may read it freely; it is never mutated. */
  get(): WileySettings {
    return this.#settings;
  }

  update(patch: SettingsPatch): WileySettings {
    const next = applyPatch(this.#settings, patch);
    this.#settings = next;
    writeSettingsFile(this.#file, next);
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (error) {
        // One bad subscriber must not stop the others, nor the write above.
        console.error("A settings listener threw", error);
      }
    }
    return next;
  }

  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function readSettingsFile(file: string): WileySettings {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return loadSettings({});
  }
  try {
    return loadSettings(JSON.parse(raw));
  } catch {
    // Keep whatever the user had so they can recover their own edits, and
    // carry on with defaults rather than refusing to start.
    try {
      renameSync(file, `${file}.bad`);
    } catch (error) {
      console.error(`Could not preserve the corrupt settings file at ${file}`, error);
    }
    return loadSettings({});
  }
}

function writeSettingsFile(file: string, settings: WileySettings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * Where a host keeps its settings. Electron passes its own userData path; the
 * browser host and the CLI use WILEY_CONFIG_DIR, falling back to ~/.wiley.
 */
export function resolveConfigDir(options: { env?: Record<string, string | undefined>; home: string }): string {
  const configured = options.env?.WILEY_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(options.home, ".wiley");
}
