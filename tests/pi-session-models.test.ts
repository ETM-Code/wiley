import { describe, expect, it } from "vitest";

import {
  assertSpawnModelAllowed,
  diffSessionModels,
  resolveSessionModels,
} from "../src/main/pi/session-models";
import { DEFAULT_SETTINGS, normalizeSettings, type WileySettings } from "../src/main/settings/settings-schema";

function withAgent(patch: Partial<WileySettings["agent"]>): WileySettings {
  return normalizeSettings({ ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, ...patch } });
}

describe("resolveSessionModels", () => {
  it("reads the plan straight off the defaults", () => {
    expect(resolveSessionModels(DEFAULT_SETTINGS)).toEqual({
      provider: "openai",
      rootModel: "gpt-5.6-luna",
      thinkingLevel: "low",
      subagentModel: "gpt-5.6-luna",
      approvalEnabled: true,
      approvalModel: "gpt-5.4-mini",
    });
  });

  it("applies fast mode to the thinking level", () => {
    expect(resolveSessionModels(withAgent({ fastMode: true, thinkingLevel: "high" })).thinkingLevel).toBe("low");
    expect(resolveSessionModels(withAgent({ fastMode: false, thinkingLevel: "high" })).thinkingLevel).toBe("high");
  });

  it("uses the dedicated subagent model when one is set", () => {
    const plan = resolveSessionModels(withAgent({ subagentModel: "gpt-5.4-mini" }));
    expect(plan.rootModel).toBe("gpt-5.6-luna");
    expect(plan.subagentModel).toBe("gpt-5.4-mini");
  });
});

describe("diffSessionModels", () => {
  const base = resolveSessionModels(DEFAULT_SETTINGS);

  it("reports nothing to do when the plan is unchanged", () => {
    expect(diffSessionModels(base, { ...base })).toEqual({ root: false, subagent: false, approval: false });
  });

  it("isolates a root model change", () => {
    expect(diffSessionModels(base, { ...base, rootModel: "other" }))
      .toEqual({ root: true, subagent: false, approval: false });
  });

  it("isolates a subagent model change", () => {
    expect(diffSessionModels(base, { ...base, subagentModel: "other" }))
      .toEqual({ root: false, subagent: true, approval: false });
  });

  it("treats a thinking level change as touching both session kinds", () => {
    expect(diffSessionModels(base, { ...base, thinkingLevel: "high" }))
      .toEqual({ root: true, subagent: true, approval: false });
  });

  it("rebuilds the judge when approval is turned off or repointed", () => {
    expect(diffSessionModels(base, { ...base, approvalEnabled: false }).approval).toBe(true);
    expect(diffSessionModels(base, { ...base, approvalModel: "other" }).approval).toBe(true);
  });

  it("treats a provider change as touching everything", () => {
    expect(diffSessionModels(base, { ...base, provider: "anthropic" }))
      .toEqual({ root: true, subagent: true, approval: true });
  });
});

describe("assertSpawnModelAllowed", () => {
  it("allows a model on the list", () => {
    expect(() => assertSpawnModelAllowed(DEFAULT_SETTINGS, "gpt-5.6-luna")).not.toThrow();
  });

  it("names the model and the list when it is not allowed", () => {
    expect(() => assertSpawnModelAllowed(DEFAULT_SETTINGS, "gpt-9-secret"))
      .toThrow(/gpt-9-secret.*gpt-5\.6-luna, gpt-5\.4-mini.*Settings/s);
  });
});
