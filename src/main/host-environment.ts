import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { env } from "../shared/env";
import { augmentPath } from "./workers/cli-detect";

/** Where a packaged app puts the workspace it was given no other name for. */
export const DEFAULT_WORKSPACE_NAME = "Wiley";

/** Leading ~ is what a person types in a text field; nothing else expands it. */
function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/**
 * The directory the agent may edit.
 *
 * Order: the environment, then the saved setting, then a workspace of our own.
 * The last one matters most: an app launched from Finder inherits "/" as its
 * working directory, and pointing a coding agent at the filesystem root is the
 * worst possible default. A packaged run therefore never falls back to cwd.
 */
export function resolveProjectDir(options: {
  packaged: boolean;
  home: string;
  configured?: string;
  source?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Overridable so a test can resolve a path without creating it. */
  makeDir?: (dir: string) => void;
}): string {
  const home = path.resolve(options.home);
  const fallback = path.join(home, DEFAULT_WORKSPACE_NAME);
  const makeDir = options.makeDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));

  const candidates = [env("PROJECT_DIR", options.source), options.configured];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(expandHome(trimmed, home));
    // A workspace of "/" is always a mistake, however it was asked for.
    if (resolved === path.parse(resolved).root) continue;
    return resolved;
  }

  const cwd = options.cwd ?? process.cwd();
  if (!options.packaged && cwd !== path.parse(cwd).root) return path.resolve(cwd);
  makeDir(fallback);
  return fallback;
}

/**
 * The PATH a packaged app should run with.
 *
 * A GUI app inherits launchd's PATH, which has none of the places a person
 * installs a CLI, so `claude` and `codex` are invisible to a worker even though
 * the same machine finds them fine in a terminal. Asking the user's own login
 * shell is the only way to see what they see, and the worker directories go on
 * afterwards either way, so a shell that fails or hangs still leaves a usable
 * PATH rather than the launchd one.
 */
export function resolvePackagedPath(options: {
  currentPath?: string;
  home: string;
  readLoginPath?: () => string | undefined;
}): string {
  const current = options.currentPath ?? "";
  const login = (options.readLoginPath ?? readLoginShellPath)();
  const base = login && login.length > current.length ? login : current;
  return augmentPath(base, options.home);
}

/** Empty rather than throwing: an unusable shell is not a startup failure. */
export function readLoginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | undefined {
  try {
    const result = spawnSync(shell, ["-lic", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0) return undefined;
    const value = result.stdout?.trim();
    return value && value.includes(path.delimiter) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Terminal handoffs write a session script into a temp directory that outlives
 * the app on purpose, since the user's shell is still reading it. Nothing ever
 * deleted them, so they accumulated one per handoff forever.
 */
export function sweepStaleHandoffs(options: {
  dir?: string;
  prefix?: string;
  maxAgeMs?: number;
  now?: number;
} = {}): number {
  const dir = options.dir ?? os.tmpdir();
  const prefix = options.prefix ?? "wiley-handoff-";
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
  const now = options.now ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const target = path.join(dir, entry);
    try {
      if (now - statSync(target).mtimeMs < maxAgeMs) continue;
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Another user's directory, or one already gone. Neither is our problem.
    }
  }
  return removed;
}
