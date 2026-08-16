import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

import type { ProjectEntry, ProjectView } from "../shared/contracts";
import { env } from "../shared/env";
import { expandHome } from "./host-environment";
import {
  normalizeProjectPath,
  type RecentProject,
  type WileySettings,
} from "./settings/settings-schema";

/** Where a project keeps its own ledger, worker records and transcripts. */
export const PROJECT_DATA_DIR = ".wiley";
/** The name the same directory had before the rename. */
const LEGACY_PROJECT_DATA_DIR = ".board-ai";
export const LEDGER_FILE = "runtime.sqlite";
/** A WAL ledger is three files, and a copy that takes one of them is a corrupt one. */
const LEDGER_SIDECARS = ["-wal", "-shm"];

export type Exists = (target: string) => boolean;

/**
 * New projects get .wiley. One that already holds a .board-ai from before the
 * rename keeps using it, so an existing board and its ledger do not silently
 * vanish behind a fresh empty directory.
 */
export function projectDataDir(projectDir: string, exists: Exists = existsSync): string {
  const current = path.join(projectDir, PROJECT_DATA_DIR);
  if (exists(current)) return current;
  const legacy = path.join(projectDir, LEGACY_PROJECT_DATA_DIR);
  return exists(legacy) ? legacy : current;
}

/** What a person calls the project, which is the folder's own name. */
export function projectName(projectDir: string): string {
  return path.basename(projectDir) || projectDir;
}

/** An absolute, usable project path, or nothing. "/" is never a project. */
export function toProjectPath(value: unknown, home: string): string | undefined {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return undefined;
  const resolved = path.resolve(expandHome(normalized, home));
  return resolved === path.parse(resolved).root ? undefined : resolved;
}

/**
 * The project a launch should open, or nothing when the picker should ask.
 *
 * The environment wins, as it always has, and is taken on trust: naming a
 * folder that does not exist yet is a reasonable thing for a script to do. The
 * two saved paths are only honoured while they are still on disk, because a
 * project someone moved or deleted must be asked about rather than silently
 * recreated somewhere it no longer belongs.
 */
export function resolveLaunchProject(options: {
  settings: Pick<WileySettings, "lastProject" | "projectDir">;
  home: string;
  source?: NodeJS.ProcessEnv;
  exists?: Exists;
}): string | undefined {
  const exists = options.exists ?? existsSync;
  const fromEnv = toProjectPath(env("PROJECT_DIR", options.source), options.home);
  if (fromEnv) return fromEnv;
  for (const candidate of [options.settings.lastProject, options.settings.projectDir]) {
    const resolved = toProjectPath(candidate, options.home);
    if (resolved && exists(resolved)) return resolved;
  }
  return undefined;
}

export function describeProject(
  projectPath: string,
  lastOpenedAt = new Date(0).toISOString(),
  exists: Exists = existsSync,
): ProjectEntry {
  return {
    path: projectPath,
    name: projectName(projectPath),
    lastOpenedAt,
    missing: !exists(projectPath),
  };
}

/** Everything the launch picker and the project chip read, in one shape. */
export function buildProjectView(options: {
  current?: string;
  recent?: readonly RecentProject[];
  canOpen: boolean;
  exists?: Exists;
}): ProjectView {
  const exists = options.exists ?? existsSync;
  const recent = options.recent ?? [];
  const current = options.current
    ? describeProject(
        options.current,
        recent.find((entry) => entry.path === options.current)?.lastOpenedAt,
        exists,
      )
    : undefined;
  return {
    ...(current ? { current } : {}),
    recent: recent.map((entry) => describeProject(entry.path, entry.lastOpenedAt, exists)),
    canOpen: options.canOpen,
  };
}

export interface LedgerAdoption {
  from: string;
  to: string;
  /** Where the original was left, so it can be pointed at if anything went wrong. */
  backup: string;
}

/**
 * The Electron host used to keep one ledger under the app's own data directory
 * no matter which workspace was open. A project now carries its own, so the
 * first one opened after the upgrade adopts that history instead of starting
 * empty on a board the user had spent weeks filling.
 *
 * It runs once and only into an empty project: a project that already has a
 * ledger owns its own history and must never have another one dropped on top.
 * The original is renamed aside rather than deleted, because the cost of
 * keeping it is a few megabytes and the cost of being wrong is everything the
 * user has ever drawn.
 */
export function adoptGlobalLedger(options: { legacyDir: string; dataDir: string }): LedgerAdoption | undefined {
  const legacyDir = path.resolve(options.legacyDir);
  const dataDir = path.resolve(options.dataDir);
  if (legacyDir === dataDir) return undefined;
  const from = path.join(legacyDir, LEDGER_FILE);
  const to = path.join(dataDir, LEDGER_FILE);
  const backup = `${from}.bak`;
  // The .bak is the record that this already happened. Without checking it, a
  // crash between the copy and the rename would hand the same history to the
  // next project opened as well, which is how one board ends up in two places.
  if (!existsSync(from) || existsSync(to) || existsSync(backup)) return undefined;

  mkdirSync(dataDir, { recursive: true });
  for (const suffix of ["", ...LEDGER_SIDECARS]) {
    if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
  }
  // The sidecars go with it: a -wal left beside no database is a puzzle for
  // whoever finds it next, and sqlite would replay it into a fresh file.
  for (const suffix of ["", ...LEDGER_SIDECARS]) {
    if (existsSync(`${from}${suffix}`)) renameSync(`${from}${suffix}`, `${backup}${suffix}`);
  }
  return { from, to, backup };
}
