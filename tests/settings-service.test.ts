import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FALLBACK_MODELS, type ModelCatalogRuntime } from "../src/main/settings/model-catalog";
import { FileSecretStore } from "../src/main/settings/secret-store";
import { assertSecretName, probeWorkersStub, SettingsService } from "../src/main/settings/settings-service";
import { SettingsStore } from "../src/main/settings/settings-store";

function service(
  options: {
    env?: Record<string, string | undefined>;
    modelRuntime?: ModelCatalogRuntime;
    terminalApps?: () => string[];
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "wiley-service-"));
  const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
  return {
    dir,
    store,
    service: new SettingsService({
      store,
      env: options.env ?? {},
      modelRuntime: () => options.modelRuntime,
      ...(options.terminalApps ? { terminalApps: options.terminalApps } : {}),
    }),
  };
}

describe("SettingsService.view", () => {
  it("never includes a secret value", async () => {
    const { service: settings, store } = service();
    store.secrets.set("openaiApiKey", "sk-super-secret");
    const view = await settings.view();
    expect(JSON.stringify(view)).not.toContain("sk-super-secret");
    expect(view.secrets.openaiApiKey).toEqual({ present: true, source: "store", stored: true, backend: "file" });
  });

  it("lists the terminals this machine actually has", async () => {
    const { service: settings } = service({ terminalApps: () => ["Terminal", "Ghostty"] });
    expect((await settings.view()).terminalApps).toEqual(["Terminal", "Ghostty"]);
  });

  it("reports the env as the live source when it is set", async () => {
    const { service: settings, store } = service({ env: { OPENAI_API_KEY: "sk-env" } });
    store.secrets.set("openaiApiKey", "sk-stored");
    const view = await settings.view();
    expect(view.secrets.openaiApiKey.source).toBe("env");
    expect(view.secrets.openaiApiKey.stored).toBe(true);
  });

  it("reports no key when nothing is configured", async () => {
    const view = await service().service.view();
    expect(view.secrets.openaiApiKey).toEqual({ present: false, source: "none", stored: false, backend: "file" });
  });

  it("carries the settings, the model list, and the probes", async () => {
    const view = await service().service.view();
    expect(view.agent.model).toBe("gpt-5.6-luna");
    expect(view.models).toEqual([...FALLBACK_MODELS]);
    expect(view.probes).toEqual(probeWorkersStub());
  });
});

describe("SettingsService.update", () => {
  it("persists and returns the refreshed view", async () => {
    const { service: settings, store } = service();
    const view = await settings.update({ agent: { fastMode: false } });
    expect(view.agent.fastMode).toBe(false);
    expect(store.get().agent.fastMode).toBe(false);
  });
});

describe("SettingsService secrets", () => {
  it("sets and clears through the store", async () => {
    const { service: settings } = service();
    expect((await settings.setSecret("openaiApiKey", "sk-a")).secrets.openaiApiKey.present).toBe(true);
    expect((await settings.clearSecret("openaiApiKey")).secrets.openaiApiKey.present).toBe(false);
  });

  it("exposes the resolved key to the host only", () => {
    const { service: settings } = service({ env: { OPENAI_API_KEY: "sk-env" } });
    expect(settings.resolveApiKey()).toEqual({ key: "sk-env", source: "env", envOverride: false });
  });
});

describe("SettingsService.models", () => {
  it("caches a successful SDK answer", async () => {
    let calls = 0;
    const { service: settings } = service({
      modelRuntime: {
        getAvailable: async () => {
          calls += 1;
          return [{ id: "gpt-5.6-sol", provider: "openai" }];
        },
      },
    });
    expect((await settings.models()).map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    await settings.models();
    expect(calls).toBe(1);
  });

  it("retries while no runtime exists yet", async () => {
    const { service: settings } = service();
    expect(await settings.models()).toEqual([...FALLBACK_MODELS]);
    expect(await settings.models()).toEqual([...FALLBACK_MODELS]);
  });
});

describe("worker probes", () => {
  it("reports both worker kinds as unavailable when no host wired a probe up", () => {
    expect(probeWorkersStub()).toEqual({
      claude: { available: false, reason: "this host does not check for worker CLIs" },
      codex: { available: false, reason: "this host does not check for worker CLIs" },
    });
  });

  it("uses the host's own probe, and puts its answer in the view", async () => {
    const probes = {
      claude: { available: true, version: "2.1.233", path: "/opt/homebrew/bin/claude" },
      codex: { available: false, reason: "codex is installed but not signed in." },
    };
    const settings = new SettingsService({
      store: SettingsStore.open(mkdtempSync(path.join(tmpdir(), "wiley-probe-")), new FileSecretStore({
        dir: mkdtempSync(path.join(tmpdir(), "wiley-probe-secrets-")),
      })),
      env: {},
      probeWorkers: () => probes,
    });

    expect(await settings.probeWorkers()).toEqual(probes);
    expect((await settings.view()).probes).toEqual(probes);
  });
});

describe("assertSecretName", () => {
  it("accepts the known names and rejects everything else", () => {
    expect(assertSecretName("openaiApiKey")).toBe("openaiApiKey");
    expect(assertSecretName("cloudSessionToken")).toBe("cloudSessionToken");
    expect(() => assertSecretName("passwords")).toThrow(/Unknown secret/);
    expect(() => assertSecretName(undefined)).toThrow(/Unknown secret/);
  });
});
