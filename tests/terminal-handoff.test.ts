import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type WileySettings } from "../src/main/settings/settings-schema";
import {
  buildHandoffCommand,
  detectTerminalApps,
  planTerminalLaunch,
  shellQuote,
  TERMINAL_APPS,
  terminalAppPaths,
} from "../src/main/workers/terminal-handoff";

const HOME = "/Users/tester";
const SCRIPT = "/tmp/wiley-handoff-xyz/session.sh";

function settingsWith(
  kind: "claude" | "codex",
  overrides: Partial<WileySettings["workers"]["claude"]> = {},
): WileySettings {
  return {
    ...DEFAULT_SETTINGS,
    workers: { ...DEFAULT_SETTINGS.workers, [kind]: { ...DEFAULT_SETTINGS.workers[kind], ...overrides } },
  };
}

/** A machine described by the app bundles it has, without touching a disk. */
function machine(...installed: string[]) {
  const present = new Set(installed.flatMap((name) => terminalAppPaths(name, HOME)));
  return { home: HOME, fileExists: (file: string) => present.has(file) };
}

describe("terminal app detection", () => {
  it("looks in both /Applications and the user's own Applications folder", () => {
    expect(terminalAppPaths("Ghostty", HOME)).toEqual([
      "/Applications/Ghostty.app",
      path.join(HOME, "Applications", "Ghostty.app"),
    ]);
    expect(detectTerminalApps(machine("Warp"))).toContain("Warp");
    expect(detectTerminalApps({
      home: HOME,
      fileExists: (file) => file === path.join(HOME, "Applications", "kitty.app"),
    })).toContain("kitty");
  });

  it("lists only what is installed, in the offered order", () => {
    expect(detectTerminalApps(machine("Alacritty", "iTerm"))).toEqual(["Terminal", "iTerm", "Alacritty"]);
  });

  it("always keeps Terminal, which ships with the OS", () => {
    expect(detectTerminalApps(machine())).toEqual(["Terminal"]);
  });

  it("offers iTerm under its bundle name rather than iTerm2", () => {
    expect(TERMINAL_APPS).toContain("iTerm");
    expect(TERMINAL_APPS).not.toContain("iTerm2");
  });
});

describe("buildHandoffCommand", () => {
  it("resumes a claude session in the project, with the user as the approver", () => {
    expect(buildHandoffCommand("claude", {
      projectDir: "/work/board ai",
      settings: settingsWith("claude"),
      sessionId: "sess-1",
    })).toBe("cd '/work/board ai' && 'claude' --resume 'sess-1' --permission-mode acceptEdits");
  });

  it("starts a fresh claude session when there is no session to resume", () => {
    expect(buildHandoffCommand("claude", { projectDir: "/work", settings: settingsWith("claude") }))
      .toBe("cd '/work' && 'claude' --permission-mode acceptEdits");
  });

  it("resumes codex interactively, since exec would want a prompt on stdin", () => {
    expect(buildHandoffCommand("codex", {
      projectDir: "/work",
      settings: settingsWith("codex"),
      threadId: "thread-9",
    })).toBe("cd '/work' && 'codex' resume 'thread-9'");
  });

  it("always leads with cd, because codex resume refuses -C", () => {
    for (const command of [
      buildHandoffCommand("codex", { projectDir: "/work", settings: settingsWith("codex"), threadId: "t" }),
      buildHandoffCommand("codex", { projectDir: "/work", settings: settingsWith("codex") }),
    ]) {
      expect(command.startsWith("cd '/work' && ")).toBe(true);
      expect(command).not.toContain("-C");
    }
  });

  it("carries a pinned model and nothing when none is pinned", () => {
    expect(buildHandoffCommand("claude", { projectDir: "/w", settings: settingsWith("claude", { model: "haiku" }) }))
      .toContain("--model 'haiku'");
    expect(buildHandoffCommand("codex", { projectDir: "/w", settings: settingsWith("codex", { model: "gpt-5.3-codex" }) }))
      .toContain("-m 'gpt-5.3-codex'");
    expect(buildHandoffCommand("codex", { projectDir: "/w", settings: settingsWith("codex") })).not.toContain("-m ");
  });

  it("uses the configured binary path rather than the bare name", () => {
    expect(buildHandoffCommand("claude", {
      projectDir: "/w",
      settings: settingsWith("claude", { command: "/opt/bin/claude" }),
    })).toContain("'/opt/bin/claude'");
  });

  it("survives a project path with a quote in it", () => {
    expect(shellQuote("/work/it's here")).toBe(`'/work/it'\\''s here'`);
  });
});

describe("planTerminalLaunch", () => {
  it("scripts Terminal.app with osascript and no temp file", () => {
    const plan = planTerminalLaunch("Terminal", "cd '/w' && claude", () => SCRIPT);
    expect(plan.command).toBe("osascript");
    expect(plan.args.join(" ")).toContain(`do script "cd '/w' && claude"`);
    expect(plan.script).toBeUndefined();
    expect(plan.fallbackReason).toBeUndefined();
  });

  it("writes into a fresh iTerm window", () => {
    const plan = planTerminalLaunch("iTerm", "run me", () => SCRIPT);
    expect(plan.command).toBe("osascript");
    expect(plan.args.join(" ")).toContain("create window with default profile");
    expect(plan.args.join(" ")).toContain(`write text "run me"`);
  });

  it("escapes quotes and backslashes on the way into AppleScript", () => {
    const plan = planTerminalLaunch("Terminal", `say "hi\\there"`, () => SCRIPT);
    expect(plan.args.join(" ")).toContain(`do script "say \\"hi\\\\there\\""`);
  });

  it("hands the launchable emulators an executable script on their own flag", () => {
    expect(planTerminalLaunch("Ghostty", "run me", () => SCRIPT).args)
      .toEqual(["-na", "Ghostty", "--args", "-e", SCRIPT]);
    expect(planTerminalLaunch("Alacritty", "run me", () => SCRIPT).args)
      .toEqual(["-na", "Alacritty", "--args", "-e", SCRIPT]);
    expect(planTerminalLaunch("kitty", "run me", () => SCRIPT).args)
      .toEqual(["-na", "kitty", "--args", SCRIPT]);
    const plan = planTerminalLaunch("kitty", "run me", () => SCRIPT);
    expect(plan.command).toBe("open");
    expect(plan.script?.contents).toContain("#!/bin/bash");
    expect(plan.script?.contents).toContain("'run me'");
  });

  it("falls back to Terminal for Warp, and says why", () => {
    const plan = planTerminalLaunch("Warp", "run me", () => SCRIPT);
    expect(plan.app).toBe("Terminal");
    expect(plan.command).toBe("osascript");
    expect(plan.fallbackReason).toMatch(/Warp.*Terminal/);
  });

  it("falls back for an emulator it has never heard of", () => {
    expect(planTerminalLaunch("WezTerm", "run me", () => SCRIPT).fallbackReason).toMatch(/WezTerm/);
  });

  it("creates no temp script for a plan that does not use one", () => {
    let created = 0;
    planTerminalLaunch("Terminal", "run me", () => {
      created += 1;
      return SCRIPT;
    });
    expect(created).toBe(0);
  });
});
