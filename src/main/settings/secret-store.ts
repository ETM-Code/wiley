import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Secrets live beside settings.json but never inside it: settings are sent to
 * the renderer, secrets never are. The renderer only ever learns whether a
 * secret is present and where it came from.
 */
export type SecretName = "openaiApiKey" | "cloudSessionToken";

export const SECRET_NAMES: readonly SecretName[] = ["openaiApiKey", "cloudSessionToken"];

export type SecretBackend = "safeStorage" | "file";

export interface SecretDescription {
  present: boolean;
  backend: SecretBackend;
}

export interface SecretStore {
  readonly backend: SecretBackend;
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
  clear(name: SecretName): void;
  describe(): Record<SecretName, SecretDescription>;
}

/** Only the Electron surface this store touches, so tests need no Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SECRETS_FILE = "secrets.json";

type StoredSecret = { enc: "safeStorage" | "plain"; value: string };
type SecretsFile = Partial<Record<SecretName, StoredSecret>>;

function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

function readSecretsFile(file: string): SecretsFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt secrets file is treated as empty. Overwriting it is the user's
    // next action anyway, and refusing to boot over it helps nobody.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const entries: SecretsFile = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSecretName(key) || !value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.value !== "string") continue;
    entries[key] = {
      enc: record.enc === "safeStorage" ? "safeStorage" : "plain",
      value: record.value,
    };
  }
  return entries;
}

/** Temp file plus rename, so a crash mid-write never truncates the real file. */
function writeSecretsFile(file: string, contents: SecretsFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode is filtered through the umask, so restate it.
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export interface FileSecretStoreOptions {
  dir: string;
  /** The host the API that would accept a new secret is bound to. */
  host?: string;
  /**
   * Writing a plaintext secret through a non-loopback listener would put it on
   * the wire, so the caller has to opt in explicitly.
   */
  allowRemoteHost?: boolean;
}

/** Plaintext JSON at 0600. The fallback when OS encryption is unavailable. */
export class FileSecretStore implements SecretStore {
  readonly backend: SecretBackend = "file";
  readonly #file: string;
  readonly #host?: string;
  readonly #allowRemoteHost: boolean;

  constructor(options: FileSecretStoreOptions) {
    this.#file = path.join(options.dir, SECRETS_FILE);
    this.#host = options.host;
    this.#allowRemoteHost = options.allowRemoteHost ?? false;
  }

  get(name: SecretName): string | undefined {
    return readSecretsFile(this.#file)[name]?.value || undefined;
  }

  set(name: SecretName, value: string): void {
    if (this.#host && !this.#allowRemoteHost && !isLoopbackHost(this.#host)) {
      throw new Error(
        `Refusing to store a secret while Wiley is reachable on ${this.#host}. `
        + "Bind the server to a loopback address, or opt in explicitly.",
      );
    }
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Refusing to store an empty ${name}`);
    writeSecretsFile(this.#file, { ...readSecretsFile(this.#file), [name]: { enc: "plain", value: trimmed } });
  }

  clear(name: SecretName): void {
    const contents = readSecretsFile(this.#file);
    if (!(name in contents)) return;
    delete contents[name];
    if (Object.keys(contents).length === 0) {
      try {
        unlinkSync(this.#file);
        return;
      } catch {
        // Fall through and write the empty object instead.
      }
    }
    writeSecretsFile(this.#file, contents);
  }

  describe(): Record<SecretName, SecretDescription> {
    const contents = readSecretsFile(this.#file);
    return Object.fromEntries(
      SECRET_NAMES.map((name) => [name, { present: Boolean(contents[name]?.value), backend: this.backend }]),
    ) as Record<SecretName, SecretDescription>;
  }
}

export interface SafeStorageSecretStoreOptions {
  dir: string;
  /** Injected so this module never imports Electron and stays unit-testable. */
  safeStorage: SafeStorageLike;
}

/** OS-keychain-backed: values are encrypted, then base64'd into secrets.json. */
export class SafeStorageSecretStore implements SecretStore {
  readonly backend: SecretBackend = "safeStorage";
  readonly #file: string;
  readonly #safeStorage: SafeStorageLike;

  constructor(options: SafeStorageSecretStoreOptions) {
    if (!options.safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is unavailable; use createSecretStore for the plaintext fallback");
    }
    this.#file = path.join(options.dir, SECRETS_FILE);
    this.#safeStorage = options.safeStorage;
  }

  get(name: SecretName): string | undefined {
    const stored = readSecretsFile(this.#file)[name];
    if (!stored?.value) return undefined;
    if (stored.enc === "plain") return stored.value;
    try {
      return this.#safeStorage.decryptString(Buffer.from(stored.value, "base64")) || undefined;
    } catch {
      // A key from another machine or another OS user cannot be decrypted here.
      return undefined;
    }
  }

  set(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Refusing to store an empty ${name}`);
    const encrypted = this.#safeStorage.encryptString(trimmed).toString("base64");
    writeSecretsFile(this.#file, {
      ...readSecretsFile(this.#file),
      [name]: { enc: "safeStorage", value: encrypted },
    });
  }

  clear(name: SecretName): void {
    const contents = readSecretsFile(this.#file);
    if (!(name in contents)) return;
    delete contents[name];
    writeSecretsFile(this.#file, contents);
  }

  describe(): Record<SecretName, SecretDescription> {
    const contents = readSecretsFile(this.#file);
    return Object.fromEntries(
      SECRET_NAMES.map((name) => [name, { present: Boolean(contents[name]?.value), backend: this.backend }]),
    ) as Record<SecretName, SecretDescription>;
  }
}

export interface CreateSecretStoreOptions extends FileSecretStoreOptions {
  /** Absent (browser host) or unavailable (headless Linux) falls back to file. */
  safeStorage?: SafeStorageLike;
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  const { safeStorage, ...fileOptions } = options;
  if (safeStorage?.isEncryptionAvailable()) {
    return new SafeStorageSecretStore({ dir: options.dir, safeStorage });
  }
  return new FileSecretStore(fileOptions);
}

export type OpenAiKeySource = "env" | "store" | "none";

export interface ResolvedOpenAiKey {
  key?: string;
  source: OpenAiKeySource;
  /** True when .env is shadowing whatever the user typed into settings. */
  envOverride: boolean;
}

/**
 * The env var wins so a developer's .env keeps working exactly as before, and
 * the UI can say so out loud instead of silently ignoring a saved key.
 */
export function resolveOpenAiKey(options: {
  env?: Record<string, string | undefined>;
  store?: Pick<SecretStore, "get">;
}): ResolvedOpenAiKey {
  const fromEnv = options.env?.OPENAI_API_KEY?.trim();
  const stored = options.store?.get("openaiApiKey")?.trim();
  if (fromEnv) return { key: fromEnv, source: "env", envOverride: Boolean(stored) };
  if (stored) return { key: stored, source: "store", envOverride: false };
  return { source: "none", envOverride: false };
}
