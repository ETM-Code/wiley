/**
 * Owns every external worker: what may start, when it must stop, what the
 * ledger hears about it, and what gets cleaned up afterwards.
 *
 * The engines themselves sit behind WorkerTransport, so this file never knows
 * whether it is driving an SDK query or a child process. That is also what
 * makes it testable: the tests hand it a fake transport and never spawn.
 */

import type { AgentEventType } from "../../shared/contracts";
import { redact } from "../pi/redact";
import type { WileySettings, WorkerSettings } from "../settings/settings-schema";
import { NULL_RECORDER, type WorkerRecorder } from "./worker-recorder";
import {
  isActiveWorkerStatus,
  readyPayload,
  WORKER_MILESTONE,
  type CliWorkerKind,
  type WorkerEvent,
  type WorkerEventDraft,
  type WorkerExit,
  type WorkerHandle,
  type WorkerInterruptOptions,
  type WorkerRegistry,
  type WorkerSpec,
  type WorkerStatus,
  type WorkerTransport,
  type WorkerUsage,
} from "./worker-types";

export interface CommandReview {
  allow: boolean;
  reason?: string;
}

export interface WorkerManagerOptions {
  settings: () => WileySettings;
  createTransport: (spec: WorkerSpec) => WorkerTransport;
  emit: (event: WorkerEvent) => void | Promise<void>;
  recorder?: WorkerRecorder;
  now?: () => number;
  /**
   * Codex has no permission callback, so every command it starts is checked
   * after the fact here. This is detection, not prevention: the command is
   * already running when we see it, and a hit stops the worker rather than
   * stopping the command.
   */
  reviewCommand?: (input: { spec: WorkerSpec; command: string }) => Promise<CommandReview>;
  /** Speaks a blocked-command or timeout notice in Wiley's own voice. */
  announce?: (message: string) => void;
  windDownGraceMs?: number;
  killGraceMs?: number;
  eventsPerSecond?: number;
  onChange?: () => void;
}

const DEFAULT_WIND_DOWN_GRACE_MS = 20_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_EVENTS_PER_SECOND = 20;

/** Terminal events are never dropped by the rate limiter. */
const UNTHROTTLED: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "completed",
  "error",
  "interrupted",
]);

export function windDownMessage(reason: string): string {
  return [
    "[WIND DOWN]",
    reason,
    "Stop starting new work now. Leave the workspace in a consistent state, then reply with a",
    "short report of what you finished, what you left unfinished, and anything half-applied.",
  ].join(" ");
}

interface ErrorPayload {
  fatal?: boolean;
}

class ManagedWorker implements WorkerHandle {
  status: WorkerStatus = "queued";
  report?: string;
  externalSessionId?: string;
  startedAt?: string;
  usage?: WorkerUsage;
  transport?: WorkerTransport;
  /** Steering that arrived before the engine was ready to hear it. */
  readonly pending: string[] = [];
  turnTimer?: ReturnType<typeof setTimeout>;
  windDownTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  windowStartedAt = 0;
  windowCount = 0;
  collapsed = 0;
  exited = false;
  /** Set once kill() starts, so the exit it causes reads as cancelled. */
  killing = false;
  readonly exitWaiters: Array<() => void> = [];

  constructor(readonly spec: WorkerSpec, private readonly manager: WorkerManager) {}

  send(message: string): Promise<void> {
    return this.manager.sendTo(this, message);
  }

  interrupt(reason: string, options: WorkerInterruptOptions = {}): Promise<void> {
    return this.manager.interruptWorker(this, reason, options);
  }

  kill(): Promise<void> {
    return this.manager.killWorker(this);
  }

  dispose(): void {
    this.manager.disposeWorker(this);
  }
}

export class WorkerManager implements WorkerRegistry {
  readonly #workers = new Map<string, ManagedWorker>();
  readonly #recorder: WorkerRecorder;
  readonly #now: () => number;
  #emitTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkerManagerOptions) {
    this.#recorder = options.recorder ?? NULL_RECORDER;
    this.#now = options.now ?? (() => Date.now());
  }

  register(spec: WorkerSpec): WorkerHandle {
    const worker = new ManagedWorker(spec, this);
    this.#workers.set(spec.id, worker);
    this.#changed();
    // Deferred so the caller gets a handle it can still see as queued, and so
    // a burst of registrations is scheduled against one capacity check.
    queueMicrotask(() => void this.#drain());
    return worker;
  }

  get(id: string): WorkerHandle | undefined {
    return this.#workers.get(id);
  }

  list(jobId?: string): WorkerHandle[] {
    return [...this.#workers.values()].filter((worker) => !jobId || worker.spec.parentJobId === jobId);
  }

  hasActive(jobId?: string): boolean {
    return this.list(jobId).some((worker) => isActiveWorkerStatus(worker.status));
  }

  async interruptAll(reason: string, options: WorkerInterruptOptions = {}): Promise<void> {
    await Promise.allSettled(
      [...this.#workers.values()]
        .filter((worker) => isActiveWorkerStatus(worker.status))
        .map((worker) => this.interruptWorker(worker, reason, options)),
    );
  }

  async killAll(): Promise<void> {
    await Promise.allSettled([...this.#workers.values()].map((worker) => this.killWorker(worker)));
  }

  /**
   * The last-resort sweep for process.on("exit"), where nothing asynchronous
   * can run. It signals and forgets rather than waiting for a clean shutdown.
   */
  killAllSync(): void {
    for (const worker of this.#workers.values()) {
      this.#clearTimers(worker);
      try {
        worker.transport?.signal("SIGKILL");
        worker.transport?.dispose();
      } catch {
        // Exiting anyway; a failure here has nowhere useful to go.
      }
      this.#recorder.clearPid(worker.spec.id);
    }
  }

  async dispose(): Promise<void> {
    await this.killAll();
    this.#workers.clear();
  }

  #settingsFor(kind: CliWorkerKind): WorkerSettings {
    return this.options.settings().workers[kind];
  }

  #cliKind(worker: ManagedWorker): CliWorkerKind {
    // Pi subagents never reach the manager; the registry adapter owns those.
    return worker.spec.kind === "codex" ? "codex" : "claude";
  }

  #changed(): void {
    this.options.onChange?.();
  }

  #activeCount(kind: CliWorkerKind): number {
    return [...this.#workers.values()].filter(
      (worker) => worker.spec.kind === kind
        && worker.status !== "queued"
        && isActiveWorkerStatus(worker.status),
    ).length;
  }

  async #drain(): Promise<void> {
    for (const kind of ["claude", "codex"] as const) {
      const limit = this.#settingsFor(kind).maxConcurrent;
      for (const worker of [...this.#workers.values()].filter((entry) => entry.spec.kind === kind)) {
        if (worker.status !== "queued") continue;
        // Recounted every time: starting a worker suspends, and a second
        // drain can take a slot while this one is waiting.
        if (this.#activeCount(kind) >= limit) break;
        await this.#start(worker);
      }
    }
  }

  async #start(worker: ManagedWorker): Promise<void> {
    worker.status = "starting";
    worker.startedAt = new Date(this.#now()).toISOString();
    this.#changed();
    try {
      const transport = this.options.createTransport(worker.spec);
      worker.transport = transport;
      transport.onEvent((event) => this.#onEvent(worker, event));
      transport.onExit((exit) => this.#onExit(worker, exit));
      transport.onRaw?.((line) => this.#recorder.line(worker.spec.id, line));
      await transport.start(worker.spec);
      if (transport.pid) {
        this.#recorder.registerPid({
          workerId: worker.spec.id,
          pid: transport.pid,
          kind: this.#cliKind(worker),
          startedAt: worker.startedAt,
        });
      }
      this.#armTurnTimer(worker);
    } catch (error) {
      await this.#fail(worker, `Could not start the ${worker.spec.kind} worker: ${String(error)}`);
    }
  }

  #armTurnTimer(worker: ManagedWorker): void {
    if (worker.turnTimer) clearTimeout(worker.turnTimer);
    const timeout = this.#settingsFor(this.#cliKind(worker)).turnTimeoutMs;
    worker.turnTimer = setTimeout(() => {
      void this.#onTurnTimeout(worker, timeout);
    }, timeout);
    worker.turnTimer.unref?.();
  }

  async #onTurnTimeout(worker: ManagedWorker, timeout: number): Promise<void> {
    if (!isActiveWorkerStatus(worker.status)) return;
    const minutes = Math.round(timeout / 60_000);
    this.options.announce?.(
      `[worker] I stopped a background task that went quiet for ${minutes} minutes.`,
    );
    await this.#fail(
      worker,
      `The ${worker.spec.kind} worker produced nothing for ${minutes} minutes, so it was stopped.`,
    );
    await this.killWorker(worker);
  }

  #onEvent(worker: ManagedWorker, draft: WorkerEventDraft): void {
    this.#armTurnTimer(worker);
    const ready = readyPayload(draft);
    if (ready) {
      worker.externalSessionId = ready.externalSessionId ?? worker.externalSessionId;
      if (worker.status === "starting") {
        worker.status = "running";
        this.#changed();
        void this.#flushPending(worker);
      }
    }
    if (draft.type === "completed") {
      const payload = draft.payload as { report?: string; usage?: WorkerUsage } | undefined;
      worker.report = payload?.report ?? worker.report;
      worker.usage = payload?.usage ?? worker.usage;
      this.#publish(worker, draft);
      void this.#settle(worker, "done");
      return;
    }
    if (draft.type === "error" && (draft.payload as ErrorPayload | undefined)?.fatal) {
      worker.report = worker.report ?? String((draft.payload as { error?: string }).error ?? "");
      this.#publish(worker, draft);
      void this.#settle(worker, "failed");
      return;
    }
    if (draft.type === "tool_started") void this.#tripwire(worker, draft);
    this.#publish(worker, draft);
  }

  /**
   * Codex's post-hoc command check. Claude routes through canUseTool before a
   * tool runs; codex offers no such hook, so the best available answer is to
   * notice immediately and stop the worker before it does the next thing.
   */
  async #tripwire(worker: ManagedWorker, draft: WorkerEventDraft): Promise<void> {
    const review = this.options.reviewCommand;
    if (!review || worker.spec.kind !== "codex") return;
    const payload = draft.payload as { toolName?: string; input?: { command?: string } } | undefined;
    const command = payload?.toolName === "bash" ? payload.input?.command : undefined;
    if (!command) return;
    const verdict = await review({ spec: worker.spec, command });
    if (verdict.allow) return;
    this.options.announce?.(`[safety] I stopped a background task before a dangerous command. ${verdict.reason ?? ""}`.trim());
    this.#publish(worker, {
      type: "error",
      payload: {
        error: `Blocked command in a codex worker: ${verdict.reason ?? "unsafe command"}`,
        command,
        blocked: true,
      },
    });
    await this.interruptWorker(worker, `A dangerous command was blocked: ${verdict.reason ?? ""}`, {
      windDown: false,
    });
  }

  /**
   * A chatty worker can emit hundreds of events a second, which would swamp
   * the ledger and the sidebar. Excess is counted, not lost: the collapse
   * milestone says exactly how much was dropped.
   */
  #publish(worker: ManagedWorker, draft: WorkerEventDraft): void {
    const now = this.#now();
    if (now - worker.windowStartedAt >= 1_000) {
      this.#flushCollapsed(worker);
      worker.windowStartedAt = now;
      worker.windowCount = 0;
    }
    if (UNTHROTTLED.has(draft.type)) {
      // The note about what was dropped belongs before the outcome it
      // explains, not after it.
      this.#flushCollapsed(worker);
      worker.windowCount += 1;
      this.#emit(worker, draft);
      return;
    }
    const limit = this.options.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
    if (worker.windowCount >= limit) {
      worker.collapsed += 1;
      return;
    }
    worker.windowCount += 1;
    this.#emit(worker, draft);
  }

  #flushCollapsed(worker: ManagedWorker): void {
    if (worker.collapsed === 0) return;
    const count = worker.collapsed;
    worker.collapsed = 0;
    this.#emit(worker, {
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.collapsed, count },
    });
  }

  #emit(worker: ManagedWorker, draft: WorkerEventDraft): void {
    const event: WorkerEvent = {
      jobId: worker.spec.parentJobId,
      agentId: worker.spec.id,
      parentAgentId: "root",
      type: draft.type,
      // Redaction belongs here rather than in the parsers: one place, applied
      // to everything that reaches the durable ledger or the renderer.
      // workerKind, not kind: several payloads carry a "kind" of their own.
      payload: redact({ ...(draft.payload as object), workerKind: worker.spec.kind }),
    };
    this.#emitTail = this.#emitTail.then(
      () => this.options.emit(event),
      () => this.options.emit(event),
    ).catch((error: unknown) => console.error("Could not record a worker event", error));
  }

  async #flushPending(worker: ManagedWorker): Promise<void> {
    const queued = worker.pending.splice(0, worker.pending.length);
    for (const message of queued) {
      try {
        await worker.transport?.send(message);
      } catch (error) {
        console.error(`Could not deliver a queued message to ${worker.spec.id}`, error);
      }
    }
  }

  async sendTo(worker: ManagedWorker, message: string): Promise<void> {
    if (!isActiveWorkerStatus(worker.status)) {
      throw new Error(`That background task is already ${worker.status.replace("_", " ")}.`);
    }
    if (worker.status === "queued" || worker.status === "starting" || !worker.transport) {
      // It cannot hear us yet, but the correction still matters, so it waits.
      worker.pending.push(message);
      return;
    }
    this.#armTurnTimer(worker);
    await worker.transport.send(message);
  }

  async interruptWorker(
    worker: ManagedWorker,
    reason: string,
    options: WorkerInterruptOptions = {},
  ): Promise<void> {
    const windDown = options.windDown ?? true;
    if (!isActiveWorkerStatus(worker.status)) return;
    if (worker.status === "queued") {
      await this.#settle(worker, "cancelled");
      return;
    }
    worker.status = "winding_down";
    this.#changed();
    try {
      await worker.transport?.interrupt();
    } catch (error) {
      console.error(`Could not interrupt ${worker.spec.id}`, error);
    }
    this.#publish(worker, { type: "interrupted", payload: { reason, windDown } });
    if (!windDown) {
      await this.#settle(worker, "cancelled");
      return;
    }
    // The interrupt has to land before the wind-down message, or the message
    // just queues behind the work we are trying to stop.
    try {
      await worker.transport?.send(windDownMessage(reason));
    } catch (error) {
      console.error(`Could not deliver the wind-down message to ${worker.spec.id}`, error);
    }
    const grace = this.options.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS;
    if (worker.windDownTimer) clearTimeout(worker.windDownTimer);
    worker.windDownTimer = setTimeout(() => {
      // Cancelled, not killed: the engine keeps its session, so the same work
      // can be resumed later instead of restarted from nothing.
      if (worker.status === "winding_down") void this.#settle(worker, "cancelled");
    }, grace);
    worker.windDownTimer.unref?.();
  }

  async killWorker(worker: ManagedWorker): Promise<void> {
    worker.killing = true;
    const transport = worker.transport;
    if (!transport) {
      if (isActiveWorkerStatus(worker.status)) await this.#settle(worker, "cancelled");
      return;
    }
    try {
      transport.signal("SIGTERM");
    } catch (error) {
      console.error(`Could not signal ${worker.spec.id}`, error);
    }
    // SIGKILL only if SIGTERM was not enough; a process that already left
    // should not hold shutdown open for the full grace period.
    if (!worker.exited) {
      await new Promise<void>((resolve) => {
        const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        worker.exitWaiters.push(resolve);
        worker.killTimer = setTimeout(resolve, grace);
        worker.killTimer.unref?.();
      });
    }
    try {
      transport.signal("SIGKILL");
      transport.dispose();
    } catch (error) {
      console.error(`Could not stop ${worker.spec.id}`, error);
    }
    this.#recorder.clearPid(worker.spec.id);
    if (isActiveWorkerStatus(worker.status)) await this.#settle(worker, "cancelled");
  }

  disposeWorker(worker: ManagedWorker): void {
    this.#clearTimers(worker);
    worker.transport?.dispose();
    worker.transport = undefined;
    this.#recorder.clearPid(worker.spec.id);
    this.#workers.delete(worker.spec.id);
    this.#changed();
  }

  #onExit(worker: ManagedWorker, exit: WorkerExit): void {
    worker.exited = true;
    for (const resolve of worker.exitWaiters.splice(0, worker.exitWaiters.length)) resolve();
    if (!isActiveWorkerStatus(worker.status)) return;
    if (exit.error) {
      void this.#fail(worker, exit.error);
      return;
    }
    // A transport only reports an exit once it is finished for good, so an
    // unexplained one is a worker that died holding unfinished work.
    const cancelled = worker.killing || worker.status === "winding_down";
    void this.#settle(worker, cancelled ? "cancelled" : "failed");
  }

  async #fail(worker: ManagedWorker, error: string): Promise<void> {
    worker.report = worker.report ?? error;
    this.#publish(worker, { type: "error", payload: { error, fatal: true } });
    await this.#settle(worker, "failed");
  }

  async #settle(worker: ManagedWorker, status: WorkerStatus): Promise<void> {
    if (!isActiveWorkerStatus(worker.status)) return;
    this.#clearTimers(worker);
    this.#flushCollapsed(worker);
    worker.status = status;
    this.#recorder.clearPid(worker.spec.id);
    this.#changed();
    await this.#drain();
  }

  #clearTimers(worker: ManagedWorker): void {
    for (const timer of [worker.turnTimer, worker.windDownTimer, worker.killTimer]) {
      if (timer) clearTimeout(timer);
    }
    worker.turnTimer = undefined;
    worker.windDownTimer = undefined;
    worker.killTimer = undefined;
  }
}
