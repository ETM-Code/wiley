import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectTerminalApps,
  TERMINAL_APPS,
  terminalAppPaths,
} from "../src/main/workers/terminal-handoff";

const HOME = "/Users/tester";

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
