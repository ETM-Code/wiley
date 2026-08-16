import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type WorkerSettings } from "../src/main/settings/settings-schema";
import {
  claudePermissionMode,
  claudeQueryOptions,
  claudeThinkingTokens,
  claudeUserMessage,
} from "../src/main/workers/claude-worker";
import { codexArgs } from "../src/main/workers/codex-worker";
import type { WorkerSpec } from "../src/main/workers/worker-types";

const HOME = "/Users/tester";

const spec: WorkerSpec = { id: "w-1", kind: "claude", parentJobId: "job-1", task: "build it" };

function claudeSettings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return { ...DEFAULT_SETTINGS.workers.claude, ...overrides };
}

function codexSettings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return { ...DEFAULT_SETTINGS.workers.codex, ...overrides };
}

function options(worker: WorkerSettings, workerSpec: WorkerSpec = spec) {
  return claudeQueryOptions({
    spec: workerSpec,
    worker,
    cwd: "/work",
    env: { PATH: "/usr/bin", HOME },
    home: HOME,
  });
}

describe("claude query options", () => {
  it("sends no model at all until one is pinned, so the CLI's own default wins", () => {
    expect(options(claudeSettings()).model).toBeUndefined();
    expect("model" in options(claudeSettings())).toBe(false);
    expect(options(claudeSettings({ model: "sonnet" })).model).toBe("sonnet");
    expect(options(claudeSettings({ model: "sonnet" }), { ...spec, model: "opus" }).model).toBe("opus");
  });

  it("refuses bypassPermissions, which would cut the safety reviewer out", () => {
    expect(claudePermissionMode("bypassPermissions")).toBe("default");
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode("nonsense")).toBe("default");
    expect(claudePermissionMode(undefined)).toBe("default");
  });

  it("augments PATH on top of the inherited environment rather than replacing it", () => {
    const env = options(claudeSettings()).env;
    expect(env?.HOME).toBe(HOME);
    expect(env?.PATH?.split(path.delimiter)).toContain(path.join(HOME, ".local", "bin"));
    expect(env?.PATH?.split(path.delimiter)).toContain("/usr/bin");
  });

  it("loads no filesystem settings, so the user's session hooks stay out of it", () => {
    expect(options(claudeSettings()).settingSources).toEqual([]);
  });

  it("passes the tool allow and deny lists only when they are configured", () => {
    const bare = options(claudeSettings());
    expect(bare.allowedTools).toBeUndefined();
    expect(bare.disallowedTools).toBeUndefined();
    expect(bare.additionalDirectories).toBeUndefined();

    const configured = options(claudeSettings({
      allowedTools: ["Read"],
      disallowedTools: ["WebFetch"],
      extraDirs: ["/scratch"],
    }));
    expect(configured.allowedTools).toEqual(["Read"]);
    expect(configured.disallowedTools).toEqual(["WebFetch"]);
    expect(configured.additionalDirectories).toEqual(["/scratch"]);
  });

  it("translates effort into a thinking budget", () => {
    expect(claudeThinkingTokens("high")).toBe(32_000);
    expect(claudeThinkingTokens("nonsense")).toBeUndefined();
    expect(claudeThinkingTokens(undefined)).toBeUndefined();
    expect(options(claudeSettings({ effort: "low" })).maxThinkingTokens).toBe(4_000);
  });

  it("points the SDK at the probed binary when one was resolved", () => {
    const pinned = claudeQueryOptions({
      spec,
      worker: claudeSettings(),
      cwd: "/work",
      env: {},
      home: HOME,
      executable: "/opt/homebrew/bin/claude",
    });
    expect(pinned.pathToClaudeCodeExecutable).toBe("/opt/homebrew/bin/claude");
  });

  it("wraps a steer as a plain user message on the same stream", () => {
    expect(claudeUserMessage("use TypeScript")).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "use TypeScript" }] },
      parent_tool_use_id: null,
    });
  });
});

describe("codex arguments", () => {
  const codexSpec: WorkerSpec = { ...spec, kind: "codex" };

  it("starts a thread with the sandbox and stdin input, the root coming from the spawn cwd", () => {
    expect(codexArgs({ spec: codexSpec, worker: codexSettings() })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-",
    ]);
  });

  it("never assembles a sandbox escape, whatever settings say", () => {
    const args = codexArgs({ spec: codexSpec, worker: codexSettings({ sandbox: "read-only" }) });
    expect(args).toContain("read-only");
    expect(args.join(" ")).not.toContain("danger");
    expect(args.join(" ")).not.toContain("bypass");
  });

  it("resumes by thread id with the sandbox as a config override, since -s is rejected", () => {
    const args = codexArgs({ spec: codexSpec, worker: codexSettings(), threadId: "thread-7" });

    expect(args.slice(0, 4)).toEqual(["exec", "resume", "thread-7", "--json"]);
    expect(args).toContain('sandbox_mode="workspace-write"');
    // -C and -s do not exist on resume; the directory moves to the spawn call.
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-C");
  });

  it("carries the pinned model and effort into both a start and a resume", () => {
    const worker = codexSettings({ model: "gpt-5.3-codex", effort: "high" });
    for (const threadId of [undefined, "thread-7"]) {
      const args = codexArgs({ spec: codexSpec, worker, threadId });
      expect(args).toContain("-m");
      expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.3-codex");
      expect(args).toContain('model_reasoning_effort="high"');
    }
  });

  it("prefers the spawn-time model over the configured one", () => {
    const args = codexArgs({
      spec: { ...codexSpec, model: "gpt-5.4-mini" },
      worker: codexSettings({ model: "gpt-5.3-codex" }),
    });
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.4-mini");
  });

  it("passes extra directories as flags on a start and as an override on a resume", () => {
    const worker = codexSettings({ extraDirs: ["/scratch", "/shared"] });

    const start = codexArgs({ spec: codexSpec, worker });
    expect(start.filter((arg) => arg === "--add-dir")).toHaveLength(2);

    const resumed = codexArgs({ spec: codexSpec, worker, threadId: "thread-7" });
    expect(resumed).not.toContain("--add-dir");
    expect(resumed).toContain('sandbox_workspace_write.writable_roots=["/scratch","/shared"]');
  });

  it("always reads the prompt from stdin, which the transcript can outgrow argv for", () => {
    expect(codexArgs({ spec: codexSpec, worker: codexSettings() }).at(-1)).toBe("-");
    expect(codexArgs({ spec: codexSpec, worker: codexSettings(), threadId: "t" }).at(-1)).toBe("-");
  });
});
