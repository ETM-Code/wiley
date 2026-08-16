import type { ModelOption } from "../settings/model-catalog";
import type { RealtimeClientSecret } from "../voice-token";

/**
 * The client half of the Wiley Cloud seam: a plain fetch wrapper around a
 * relay that holds the platform key, so a user on a hosted plan never has to
 * paste an OpenAI key.
 *
 * Only the main (or server) process ever constructs one. The renderer's CSP
 * pins connect-src to api.openai.com and must stay that way: the relay hands
 * back an OpenAI ephemeral secret, so the browser still talks to OpenAI
 * directly and never needs to reach the relay itself.
 */

export const DEFAULT_CLOUD_TIMEOUT_MS = 20_000;

/** Everything this module throws, so a caller can catch the family at once. */
export class CloudError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** The token was missing, rejected, or is not entitled to this call. */
export class CloudAuthError extends CloudError {}

/** The relay could not be reached, timed out, or failed on its own side. */
export class CloudUnavailableError extends CloudError {}

/** The relay understood the request and refused it for some other reason. */
export class CloudRequestError extends CloudError {}

/** What a cloud account looks like to the app. */
export interface CloudAccount {
  accountId: string;
  email?: string;
  tier?: string;
  usageThisPeriod?: {
    inputTokens?: number;
    outputTokens?: number;
    requests?: number;
  };
  limits?: {
    inputTokens?: number;
    outputTokens?: number;
    requests?: number;
  };
}

/** Injected so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | undefined>;
  fetch?: FetchLike;
  /** Per-request ceiling. A relay that hangs must not hang the app with it. */
  timeoutMs?: number;
}

export interface MintRealtimeSecretOptions {
  model?: string;
  voice?: string;
  signal?: AbortSignal;
}

/**
 * A relay base URL is the root of the service, without the `/v1` prefix: the
 * client adds it, and so does the Pi provider registration.
 */
export function normalizeRelayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new CloudRequestError("No relay base URL is configured.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CloudRequestError(`"${baseUrl}" is not a valid relay URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CloudRequestError(`A relay URL must be http or https, not ${parsed.protocol}`);
  }
  return trimmed;
}

/** The base URL an OpenAI-compatible SDK client should be pointed at. */
export function relayApiBaseUrl(baseUrl: string): string {
  return `${normalizeRelayBaseUrl(baseUrl)}/v1`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export class CloudClient {
  readonly #baseUrl: string;
  readonly #getToken: () => Promise<string | undefined>;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: CloudClientOptions) {
    this.#baseUrl = normalizeRelayBaseUrl(options.baseUrl);
    this.#getToken = options.getToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async mintRealtimeSecret(options: MintRealtimeSecretOptions = {}): Promise<RealtimeClientSecret> {
    const body = await this.#request<RealtimeClientSecret>("/v1/realtime/secret", {
      method: "POST",
      body: { model: options.model, voice: options.voice },
      signal: options.signal,
    });
    if (!body?.value) throw new CloudRequestError("The relay did not return a realtime client secret.");
    return body;
  }

  async getMe(options: { signal?: AbortSignal } = {}): Promise<CloudAccount> {
    const body = await this.#request<CloudAccount>("/v1/me", { method: "GET", signal: options.signal });
    if (!body?.accountId) throw new CloudRequestError("The relay did not return an account.");
    return body;
  }

  /** The models this account may run, in the shape the settings picker wants. */
  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelOption[]> {
    const body = await this.#request<{ models?: unknown }>("/v1/models", { method: "GET", signal: options.signal });
    const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) return [];
      const option: ModelOption = { id, provider: typeof record.provider === "string" ? record.provider : "wiley-cloud" };
      if (typeof record.name === "string") option.name = record.name;
      if (typeof record.reasoning === "boolean") option.reasoning = record.reasoning;
      if (typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow)) {
        option.contextWindow = record.contextWindow;
      }
      return [option];
    });
  }

  async #request<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const token = (await this.#getToken())?.trim();
    if (!token) {
      throw new CloudAuthError("No Wiley Cloud sign-in token is saved. Add one under Settings → Account.");
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers,
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      // A caller-owned abort is the caller's own business, so it passes through.
      if (options.signal?.aborted) throw error;
      if (isAbortError(error)) {
        throw new CloudUnavailableError(`The Wiley Cloud relay did not respond within ${this.#timeoutMs}ms.`);
      }
      throw new CloudUnavailableError(
        `Could not reach the Wiley Cloud relay at ${this.#baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) throw await describeFailure(response, this.#baseUrl);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CloudRequestError(`The Wiley Cloud relay returned a response that was not JSON (${response.status}).`);
    }
  }
}

async function describeFailure(response: Response, baseUrl: string): Promise<CloudError> {
  const detail = await response.text().then((text) => text.slice(0, 500)).catch(() => "");
  const suffix = detail ? `: ${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    return new CloudAuthError(
      `Wiley Cloud rejected the saved sign-in token (${response.status})${suffix}`,
      response.status,
    );
  }
  if (response.status >= 500) {
    return new CloudUnavailableError(`The Wiley Cloud relay at ${baseUrl} failed (${response.status})${suffix}`, response.status);
  }
  return new CloudRequestError(`Wiley Cloud refused the request (${response.status})${suffix}`, response.status);
}
