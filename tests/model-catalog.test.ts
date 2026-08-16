import { describe, expect, it } from "vitest";

import {
  clampThinkingLevel,
  FALLBACK_MODELS,
  findModelOption,
  isAllowedBackendModel,
  listAvailableModels,
  VOICE_MODEL_OPTIONS,
  type CatalogModel,
  type ModelCatalogRuntime,
} from "../src/main/settings/model-catalog";
import { DEFAULT_AGENT_MODEL, DEFAULT_VOICE_MODEL } from "../src/main/settings/settings-schema";

function fakeRuntime(models: CatalogModel[], options: { fail?: boolean; staticModels?: CatalogModel[] } = {}): ModelCatalogRuntime {
  return {
    getAvailable: async () => {
      if (options.fail) throw new Error("catalog unreachable");
      return models;
    },
    getModels: () => options.staticModels ?? [],
  };
}

describe("listAvailableModels", () => {
  it("maps SDK models onto picker options", async () => {
    const models = await listAvailableModels(fakeRuntime([
      {
        id: "gpt-5.6-luna",
        provider: "openai",
        name: "Luna",
        reasoning: true,
        contextWindow: 400_000,
        thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", max: "max" },
      },
    ]));
    expect(models).toEqual([
      {
        id: "gpt-5.6-luna",
        provider: "openai",
        name: "Luna",
        reasoning: true,
        contextWindow: 400_000,
        thinkingLevels: ["off", "low", "medium", "high"],
      },
    ]);
  });

  it("marks levels the model explicitly rejects as unsupported", async () => {
    const [model] = await listAvailableModels(fakeRuntime([
      {
        id: "gpt-5.6-sol",
        provider: "openai",
        reasoning: true,
        thinkingLevelMap: { off: null, low: "low", medium: "med", high: null },
      },
    ]));
    expect(model.thinkingLevels).toEqual(["low", "medium"]);
  });

  it("reports a non-reasoning model as off-only", async () => {
    const [model] = await listAvailableModels(fakeRuntime([{ id: "gpt-5.6-sol", provider: "openai", reasoning: false }]));
    expect(model.thinkingLevels).toEqual(["off"]);
  });

  it("sorts and de-duplicates", async () => {
    const models = await listAvailableModels(fakeRuntime([
      { id: "gpt-5.6-terra", provider: "openai" },
      { id: "gpt-5.6-luna", provider: "openai" },
      { id: "gpt-5.6-luna", provider: "openai", name: "later wins" },
    ]));
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(models[0].name).toBe("later wins");
  });

  it("falls back to the static list when the SDK query fails", async () => {
    expect(await listAvailableModels(fakeRuntime([], { fail: true }))).toEqual([...FALLBACK_MODELS]);
  });

  it("falls back to the static list when the SDK has no runtime at all", async () => {
    expect(await listAvailableModels(undefined)).toEqual([...FALLBACK_MODELS]);
  });

  it("uses the SDK's own static list before the hardcoded fallback", async () => {
    const models = await listAvailableModels(
      fakeRuntime([], { fail: true, staticModels: [{ id: "gpt-5.6-terra", provider: "openai" }] }),
    );
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-terra"]);
  });

  it("falls back when the SDK returns nothing rather than showing an empty picker", async () => {
    expect(await listAvailableModels(fakeRuntime([]))).toEqual([...FALLBACK_MODELS]);
  });

  it("offers only the allowed family, whatever the provider's catalog lists", async () => {
    const models = await listAvailableModels(fakeRuntime([
      { id: "gpt-4o", provider: "openai" },
      { id: "gpt-5.4-mini", provider: "openai" },
      { id: "gpt-5.5-pro", provider: "openai" },
      { id: "o3", provider: "openai" },
      { id: "gpt-5.6-luna", provider: "openai" },
      { id: "gpt-5.6-terra", provider: "openai" },
    ]));
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  it("never lets the SDK's static list smuggle an older family in", async () => {
    const models = await listAvailableModels(fakeRuntime([], {
      fail: true,
      staticModels: [{ id: "gpt-4o", provider: "openai" }, { id: "gpt-5.6-sol", provider: "openai" }],
    }));
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("falls back rather than showing an empty picker when nothing in the catalog qualifies", async () => {
    expect(await listAvailableModels(fakeRuntime([{ id: "gpt-5.4-mini", provider: "openai" }])))
      .toEqual([...FALLBACK_MODELS]);
  });

  it("defaults the provider when a model omits it", async () => {
    const [model] = await listAvailableModels(fakeRuntime([{ id: "gpt-5.6-luna" }]), { provider: "custom" });
    expect(model.provider).toBe("custom");
  });
});

describe("isAllowedBackendModel", () => {
  it("accepts the family and nothing older", () => {
    for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6", " gpt-5.6-luna "]) {
      expect(isAllowedBackendModel(id)).toBe(true);
    }
    for (const id of ["gpt-5.4-mini", "gpt-5.5-pro", "gpt-4o", "o3", "gpt-5.61", "gpt-5.6luna", ""]) {
      expect(isAllowedBackendModel(id)).toBe(false);
    }
  });

  it("refuses anything that is not a string", () => {
    expect(isAllowedBackendModel(undefined)).toBe(false);
    expect(isAllowedBackendModel(null)).toBe(false);
    expect(isAllowedBackendModel(["gpt-5.6-luna"])).toBe(false);
  });
});

describe("FALLBACK_MODELS", () => {
  it("offers the allowed family and leads with the default", () => {
    expect(FALLBACK_MODELS.every((model) => isAllowedBackendModel(model.id))).toBe(true);
    expect(FALLBACK_MODELS[0].id).toBe(DEFAULT_AGENT_MODEL);
  });
});

describe("clampThinkingLevel", () => {
  const model = { id: "m", provider: "openai", reasoning: true, thinkingLevels: ["low", "medium"] as const };

  it("leaves a supported level alone", () => {
    expect(clampThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, "medium")).toBe("medium");
  });

  it("steps down to the highest supported level", () => {
    expect(clampThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, "high")).toBe("medium");
  });

  it("steps up when nothing lower is supported", () => {
    expect(clampThinkingLevel({ id: "m", provider: "openai", thinkingLevels: ["high"] }, "off")).toBe("high");
  });

  it("forces off for a model without reasoning", () => {
    expect(clampThinkingLevel({ id: "m", provider: "openai", reasoning: false }, "high")).toBe("off");
  });

  it("trusts the request when the model is unknown or unannotated", () => {
    expect(clampThinkingLevel(undefined, "high")).toBe("high");
    expect(clampThinkingLevel({ id: "m", provider: "openai" }, "high")).toBe("high");
  });
});

describe("findModelOption", () => {
  it("finds by id", () => {
    expect(findModelOption(FALLBACK_MODELS, FALLBACK_MODELS[0].id)?.id).toBe(FALLBACK_MODELS[0].id);
    expect(findModelOption(FALLBACK_MODELS, "nope")).toBeUndefined();
  });
});

describe("VOICE_MODEL_OPTIONS", () => {
  it("offers the shipped model first and keeps the family suffix", () => {
    expect(VOICE_MODEL_OPTIONS[0]).toBe(DEFAULT_VOICE_MODEL);
    expect(VOICE_MODEL_OPTIONS.every((model) => model.startsWith("gpt-realtime"))).toBe(true);
  });
});
