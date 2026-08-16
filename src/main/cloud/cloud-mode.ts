import type { SecretStore } from "../settings/secret-store";
import { type WileySettings } from "../settings/settings-schema";
import { mintRealtimeToken, type RealtimeClientSecret } from "../voice-token";
import {
  CloudClient,
  CloudRequestError,
  normalizeRelayBaseUrl,
  type FetchLike,
} from "./cloud-client";

/**
 * Where the two account modes actually diverge. Everything here is pure enough
 * to test without a host: it takes a settings snapshot and a way to read a
 * secret, and answers "who signs this request".
 *
 * The one rule that is not negotiable: cloud mode never falls back to the
 * user's own key. Someone who chose the hosted path did not agree to have
 * their own OpenAI bill spent when the relay is down, so a cloud failure is
 * surfaced as a failure.
 */

export interface CloudHost {
  settings: WileySettings;
  /** Where the session token lives. Absent in a host with no secret store. */
  secrets?: Pick<SecretStore, "get">;
}

export interface CloudClientOverrides {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function isCloudMode(settings: WileySettings): boolean {
  return settings.auth.mode === "cloud";
}

/** The relay root, or a message saying exactly which setting is missing. */
export function cloudRelayBaseUrl(settings: WileySettings): string {
  const raw = settings.auth.relayBaseUrl.trim();
  if (!raw) {
    throw new CloudRequestError(
      "No Wiley Cloud relay base URL is set. Add one under Settings → Account, "
      + "or use your own API key.",
    );
  }
  return normalizeRelayBaseUrl(raw);
}

export function cloudSessionToken(host: CloudHost): string | undefined {
  return host.secrets?.get("cloudSessionToken")?.trim() || undefined;
}

/**
 * A client for the configured relay. Throws rather than returning undefined:
 * every caller is already in cloud mode by the time it asks, so "not
 * configured" is a problem to report, not a state to work around.
 */
export function createCloudClient(host: CloudHost, overrides: CloudClientOverrides = {}): CloudClient {
  return new CloudClient({
    baseUrl: cloudRelayBaseUrl(host.settings),
    getToken: () => Promise.resolve(cloudSessionToken(host)),
    ...overrides,
  });
}

/** A client only when the seam is both selected and configured. */
export function cloudClientIfReady(host: CloudHost, overrides: CloudClientOverrides = {}): CloudClient | undefined {
  if (!isCloudMode(host.settings)) return undefined;
  try {
    return createCloudClient(host, overrides);
  } catch {
    return undefined;
  }
}

export interface VoiceTokenHost extends CloudHost {
  /** The resolved BYO key. Unused in cloud mode, on purpose. */
  apiKey?: string;
}

/**
 * The single place either host mints a realtime client secret. Both branches
 * return the same shape, so the renderer's connect path is unchanged and its
 * CSP still only has to reach api.openai.com.
 */
export function mintConfiguredVoiceToken(
  host: VoiceTokenHost,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<RealtimeClientSecret> {
  const { settings } = host;
  if (isCloudMode(settings)) {
    const client = createCloudClient(host, options.fetch ? { fetch: options.fetch } : {});
    return client.mintRealtimeSecret({
      model: settings.voice.model,
      voice: settings.voice.voice,
      signal: options.signal,
    });
  }
  return mintRealtimeToken({
    model: settings.voice.model,
    voice: settings.voice.voice,
    apiKey: host.apiKey,
    signal: options.signal,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
