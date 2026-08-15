/**
 * The durable trail a worker leaves behind: every raw stream line on disk, and
 * a registry of the process groups we started so a crashed app can clean up
 * after itself on the next boot.
 *
 * The decisions live in pure functions at the top; the filesystem lives at the
 * bottom, behind interfaces the tests replace.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CliWorkerKind } from "./worker-types";

export interface PidRecord {
  workerId: string;
  pid: number;
  kind: CliWorkerKind;
  startedAt: string;
}

export interface WorkerRecorder {
  /** One raw stream line, exactly as the CLI produced it. */
  line(workerId: string, line: string): void;
  registerPid(record: PidRecord): void;
  clearPid(workerId: string): void;
  listPids(): PidRecord[];
}

/** Used by tests and by any host that does not want a disk trail. */
export const NULL_RECORDER: WorkerRecorder = {
  line: () => undefined,
  registerPid: () => undefined,
  clearPid: () => undefined,
  listPids: () => [],
};

/**
 * Which recorded processes are still around and still ours. Pid reuse is real,
 * so a record only counts as reapable when the caller can confirm the live
 * process is actually the worker we started, not whatever inherited its number.
 */
export function stalePids(
  records: readonly PidRecord[],
  isOurs: (record: PidRecord) => boolean,
): PidRecord[] {
  return records.filter((record) => Number.isInteger(record.pid) && record.pid > 1 && isOurs(record));
}

export function parsePidRecords(raw: string): PidRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PidRecord => {
    const record = entry as Partial<PidRecord> | null;
    return Boolean(record)
      && typeof record?.workerId === "string"
      && typeof record.pid === "number"
      && (record.kind === "claude" || record.kind === "codex");
  });
}

export function workersDir(dataDir: string): string {
  return path.join(dataDir, "workers");
}

export function pidsFile(dataDir: string): string {
  return path.join(workersDir(dataDir), "pids.json");
}

/** Transcripts can contain whatever the worker read, so they stay owner-only. */
const OWNER_ONLY = 0o600;

export function createFileRecorder(dataDir: string): WorkerRecorder {
  const dir = workersDir(dataDir);
  const pids = pidsFile(dataDir);
  const ensureDir = () => mkdirSync(dir, { recursive: true, mode: 0o700 });
  const read = (): PidRecord[] => (existsSync(pids) ? parsePidRecords(readFileSync(pids, "utf8")) : []);
  const write = (records: PidRecord[]) => {
    ensureDir();
    writeFileSync(pids, JSON.stringify(records, null, 2), { mode: OWNER_ONLY });
  };
  return {
    line(workerId, value) {
      try {
        ensureDir();
        appendFileSync(path.join(dir, `${workerId}.jsonl`), `${value}\n`, { mode: OWNER_ONLY });
      } catch (error) {
        // A full or read-only disk must never take a running worker down.
        console.error(`Could not record worker output for ${workerId}`, error);
      }
    },
    registerPid(record) {
      try {
        write([...read().filter((entry) => entry.workerId !== record.workerId), record]);
      } catch (error) {
        console.error("Could not record a worker process id", error);
      }
    },
    clearPid(workerId) {
      try {
        write(read().filter((entry) => entry.workerId !== workerId));
      } catch (error) {
        console.error("Could not clear a worker process id", error);
      }
    },
    listPids: () => {
      try {
        return read();
      } catch {
        return [];
      }
    },
  };
}

export interface ReaperDeps {
  recorder: WorkerRecorder;
  /** Confirms the live process really is the worker that record describes. */
  isOurs(record: PidRecord): boolean;
  kill(pid: number): void;
}

/**
 * Startup sweep: a hard crash leaves worker process groups orphaned, still
 * burning tokens against a session nobody is reading. This is the only place
 * that kills a process the current run never started, which is why it insists
 * on confirming the identity of each one first.
 */
export function reapStaleWorkers(deps: ReaperDeps): PidRecord[] {
  const reaped = stalePids(deps.recorder.listPids(), deps.isOurs);
  for (const record of reaped) {
    try {
      deps.kill(record.pid);
    } catch (error) {
      console.error(`Could not stop the leftover worker process ${record.pid}`, error);
    }
  }
  for (const record of deps.recorder.listPids()) deps.recorder.clearPid(record.workerId);
  return reaped;
}

/** Reads a live process's command line so the reaper can confirm identity. */
export function processCommand(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    // ps exits non-zero for a pid that is already gone, which is not an error.
    return "";
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    // Workers are spawned detached, so the negated pid reaches every child the
    // worker itself started rather than orphaning its subprocesses.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  }
}

/** The production reaper, wired at boot before any worker is started. */
export function createStartupReaper(recorder: WorkerRecorder): () => PidRecord[] {
  return () => reapStaleWorkers({
    recorder,
    isOurs: (record) => {
      const command = processCommand(record.pid);
      return command.includes(record.kind);
    },
    kill: (pid) => killProcessGroup(pid, "SIGKILL"),
  });
}
