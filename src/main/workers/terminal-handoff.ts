/**
 * Handing a worker's session over to the user's own terminal.
 *
 * A worker session outlives the process driving it: `claude --resume` and
 * `codex exec resume` both pick a session back up. That makes "take this over
 * myself" a real operation rather than a restart, so this module knows which
 * emulators are installed, what command reattaches a session, and how to get
 * that command in front of the user.
 *
 * Everything here is pure assembly plus one injected filesystem check, so the
 * commands can be tested without opening a window on anybody's desktop.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TERMINAL_APP } from "../settings/settings-schema";

/**
 * The emulators worth offering, by the application name `open -a` expects.
 * iTerm2 installs itself as iTerm.app, which is why the entry is not "iTerm2".
 */
export const TERMINAL_APPS: readonly string[] = [
  "Terminal",
  "iTerm",
  "Warp",
  "Ghostty",
  "kitty",
  "Alacritty",
];

export interface TerminalDetectDeps {
  fileExists: (file: string) => boolean;
  home: string;
}

/** Where a mac app can live without the user having done anything unusual. */
export function terminalAppPaths(name: string, home: string): string[] {
  return [
    path.join("/Applications", `${name}.app`),
    path.join(home, "Applications", `${name}.app`),
  ];
}

/**
 * The installed subset of TERMINAL_APPS, in the listed order. Terminal.app is
 * always included: it ships with macOS, and an empty dropdown would leave the
 * handoff with nowhere to go if the check ever came back wrong.
 */
export function detectTerminalApps(deps: TerminalDetectDeps): string[] {
  const found = TERMINAL_APPS.filter((name) =>
    name === DEFAULT_TERMINAL_APP || terminalAppPaths(name, deps.home).some(deps.fileExists));
  return found.includes(DEFAULT_TERMINAL_APP) ? found : [DEFAULT_TERMINAL_APP, ...found];
}

/** The detector both hosts wire into SettingsService. */
export function createTerminalAppDetector(
  deps: TerminalDetectDeps = { fileExists: existsSync, home: os.homedir() },
): () => string[] {
  return () => detectTerminalApps(deps);
}
