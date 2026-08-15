/**
 * Can this machine actually run a worker CLI, and is it new enough?
 *
 * Everything that touches the outside world goes through an injected runner,
 * so the parsing, the version gate, and the auth rules are testable without
 * spawning anything. The real runner lives at the bottom of the file.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkerProbe, WorkerProbes } from "../../shared/contracts";
import { WORKER_KINDS, type WileySettings, type WorkerSettings } from "../settings/settings-schema";
import type { CliWorkerKind } from "./worker-types";

export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  error?: string;
}

export interface CliProbeRunner {
  exec(command: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<CliExecResult>;
  which(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  fileExists(file: string): boolean;
  homedir(): string;
  platform(): NodeJS.Platform;
  env(): NodeJS.ProcessEnv;
}

export const DEFAULT_WORKER_COMMANDS: Record<CliWorkerKind, string> = {
  claude: "claude",
  codex: "codex",
};

/**
 * Below these the stream vocabularies this connector was written against do
 * not exist yet, so a mismatch is a wrong answer rather than a missing feature.
 */
export const MINIMUM_WORKER_VERSIONS: Record<CliWorkerKind, string> = {
  claude: "2.0.0",
  codex: "0.140.0",
};

/**
 * A packaged app inherits a bare login PATH, so the directories every one of
 * these CLIs actually installs into have to be added back by hand. Used for
 * probing and for spawning, which must agree or a probe would be a lie.
 */
export function workerPathDirs(home: string): string[] {
  return [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

export function augmentPath(currentPath: string | undefined, home: string): string {
  const existing = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...existing];
  for (const dir of workerPathDirs(home)) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged.join(path.delimiter);
}

/** The environment both the probe and the spawned worker run under. */
export function workerEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...base, PATH: augmentPath(base.PATH, home) };
}

/** "2.1.233 (Claude Code)" and "codex-cli 0.147.0" both yield the triple. */
export function parseCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function meetsMinimumVersion(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

export function resolveWorkerCommand(kind: CliWorkerKind, worker?: WorkerSettings): string {
  return worker?.command?.trim() || DEFAULT_WORKER_COMMANDS[kind];
}

/**
 * Where each CLI keeps proof that somebody logged in. Claude on macOS stores
 * the credential in the keychain rather than on disk, so a missing file is not
 * a missing login; the keychain lookup reads metadata only and never the value.
 */
async function hasCredentials(kind: CliWorkerKind, runner: CliProbeRunner): Promise<boolean> {
  const home = runner.homedir();
  const env = runner.env();
  if (kind === "codex") {
    return runner.fileExists(path.join(home, ".codex", "auth.json")) || Boolean(env.OPENAI_API_KEY);
  }
  if (runner.fileExists(path.join(home, ".claude", ".credentials.json"))) return true;
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  if (runner.platform() !== "darwin") return false;
  const keychain = await runner.exec(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials"],
    { env },
  );
  return keychain.code === 0;
}

export async function probeCli(
  kind: CliWorkerKind,
  worker: WorkerSettings | undefined,
  runner: CliProbeRunner,
): Promise<WorkerProbe> {
  const command = resolveWorkerCommand(kind, worker);
  const env = workerEnv(runner.env(), runner.homedir());
  const version = await runner.exec(command, ["--version"], { env });
  if (version.error || version.code !== 0) {
    return {
      available: false,
      reason: `${command} could not be run on this machine. Install it, or set an explicit path in Settings.`,
    };
  }
  const parsed = parseCliVersion(`${version.stdout}\n${version.stderr}`);
  if (!parsed) {
    return { available: false, reason: `${command} did not report a version this connector understands.` };
  }
  const minimum = MINIMUM_WORKER_VERSIONS[kind];
  const resolvedPath = await runner.which(command, env);
  if (!meetsMinimumVersion(parsed, minimum)) {
    return {
      available: false,
      reason: `${command} ${parsed} is older than the supported ${minimum}. Update it to use ${kind} workers.`,
      version: parsed,
      path: resolvedPath,
    };
  }
  if (!await hasCredentials(kind, runner)) {
    return {
      available: false,
      reason: `${command} is installed but not signed in. Run \`${command}\` once in a terminal and log in.`,
      version: parsed,
      path: resolvedPath,
    };
  }
  return { available: true, version: parsed, path: resolvedPath };
}

export async function probeWorkerClis(
  settings: WileySettings,
  runner: CliProbeRunner,
): Promise<WorkerProbes> {
  const entries = await Promise.all(
    WORKER_KINDS.map(async (kind) => [kind, await probeCli(kind, settings.workers[kind], runner)] as const),
  );
  return Object.fromEntries(entries) as WorkerProbes;
}

const PROBE_TIMEOUT_MS = 10_000;

/** The real runner: short, unshelled, and the only part that touches the OS. */
export function createCliProbeRunner(): CliProbeRunner {
  const exec = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) =>
    new Promise<CliExecResult>((resolve) => {
      execFile(
        command,
        args,
        { env: options.env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1_000_000 },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code === "string") {
            resolve({ code: null, stdout, stderr, error: String((error as { code: string }).code) });
            return;
          }
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
        },
      );
    });
  return {
    exec,
    async which(command, env) {
      // An absolute path is already the answer, and shelling out for it would
      // only be a chance to mis-quote a path with a space in it.
      if (command.includes(path.sep)) return command;
      const result = await exec("/usr/bin/which", [command], { env });
      const line = result.stdout.split("\n").find((entry) => entry.trim());
      return result.code === 0 && line ? line.trim() : undefined;
    },
    fileExists: (file) => existsSync(file),
    homedir: () => os.homedir(),
    platform: () => process.platform,
    env: () => process.env,
  };
}

/** Wired into SettingsService at both hosts so Settings shows the real answer. */
export function createWorkerProbe(
  settings: () => WileySettings,
  runner: CliProbeRunner = createCliProbeRunner(),
): () => Promise<WorkerProbes> {
  return () => probeWorkerClis(settings(), runner);
}
