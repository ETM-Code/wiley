import { describe, expect, it } from "vitest";

import {
  applyPatch,
  DEFAULT_DENY_RULES,
  DEFAULT_SETTINGS,
  deepMerge,
  effectiveThinkingLevel,
  loadSettings,
  MAX_WORKER_CONCURRENCY,
  migrateSettings,
  MIN_TURN_TIMEOUT_MS,
  normalizeSettings,
  SETTINGS_VERSION,
  subagentModelFor,
} from "../src/main/settings/settings-schema";

describe("normalizeSettings", () => {
  it("returns the documented defaults for an empty input", () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("stamps the current version regardless of the input version", () => {
    expect(normalizeSettings({ version: 99 }).version).toBe(SETTINGS_VERSION);
  });

  it("drops unknown fields at every level", () => {
    const normalized = normalizeSettings({
      surprise: true,
      voice: { model: "gpt-realtime-mini-2.1", surprise: 1 },
      agent: { model: "custom-model", nope: "x" },
      workers: { claude: { enabled: true, nope: 1 }, ghost: { enabled: true } },
    }) as unknown as Record<string, unknown>;
    expect(normalized.surprise).toBeUndefined();
    expect(Object.keys(normalized.workers as object)).toEqual(["claude", "codex"]);
    expect((normalized.voice as Record<string, unknown>).surprise).toBeUndefined();
    expect((normalized.agent as Record<string, unknown>).nope).toBeUndefined();
  });

  it("keeps a terminal app the picker never offered, and defaults a blank one", () => {
    expect(normalizeSettings({ terminalApp: "WezTerm" }).terminalApp).toBe("WezTerm");
    expect(normalizeSettings({ terminalApp: "   " }).terminalApp).toBe("Terminal");
    expect(normalizeSettings({ terminalApp: 7 }).terminalApp).toBe("Terminal");
  });

  it("falls back to the default when an enum value is not recognised", () => {
    const settings = normalizeSettings({
      auth: { mode: "enterprise" },
      voice: { reasoningEffort: "extreme" },
      agent: { thinkingLevel: "ultra" },
      workers: { claude: { approvalBridge: "telepathy" } },
    });
    expect(settings.auth.mode).toBe("byok");
    expect(settings.voice.reasoningEffort).toBe(DEFAULT_SETTINGS.voice.reasoningEffort);
    expect(settings.agent.thinkingLevel).toBe("medium");
    expect(settings.workers.claude.approvalBridge).toBe("canUseTool");
  });

  it("never accepts an escalated codex sandbox", () => {
    expect(normalizeSettings({ workers: { codex: { sandbox: "danger-full-access" } } }).workers.codex.sandbox)
      .toBe("workspace-write");
    expect(normalizeSettings({ workers: { codex: { sandbox: "read-only" } } }).workers.codex.sandbox)
      .toBe("read-only");
  });

  it("clamps numeric ranges instead of rejecting the file", () => {
    const settings = normalizeSettings({
      workers: { claude: { maxConcurrent: 500, turnTimeoutMs: 5 }, codex: { maxConcurrent: 0, budgetUsd: -3 } },
    });
    expect(settings.workers.claude.maxConcurrent).toBe(MAX_WORKER_CONCURRENCY);
    expect(settings.workers.claude.turnTimeoutMs).toBe(MIN_TURN_TIMEOUT_MS);
    expect(settings.workers.codex.maxConcurrent).toBe(1);
    expect(settings.workers.codex.budgetUsd).toBeUndefined();
  });

  it("keeps deny rules the user set and defaults them when absent", () => {
    expect(normalizeSettings({}).workers.codex.denyRules).toEqual([...DEFAULT_DENY_RULES]);
    expect(normalizeSettings({ workers: { codex: { denyRules: ["Bash(rm *)", "Bash(rm *)"] } } }).workers.codex.denyRules)
      .toEqual(["Bash(rm *)"]);
  });

  it("keeps the allowlist exactly as the user wrote it", () => {
    const settings = normalizeSettings({
      agent: { model: "custom-root", subagentModel: "custom-sub", allowedModels: ["custom-sub", " custom-sub "] },
    });
    expect(settings.agent.allowedModels).toEqual(["custom-sub"]);
  });

  it("restores the default allowlist rather than blocking every spawn", () => {
    expect(normalizeSettings({ agent: { allowedModels: [] } }).agent.allowedModels)
      .toEqual(DEFAULT_SETTINGS.agent.allowedModels);
    expect(normalizeSettings({ agent: { allowedModels: [1, null] } }).agent.allowedModels)
      .toEqual(DEFAULT_SETTINGS.agent.allowedModels);
  });

  it("leaves optional worker fields out rather than writing empty strings", () => {
    const worker = normalizeSettings({ workers: { claude: { command: "   ", model: "" } } }).workers.claude;
    expect(worker.command).toBeUndefined();
    expect(worker.model).toBeUndefined();
    expect(worker.permissionMode).toBe("default");
  });
});

describe("effectiveThinkingLevel", () => {
  it("forces low while fast mode is on", () => {
    expect(effectiveThinkingLevel({ ...DEFAULT_SETTINGS.agent, fastMode: true, thinkingLevel: "high" })).toBe("low");
  });

  it("uses the configured level once fast mode is off", () => {
    expect(effectiveThinkingLevel({ ...DEFAULT_SETTINGS.agent, fastMode: false, thinkingLevel: "high" })).toBe("high");
    expect(effectiveThinkingLevel({ ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, fastMode: false } }))
      .toBe("medium");
  });
});

describe("subagentModelFor", () => {
  it("falls back to the root model", () => {
    expect(subagentModelFor(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.agent.model);
    expect(subagentModelFor({ ...DEFAULT_SETTINGS.agent, subagentModel: "worker-model" })).toBe("worker-model");
  });
});

describe("deepMerge", () => {
  it("merges nested objects and replaces arrays", () => {
    const merged = deepMerge(
      { a: { b: 1, c: 2 }, list: [1, 2, 3] },
      { a: { c: 9 }, list: [7] },
    );
    expect(merged).toEqual({ a: { b: 1, c: 9 }, list: [7] });
  });

  it("treats undefined as leave-alone and null as clear", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined, b: null })).toEqual({ a: 1, b: null });
  });
});

describe("migrateSettings", () => {
  it("treats a versionless file as v0 and lifts it to the current version", () => {
    const migrated = migrateSettings({ agent: { model: "old-model" } });
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.agent).toEqual({ model: "old-model" });
  });

  it("preserves v0 values through a full load", () => {
    const loaded = loadSettings({ agent: { model: "old-model", fastMode: false }, voice: { voice: "cedar" } });
    expect(loaded.version).toBe(SETTINGS_VERSION);
    expect(loaded.agent.model).toBe("old-model");
    expect(loaded.agent.fastMode).toBe(false);
    expect(loaded.voice.voice).toBe("cedar");
    expect(loaded.workers.codex.maxConcurrent).toBe(2);
  });

  it("leaves an already-current file untouched", () => {
    expect(loadSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("applyPatch", () => {
  it("merges a partial patch and re-validates the result", () => {
    const patched = applyPatch(DEFAULT_SETTINGS, {
      agent: { fastMode: false },
      workers: { codex: { enabled: true, maxConcurrent: 99 } },
    });
    expect(patched.agent.fastMode).toBe(false);
    expect(patched.agent.model).toBe(DEFAULT_SETTINGS.agent.model);
    expect(patched.workers.codex.enabled).toBe(true);
    expect(patched.workers.codex.maxConcurrent).toBe(MAX_WORKER_CONCURRENCY);
    expect(patched.workers.claude).toEqual(DEFAULT_SETTINGS.workers.claude);
  });

  it("does not mutate the base settings", () => {
    const base = normalizeSettings({});
    applyPatch(base, { voice: { voice: "cedar" } });
    expect(base.voice.voice).toBe(DEFAULT_SETTINGS.voice.voice);
  });
});
