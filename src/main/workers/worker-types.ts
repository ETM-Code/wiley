/**
 * The vocabulary every worker shares, whatever engine actually runs it.
 *
 * Renderer-safe on purpose: this module is types plus a couple of pure
 * predicates, so the shared contracts and the sidebar can name a worker kind
 * without dragging a child process or an SDK into the bundle.
 */

import type { AgentEvent, AgentEventType } from "../../shared/contracts";
import type { WorkerKind as CliWorkerKind } from "../settings/settings-schema";

export type { CliWorkerKind };

/** "pi" is the in-process Pi subagent; the rest are external CLIs. */
export type WorkerKind = "pi" | CliWorkerKind;

export const WORKER_KIND_VALUES: readonly WorkerKind[] = ["pi", "claude", "codex"];

export function isWorkerKind(value: unknown): value is WorkerKind {
  return typeof value === "string" && (WORKER_KIND_VALUES as readonly string[]).includes(value);
}

export function isCliWorkerKind(value: unknown): value is CliWorkerKind {
  return value === "claude" || value === "codex";
}

export type WorkerStatus =
  | "queued"
  | "starting"
  | "running"
  | "awaiting_input"
  | "winding_down"
  | "done"
  | "failed"
  | "cancelled";

/** Statuses that still hold a concurrency slot and still answer to a steer. */
export const ACTIVE_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "winding_down",
]);

export function isActiveWorkerStatus(status: WorkerStatus): boolean {
  return ACTIVE_WORKER_STATUSES.has(status);
}

export interface WorkerSpec {
  id: string;
  kind: WorkerKind;
  parentJobId: string;
  task: string;
  /** Pinned from settings at spawn time; an unpinned run picks its own model. */
  model?: string;
  effort?: string;
}

export interface WorkerUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  turns?: number;
}

export interface WorkerInterruptOptions {
  /**
   * Ask the worker to stop cleanly and report, rather than dying mid-edit.
   * The worker stays resumable either way; only kill() ends the process.
   */
  windDown?: boolean;
}

export interface WorkerHandle {
  readonly spec: WorkerSpec;
  readonly status: WorkerStatus;
  readonly report?: string;
  /** The engine's own session/thread id, once the stream announces one. */
  readonly externalSessionId?: string;
  readonly startedAt?: string;
  readonly usage?: WorkerUsage;
  send(message: string): Promise<void>;
  interrupt(reason: string, options?: WorkerInterruptOptions): Promise<void>;
  kill(): Promise<void>;
  dispose(): void;
}

export interface WorkerRegistry {
  register(spec: WorkerSpec): WorkerHandle;
  get(id: string): WorkerHandle | undefined;
  list(jobId?: string): WorkerHandle[];
  hasActive(jobId?: string): boolean;
  interruptAll(reason: string, options?: WorkerInterruptOptions): Promise<void>;
  killAll(): Promise<void>;
}

/**
 * What a protocol parser produces: an AgentEvent minus everything only the
 * manager knows (its id, its place in the sequence, when it happened, and
 * which worker emitted it).
 */
export interface WorkerEventDraft {
  type: AgentEventType;
  payload: unknown;
}

/** A draft stamped with its worker, ready for the ledger. */
export type WorkerEvent = Omit<AgentEvent, "id" | "sequence" | "at">;

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/**
 * The one seam between the manager and a real engine. The manager schedules,
 * times out, records, and rate-limits; the transport knows how to talk to a
 * Claude Code SDK query or a codex exec process and nothing else.
 */
export interface WorkerTransport {
  start(spec: WorkerSpec): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  signal(signal: NodeJS.Signals): void;
  onEvent(handler: (event: WorkerEventDraft) => void): void;
  onExit(handler: (exit: WorkerExit) => void): void;
  dispose(): void;
  readonly pid?: number;
  readonly externalSessionId?: string;
}

/** Milestone payload kinds the manager reads back out of a parser's drafts. */
export const WORKER_MILESTONE = {
  ready: "worker_ready",
  turnStarted: "worker_turn_started",
  parseErrors: "worker_parse_errors",
  collapsed: "worker_events_collapsed",
  unknownEvent: "worker_unknown_event",
} as const;

export type WorkerMilestoneKind = (typeof WORKER_MILESTONE)[keyof typeof WORKER_MILESTONE];

export interface WorkerReadyPayload {
  kind: typeof WORKER_MILESTONE.ready;
  externalSessionId?: string;
  model?: string;
}

/** Narrow a draft to the "the engine is live" marker without a cast at each site. */
export function readyPayload(event: WorkerEventDraft): WorkerReadyPayload | undefined {
  if (event.type !== "milestone") return undefined;
  const payload = event.payload as Partial<WorkerReadyPayload> | undefined;
  return payload?.kind === WORKER_MILESTONE.ready ? (payload as WorkerReadyPayload) : undefined;
}
