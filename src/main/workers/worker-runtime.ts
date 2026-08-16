/**
 * Assembles the worker stack: transports, safety, recording, and reaping,
 * wired into one manager. Everything above this line (PiRuntime, the tools,
 * the hosts) only ever sees WorkerRegistry.
 */

import type { WorkerProbes } from "../../shared/contracts";
import type { ApprovalJudge } from "../safety";
import type { WileySettings } from "../settings/settings-schema";
import { createClaudeWorkerFactory } from "./claude-worker";
import { createCliProbeRunner, probeWorkerClis } from "./cli-detect";
import { createCodexWorkerFactory } from "./codex-worker";
import { WorkerManager } from "./worker-manager";
import { createFileRecorder, createStartupReaper, NULL_RECORDER } from "./worker-recorder";
import { createWorkerCommandTripwire, createWorkerToolReviewer } from "./worker-safety";
import type { WorkerEvent } from "./worker-types";

export interface WorkerRuntimeOptions {
  projectDir: string;
  /** Where raw worker transcripts and the pid registry live. */
  dataDir?: string;
  settings: () => WileySettings;
  voice: { push(message: string, options?: { interrupt?: boolean }): void };
  recentUserRequests: () => string[];
  approvalJudge: () => ApprovalJudge | undefined;
  emit: (event: WorkerEvent) => void | Promise<void>;
  onChange?: () => void;
  /** Resolved binary paths from a probe, so the SDK drives the same claude. */
  executables?: () => Partial<Record<"claude" | "codex", string | undefined>>;
}

export function createWorkerManager(options: WorkerRuntimeOptions): WorkerManager {
  const recorder = options.dataDir ? createFileRecorder(options.dataDir) : NULL_RECORDER;
  const shared = {
    projectDir: options.projectDir,
    voice: options.voice,
    recentUserRequests: options.recentUserRequests,
    approvalJudge: options.approvalJudge,
  };
  const reviewTool = createWorkerToolReviewer({
    ...shared,
    denyRules: () => options.settings().workers.claude.denyRules,
    writableRoots: () => options.settings().workers.claude.extraDirs,
  });
  const tripwire = createWorkerCommandTripwire({
    ...shared,
    denyRules: () => options.settings().workers.codex.denyRules,
  });
  const claude = createClaudeWorkerFactory({
    projectDir: options.projectDir,
    settings: options.settings,
    reviewTool: (call) => reviewTool(call),
    executable: options.executables?.().claude,
  });
  const codex = createCodexWorkerFactory({
    projectDir: options.projectDir,
    settings: options.settings,
  });
  return new WorkerManager({
    settings: options.settings,
    emit: options.emit,
    recorder,
    onChange: options.onChange,
    announce: (message) => options.voice.push(message, { interrupt: true }),
    reviewCommand: tripwire,
    createTransport: (spec) => (spec.kind === "codex" ? codex(spec) : claude(spec)),
  });
}

/**
 * Kills worker process groups left behind by a previous run. Called once at
 * boot, before anything new starts, so a hard crash cannot leave a worker
 * burning tokens against a session nobody is reading.
 */
export function reapStaleWorkerProcesses(dataDir?: string): number {
  if (!dataDir) return 0;
  return createStartupReaper(createFileRecorder(dataDir))().length;
}

/** The real probe, wired into SettingsService at both hosts. */
export function createWorkerProbes(settings: () => WileySettings): () => Promise<WorkerProbes> {
  const runner = createCliProbeRunner();
  return () => probeWorkerClis(settings(), runner);
}
