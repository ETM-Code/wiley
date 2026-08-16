import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUD_PROVIDER_API,
  CLOUD_PROVIDER_NAME,
  cloudModelEntry,
  cloudModelIds,
  cloudProviderFingerprint,
  cloudProviderRegistration,
} from "../src/main/cloud/cloud-provider";
import { DEFAULT_APPROVAL_MODEL } from "../src/main/pi/constants";
import { createApprovalJudge } from "../src/main/pi/safety-extension";
import { resolveSessionModels } from "../src/main/pi/session-models";
import { CLOUD_PROVIDER_ID, loadSettings, type WileySettings } from "../src/main/settings/settings-schema";

function cloudSettings(overrides: Record<string, unknown> = {}): WileySettings {
  return loadSettings({
    auth: { mode: "cloud", relayBaseUrl: "https://relay.example.com" },
    ...overrides,
  });
}

describe("cloud model list", () => {
  it("covers everything a session could ask the runtime to resolve", () => {
    const settings = cloudSettings({
      agent: {
        model: "gpt-5.6-luna",
        subagentModel: "gpt-5.6-sol",
        approvalModel: "gpt-5.6-terra",
        allowedModels: ["gpt-5.6-luna", "gpt-5.6-sol", "extra-model"],
      },
    });
    expect(cloudModelIds(settings)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("never registers a model from outside the allowed family", () => {
    const settings = cloudSettings({
      agent: { model: "gpt-5.6-luna", allowedModels: ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-4o"] },
    });
    expect(cloudModelIds(settings)).toEqual(["gpt-5.6-luna"]);
  });

  it("falls back to the root model for workers when none is set", () => {
    expect(cloudModelIds(cloudSettings())).toContain("gpt-5.6-luna");
  });

  it("copies the upstream catalog's numbers for a model the SDK knows", () => {
    const entry = cloudModelEntry("gpt-5.6-luna");
    expect(entry.name).toBe("GPT-5.6 Luna");
    expect(entry.contextWindow).toBe(272_000);
    expect(entry.cost.input).toBeGreaterThan(0);
  });

  it("uses honest zeros rather than inventing a rate for an unknown model", () => {
    const entry = cloudModelEntry("some-model-the-sdk-has-never-seen");
    expect(entry.name).toBe("some-model-the-sdk-has-never-seen");
    expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(entry.contextWindow).toBe(128_000);
  });
});

describe("cloudProviderRegistration", () => {
  it("points an OpenAI-compatible provider at the relay", () => {
    const registration = cloudProviderRegistration({ settings: cloudSettings(), token: "tok_1" });
    expect(registration.name).toBe(CLOUD_PROVIDER_NAME);
    expect(registration.baseUrl).toBe("https://relay.example.com/v1");
    expect(registration.api).toBe(CLOUD_PROVIDER_API);
    expect(registration.apiKey).toBe("tok_1");
    expect(registration.models?.map((model) => model.id)).toEqual(["gpt-5.6-luna"]);
  });

  it("registers unauthenticated rather than with an empty key when no token is saved", () => {
    const registration = cloudProviderRegistration({ settings: cloudSettings() });
    expect(registration).not.toHaveProperty("apiKey");
  });

  it("changes its fingerprint when the token, relay, or model list changes", () => {
    const base = { settings: cloudSettings(), token: "tok_1" };
    expect(cloudProviderFingerprint(base)).toBe(cloudProviderFingerprint({ ...base }));
    expect(cloudProviderFingerprint({ ...base, token: "tok_2" })).not.toBe(cloudProviderFingerprint(base));
    expect(cloudProviderFingerprint({
      settings: loadSettings({ auth: { mode: "cloud", relayBaseUrl: "https://other.example.com" } }),
      token: "tok_1",
    })).not.toBe(cloudProviderFingerprint(base));
  });
});

describe("account mode drives the session plan", () => {
  it("runs the agent on the relay provider without a second setting", () => {
    expect(resolveSessionModels(cloudSettings()).provider).toBe(CLOUD_PROVIDER_ID);
  });

  it("leaves the local path alone", () => {
    expect(resolveSessionModels(loadSettings({})).provider).toBe("openai");
  });

  it("refuses to sit in cloud mode with no relay to talk to", () => {
    // Otherwise a hand-edited settings.json would boot into a mode where
    // nothing can be minted and no model can be resolved.
    expect(loadSettings({ auth: { mode: "cloud", relayBaseUrl: "" } }).auth.mode).toBe("byok");
  });
});

describe("the approval judge in cloud mode", () => {
  const previous = process.env.WILEY_APPROVAL_MODEL;

  afterEach(() => {
    if (previous === undefined) delete process.env.WILEY_APPROVAL_MODEL;
    else process.env.WILEY_APPROVAL_MODEL = previous;
  });

  /** Just enough ModelRuntime to prove which catalog the judge consulted. */
  function fakeRuntime(seen: string[]) {
    return {
      getModel: (provider: string, id: string) => {
        seen.push(`${provider}/${id}`);
        return provider === CLOUD_PROVIDER_ID
          ? ({ id, provider, api: "openai-responses", baseUrl: "https://relay.example.com/v1" } as never)
          : undefined;
      },
      complete: (model: unknown) => {
        seen.push(`complete:${(model as { provider: string }).provider}`);
        return Promise.resolve({ content: [{ type: "text", text: "ALLOW" }] } as never);
      },
    };
  }

  it("resolves its model through the runtime, which is the only thing that knows the relay", async () => {
    const seen: string[] = [];
    const judge = createApprovalJudge({
      enabled: true,
      provider: CLOUD_PROVIDER_ID,
      model: "gpt-5.6-terra",
      modelRuntime: fakeRuntime(seen),
    });

    expect(judge).toBeDefined();
    expect(seen).toContain(`${CLOUD_PROVIDER_ID}/gpt-5.6-terra`);
    expect(await judge?.review({ tool: "bash", input: {}, cwd: "/tmp", recentUserRequests: [] }))
      .toEqual({ allow: true });
    expect(seen).toContain(`complete:${CLOUD_PROVIDER_ID}`);
  });

  it("would silently never run on a hosted account without the runtime", () => {
    // The static catalog holds no wiley-cloud models, so this is exactly the
    // failure the runtime hand-off exists to prevent.
    expect(createApprovalJudge({ enabled: true, provider: CLOUD_PROVIDER_ID, model: "gpt-5.6-terra" }))
      .toBeUndefined();
  });

  it("still works on the local path, runtime or not", () => {
    expect(createApprovalJudge({ enabled: true, provider: "openai", model: "gpt-5.6-terra" })).toBeDefined();
  });

  it("refuses a configured model from an older family and judges on the default instead", () => {
    const seen: string[] = [];
    createApprovalJudge({
      enabled: true,
      provider: CLOUD_PROVIDER_ID,
      model: "gpt-5.4-mini",
      modelRuntime: fakeRuntime(seen),
    });
    expect(seen).toContain(`${CLOUD_PROVIDER_ID}/${DEFAULT_APPROVAL_MODEL}`);
    expect(seen).not.toContain(`${CLOUD_PROVIDER_ID}/gpt-5.4-mini`);
  });

  it("refuses an older family from the env escape hatch too", () => {
    const seen: string[] = [];
    process.env.WILEY_APPROVAL_MODEL = "gpt-4o";
    createApprovalJudge({ enabled: true, provider: CLOUD_PROVIDER_ID, modelRuntime: fakeRuntime(seen) });
    expect(seen).toContain(`${CLOUD_PROVIDER_ID}/${DEFAULT_APPROVAL_MODEL}`);
  });
});
