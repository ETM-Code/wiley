import { describe, expect, it } from "vitest";

import type { SettingsView } from "../src/shared/contracts";
import { DEFAULT_SETTINGS, type WileySettings } from "../src/main/settings/settings-schema";
import {
  formatListInput,
  formatRuleLines,
  hasDraftChanges,
  agentModelError,
  modelChoices,
  parseListInput,
  parseRuleLines,
  settingsDraftPatch,
  settingsOf,
  toggleAllowedModel,
} from "../src/renderer/settings-draft";

function base(): WileySettings {
  return structuredClone(DEFAULT_SETTINGS);
}

describe("settingsOf", () => {
  it("strips the host-only decorations and detaches the copy", () => {
    const view: SettingsView = {
      ...base(),
      secrets: {
        openaiApiKey: { present: true, source: "store", stored: true, backend: "file" },
        cloudSessionToken: { stored: false, backend: "file" },
      },
      models: [{ id: "m", provider: "openai" }],
      probes: { claude: { available: false }, codex: { available: false } },
      terminalApps: ["Terminal", "Ghostty"],
    };
    const settings = settingsOf(view);
    expect(settings).toEqual(base());
    settings.agent.fastMode = false;
    expect(view.agent.fastMode).toBe(true);
  });
});

describe("settingsDraftPatch", () => {
  it("is empty when nothing changed", () => {
    expect(settingsDraftPatch(base(), base())).toEqual({});
    expect(hasDraftChanges(base(), base())).toBe(false);
  });

  it("carries only the changed leaves", () => {
    const draft = base();
    draft.agent.fastMode = false;
    draft.workers.codex.maxConcurrent = 4;
    expect(settingsDraftPatch(base(), draft)).toEqual({
      agent: { fastMode: false },
      workers: { codex: { maxConcurrent: 4 } },
    });
    expect(hasDraftChanges(base(), draft)).toBe(true);
  });

  it("replaces an array wholesale", () => {
    const draft = base();
    draft.agent.allowedModels = ["only-one"];
    expect(settingsDraftPatch(base(), draft)).toEqual({ agent: { allowedModels: ["only-one"] } });
  });

  it("ignores a reordered-but-equal array only when it is identical", () => {
    const draft = base();
    draft.agent.allowedModels = [...base().agent.allowedModels];
    expect(settingsDraftPatch(base(), draft)).toEqual({});
  });

  it("nulls a field the user cleared", () => {
    const from = base();
    from.agent.subagentModel = "worker-model";
    const draft = base();
    delete draft.agent.subagentModel;
    expect(settingsDraftPatch(from, draft)).toEqual({ agent: { subagentModel: null } });
  });

  it("adds a newly set optional field", () => {
    const draft = base();
    draft.workers.claude.command = "/usr/local/bin/claude";
    expect(settingsDraftPatch(base(), draft)).toEqual({ workers: { claude: { command: "/usr/local/bin/claude" } } });
  });
});

describe("rule and list parsing", () => {
  it("round-trips deny rules one per line", () => {
    const rules = ["Bash(sudo *)", "Read(./.env)"];
    expect(parseRuleLines(formatRuleLines(rules))).toEqual(rules);
  });

  it("drops blank and duplicate rules", () => {
    expect(parseRuleLines("  Bash(sudo *)  \n\n Bash(sudo *) \n Read(./.env)"))
      .toEqual(["Bash(sudo *)", "Read(./.env)"]);
  });

  it("accepts commas or newlines in a path list", () => {
    expect(parseListInput("/a/b, /c/d\n/e/f")).toEqual(["/a/b", "/c/d", "/e/f"]);
    expect(formatListInput(["/a/b", "/c/d"])).toBe("/a/b, /c/d");
    expect(parseListInput("   ")).toEqual([]);
  });
});

describe("toggleAllowedModel", () => {
  it("adds and removes", () => {
    expect(toggleAllowedModel(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleAllowedModel(["a", "b"], "b", false)).toEqual(["a"]);
  });

  it("refuses to remove a model the agent is configured to use", () => {
    expect(toggleAllowedModel(["a", "b"], "a", false, ["a"])).toEqual(["a", "b"]);
  });

  it("never empties the list", () => {
    expect(toggleAllowedModel(["a"], "a", false)).toEqual(["a"]);
  });

  it("does not duplicate an already-allowed model", () => {
    expect(toggleAllowedModel(["a", "b"], "a", true)).toEqual(["b", "a"]);
  });
});

describe("modelChoices", () => {
  it("merges the catalog with what the user already configured", () => {
    expect(modelChoices(["gpt-5.6-terra", "gpt-5.6-luna"], ["gpt-5.6-sol", "gpt-5.6-luna"]))
      .toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("offers nothing from outside the allowed family, however it got configured", () => {
    expect(modelChoices(["gpt-4o", "gpt-5.6-luna"], ["gpt-5.4-mini"])).toEqual(["gpt-5.6-luna"]);
  });
});

describe("agentModelError", () => {
  it("accepts a model in the allowed family", () => {
    expect(agentModelError("gpt-5.6-terra")).toBeUndefined();
  });

  it("explains the refusal and names a model that works", () => {
    const message = agentModelError("gpt-5.4-mini");
    expect(message).toMatch(/gpt-5\.4-mini/);
    expect(message).toMatch(/only runs gpt-5\.6 models/);
    expect(message).toMatch(/gpt-5\.6-luna/);
  });

  it("asks for an id rather than complaining about the family when the field is empty", () => {
    expect(agentModelError("   ")).toBe("Enter a model id.");
  });
});
