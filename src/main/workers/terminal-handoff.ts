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

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TERMINAL_APP, type WileySettings } from "../settings/settings-schema";
import { resolveWorkerCommand } from "./cli-detect";
import type { CliWorkerKind } from "./worker-types";

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

/** POSIX single-quoting, which survives paths with spaces and quotes alike. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface HandoffInput {
  projectDir: string;
  settings: WileySettings;
  /** Claude's session id. Its presence is what makes this a resume. */
  sessionId?: string;
  /** Codex's thread id, likewise. */
  threadId?: string;
}

/**
 * The shell command that puts the user in front of the session.
 *
 * It opens with `cd` rather than relying on the emulator's working directory:
 * `codex resume` rejects -C outright, a `do script` in Terminal.app starts in
 * the home directory, and a temp script file has no meaningful cwd of its own.
 * One `cd` up front makes all three land in the project.
 *
 * The claude side asks for acceptEdits, because the person now driving is the
 * approval bridge; Wiley's own hard floor went away with the connector.
 */
export function buildHandoffCommand(kind: CliWorkerKind, input: HandoffInput): string {
  const { projectDir, settings } = input;
  const worker = settings.workers[kind];
  const binary = resolveWorkerCommand(kind, worker);
  const parts = [shellQuote(binary)];
  if (kind === "claude") {
    if (input.sessionId) parts.push("--resume", shellQuote(input.sessionId));
    parts.push("--permission-mode", "acceptEdits");
    // Only a pinned model travels: unpinned means the device's own default,
    // exactly as it does for a worker Wiley drives itself.
    if (worker.model) parts.push("--model", shellQuote(worker.model));
  } else {
    // `codex resume`, not `codex exec resume`: exec is the non-interactive
    // mode and would hand the user a run that wants a prompt on stdin. Both
    // read the same rollout store, so an exec thread resumes interactively.
    if (input.threadId) parts.push("resume", shellQuote(input.threadId));
    if (worker.model) parts.push("-m", shellQuote(worker.model));
  }
  return `cd ${shellQuote(projectDir)} && ${parts.join(" ")}`;
}

/** How to get one command in front of the user in one particular emulator. */
export interface TerminalLaunchPlan {
  /** The program to run, and the arguments it gets. Never a shell string. */
  command: string;
  args: string[];
  /** Written and made executable before the launch, when the plan uses one. */
  script?: { path: string; contents: string };
  /** The app actually used, which differs from the request on a fallback. */
  app: string;
  /** Why the requested app was not used, for the caller to report. */
  fallbackReason?: string;
}

/** AppleScript string literals escape exactly two characters. */
function osascriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll(`"`, `\\"`)}"`;
}

function scriptFile(scriptPath: string, command: string): { path: string; contents: string } {
  return {
    path: scriptPath,
    // `exec` so the emulator's window belongs to the CLI itself, and the
    // window closes when the user quits it rather than dropping to a shell.
    contents: `#!/bin/bash\nexec /bin/bash -lc ${shellQuote(command)}\n`,
  };
}

/**
 * Pure: decides what to run without running it.
 *
 * Terminal and iTerm are scripted, which is the only way to land a command in
 * an existing-style window. The rest take an executable on their own command
 * line, so they get a temp script. A double-clickable .command file is not used
 * as a .command file anywhere here: LaunchServices hands those to Terminal.app
 * regardless of which emulator the user chose, which would silently ignore the
 * setting.
 */
export function planTerminalLaunch(
  app: string,
  command: string,
  /** Called only by a plan that needs a script, so nothing is created in vain. */
  scriptPath: () => string,
): TerminalLaunchPlan {
  if (app === "Terminal") {
    return {
      app,
      command: "osascript",
      args: [
        "-e", `tell application "Terminal" to do script ${osascriptString(command)}`,
        "-e", `tell application "Terminal" to activate`,
      ],
    };
  }
  if (app === "iTerm") {
    return {
      app,
      command: "osascript",
      args: [
        "-e", `tell application "iTerm"`,
        "-e", `create window with default profile`,
        "-e", `tell current session of current window to write text ${osascriptString(command)}`,
        "-e", `activate`,
        "-e", `end tell`,
      ],
    };
  }
  // Ghostty and Alacritty spell it `-e <program>`; kitty takes the program as
  // its first positional argument. All three arrive through `open --args`.
  if (app === "Ghostty" || app === "Alacritty") {
    const script = scriptFile(scriptPath(), command);
    return { app, command: "open", args: ["-na", app, "--args", "-e", script.path], script };
  }
  if (app === "kitty") {
    const script = scriptFile(scriptPath(), command);
    return { app, command: "open", args: ["-na", app, "--args", script.path], script };
  }
  // Warp exposes no way to run a command in a new tab from the command line,
  // and its URI scheme cannot carry one either, so the handoff goes to
  // Terminal and says so rather than opening a window with nothing in it.
  return {
    ...planTerminalLaunch("Terminal", command, scriptPath),
    fallbackReason: app === "Warp"
      ? "Warp cannot be given a command to run from outside, so this opened in Terminal."
      : `${app} is not a terminal Wiley knows how to drive, so this opened in Terminal.`,
  };
}

export interface TerminalLaunchResult {
  app: string;
  fallbackReason?: string;
}

/**
 * Opens the command in the user's terminal and returns immediately. The
 * launcher process is detached: closing Wiley must not close the session the
 * user just took over.
 */
export function launchInTerminal(
  app: string,
  command: string,
  cwd: string,
  deps: { spawnProcess?: typeof spawn; tempDir?: () => string } = {},
): TerminalLaunchResult {
  const tempDir = deps.tempDir ?? (() => mkdtempSync(path.join(os.tmpdir(), "wiley-handoff-")));
  const plan = planTerminalLaunch(app, command, () => path.join(tempDir(), "session.sh"));
  if (plan.script) writeFileSync(plan.script.path, plan.script.contents, { mode: 0o700 });
  const child = (deps.spawnProcess ?? spawn)(plan.command, plan.args, {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return { app: plan.app, ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}) };
}
