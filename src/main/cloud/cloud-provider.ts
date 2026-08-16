import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";

import { CLOUD_PROVIDER_ID, subagentModelFor, type WileySettings } from "../settings/settings-schema";
import { relayApiBaseUrl } from "./cloud-client";

/**
 * Registering the relay with the Pi SDK as an ordinary OpenAI-compatible
 * provider. Nothing else in the runtime has to know a relay exists: sessions
 * resolve `wiley-cloud/<model>` the same way they resolve `openai/<model>`,
 * and the request goes to the relay with the account's session token instead
 * of the user's own key.
 */

/** Derived from the SDK rather than restated, so a signature change is caught. */
type ProviderRegistration = Parameters<ModelRuntime["registerProvider"]>[1];
type CloudModelEntry = NonNullable<ProviderRegistration["models"]>[number];

export const CLOUD_PROVIDER_NAME = "Wiley Cloud";

/**
 * The relay proxies POST /v1/responses, which is the endpoint this api id
 * drives, so cloud models behave exactly like their openai counterparts.
 */
export const CLOUD_PROVIDER_API = "openai-responses";

/**
 * Only reached for a model the SDK has never heard of. Zeroed cost is the
 * honest default there: the relay is billing the account, and inventing a
 * rate would put a made-up number in the ledger.
 */
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_000;

/** The slice of a catalog model this module copies onto a cloud entry. */
type UpstreamModel = Partial<Omit<CloudModelEntry, "id" | "api" | "baseUrl" | "headers">>;

const lookupUpstream = getModel as unknown as (provider: string, id: string) => UpstreamModel | undefined;

/**
 * Every model the runtime may be asked to resolve while a hosted account is
 * in use: what the root and workers run on, the approval judge, and whatever
 * else the user allowlisted. The relay enforces its own allowlist regardless;
 * this is what the local session factory needs in order to resolve a name.
 */
export function cloudModelIds(settings: WileySettings): string[] {
  return [...new Set([
    settings.agent.model,
    subagentModelFor(settings),
    settings.agent.approvalModel,
    ...settings.agent.allowedModels,
  ])].filter(Boolean);
}

/** One model entry, taking the upstream catalog's numbers when it knows them. */
export function cloudModelEntry(id: string, upstreamProvider = "openai"): CloudModelEntry {
  const upstream = lookupUpstream(upstreamProvider, id);
  const entry: CloudModelEntry = {
    id,
    name: upstream?.name ?? id,
    reasoning: upstream?.reasoning ?? true,
    input: upstream?.input ?? ["text", "image"],
    cost: upstream?.cost ?? { ...DEFAULT_COST },
    contextWindow: upstream?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: upstream?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (upstream?.thinkingLevelMap) entry.thinkingLevelMap = upstream.thinkingLevelMap;
  if (upstream?.compat) entry.compat = upstream.compat;
  return entry;
}

export interface CloudProviderInput {
  settings: WileySettings;
  /** The account's session token. Absent registers the provider unauthenticated. */
  token?: string;
}

export function cloudProviderRegistration(input: CloudProviderInput): ProviderRegistration {
  const registration: ProviderRegistration = {
    name: CLOUD_PROVIDER_NAME,
    baseUrl: relayApiBaseUrl(input.settings.auth.relayBaseUrl),
    api: CLOUD_PROVIDER_API,
    models: cloudModelIds(input.settings).map((id) => cloudModelEntry(id)),
  };
  if (input.token) registration.apiKey = input.token;
  return registration;
}

/**
 * A fingerprint of everything that would change the registration, so the
 * runtime can skip re-registering on every unrelated settings change.
 */
export function cloudProviderFingerprint(input: CloudProviderInput): string {
  return JSON.stringify([
    CLOUD_PROVIDER_ID,
    input.settings.auth.relayBaseUrl,
    input.token ?? "",
    cloudModelIds(input.settings),
  ]);
}
