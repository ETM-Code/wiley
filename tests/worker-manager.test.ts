import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, type WileySettings } from "../src/main/settings/settings-schema";
import { WorkerManager, windDownMessage, type WorkerManagerOptions } from "../src/main/workers/worker-manager";
import {
  parsePidRecords,
  reapStaleWorkers,
  stalePids,
  type PidRecord,
  type WorkerRecorder,
} from "../src/main/workers/worker-recorder";
import {
  WORKER_MILESTONE,
  type WorkerEvent,
  type WorkerEventDraft,
  type WorkerExit,
  type WorkerHandle,
  type WorkerSpec,
  type WorkerTransport,
} from "../src/main/workers/worker-types";

class FakeTransport implements WorkerTransport {
  readonly calls: string[] = [];
  readonly sent: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  pid = 4242;
  #events?: (event: WorkerEventDraft) => void;
  #exit?: (exit: WorkerExit) => void;
  #raw?: (line: string) => void;
  startError?: Error;

  constructor(readonly spec: WorkerSpec) {}

  async start(): Promise<void> {
    this.calls.push("start");
    if (this.startError) throw this.startError;
  }

  async send(text: string): Promise<void> {
    this.calls.push("send");
    this.sent.push(text);
  }

  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
  }

  signal(signal: NodeJS.Signals): void {
    this.calls.push(`signal:${signal}`);
    this.signals.push(signal);
  }

  onEvent(handler: (event: WorkerEventDraft) => void): void {
    this.#events = handler;
  }

  onExit(handler: (exit: WorkerExit) => void): void {
    this.#exit = handler;
  }

  onRaw(handler: (line: string) => void): void {
    this.#raw = handler;
  }

  dispose(): void {
    this.calls.push("dispose");
  }

  emit(event: WorkerEventDraft): void {
    this.#events?.(event);
  }

  ready(sessionId = "sess-1"): void {
    this.emit({
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.ready, externalSessionId: sessionId },
    });
  }

  raw(line: string): void {
    this.#raw?.(line);
  }

  exit(exit: WorkerExit = { code: 0, signal: null }): void {
    this.#exit?.(exit);
  }
}

interface Harness {
  manager: WorkerManager;
  events: WorkerEvent[];
  transports: FakeTransport[];
  spoken: string[];
  settings: WileySettings;
  spawn(overrides?: Partial<WorkerSpec>): WorkerHandle;
  transportFor(handle: WorkerHandle): FakeTransport;
}

let counter = 0;

function harness(options: Partial<WorkerManagerOptions> = {}, settingsPatch: Partial<WileySettings> = {}): Harness {
  const events: WorkerEvent[] = [];
  const transports: FakeTransport[] = [];
  const spoken: string[] = [];
  const settings: WileySettings = {
    ...DEFAULT_SETTINGS,
    ...settingsPatch,
    workers: settingsPatch.workers ?? DEFAULT_SETTINGS.workers,
  };
  const manager = new WorkerManager({
    settings: () => settings,
    createTransport: (spec) => {
      const transport = new FakeTransport(spec);
      transports.push(transport);
      return transport;
    },
    emit: (event) => {
      events.push(event);
    },
    announce: (message) => spoken.push(message),
    ...options,
  });
  return {
    manager,
    events,
    transports,
    spoken,
    settings,
    spawn(overrides = {}) {
      counter += 1;
      return manager.register({
        id: `w-${counter}`,
        kind: "claude",
        parentJobId: "job-1",
        task: "do the thing",
        ...overrides,
      });
    },
    transportFor(handle) {
      const found = transports.find((transport) => transport.spec.id === handle.spec.id);
      if (!found) throw new Error(`No transport for ${handle.spec.id}`);
      return found;
    },
  };
}

/**
 * Lets the manager's internal awaits settle without advancing fake timers.
 * Emission is a promise chain that preserves ledger order, so draining a
 * burst of events costs one microtask tick each.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker lifecycle", () => {
  it("walks a worker from queued through running to done", async () => {
    const bench = harness();
    const worker = bench.spawn();
    expect(worker.status).toBe("queued");

    await settle();
    expect(worker.status).toBe("starting");

    bench.transportFor(worker).ready("sess-9");
    expect(worker.status).toBe("running");
    expect(worker.externalSessionId).toBe("sess-9");

    bench.transportFor(worker).emit({
      type: "completed",
      payload: { report: "built it", usage: { costUsd: 0.12 } },
    });
    await settle();

    expect(worker.status).toBe("done");
    expect(worker.report).toBe("built it");
    expect(worker.usage).toEqual({ costUsd: 0.12 });
    expect(bench.manager.hasActive("job-1")).toBe(false);
  });

  it("stamps every event with the worker, its job, and its kind", async () => {
    const bench = harness();
    const worker = bench.spawn({ kind: "codex" });
    await settle();
    bench.transportFor(worker).ready();
    await settle();

    expect(bench.events[0]).toMatchObject({
      jobId: "job-1",
      agentId: worker.spec.id,
      parentAgentId: "root",
      type: "milestone",
    });
    expect((bench.events[0].payload as { workerKind: string }).workerKind).toBe("codex");
  });

  it("redacts credential-shaped values on the way to the ledger", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).emit({
      type: "tool_started",
      payload: { toolName: "Bash", input: { command: "curl", apiKey: "sk-live-secret" } },
    });
    await settle();

    const payload = JSON.stringify(bench.events.at(-1)?.payload);
    expect(payload).not.toContain("sk-live-secret");
    expect(payload).toContain("[REDACTED]");
  });

  it("fails the worker when the transport cannot start at all", async () => {
    const bench = harness({
      createTransport: (spec) => {
        const transport = new FakeTransport(spec);
        transport.startError = new Error("claude not found");
        bench.transports.push(transport);
        return transport;
      },
    });
    const worker = bench.spawn();
    await settle();

    expect(worker.status).toBe("failed");
    expect(bench.events.at(-1)?.type).toBe("error");
    expect(worker.report).toContain("claude not found");
  });

  it("treats a fatal stream error as the end of the worker", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({ type: "error", payload: { error: "context exhausted", fatal: true } });
    await settle();

    expect(worker.status).toBe("failed");
  });

  it("keeps running after a non-fatal error such as a denied tool", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({ type: "error", payload: { error: "denied", denied: true } });
    await settle();

    expect(worker.status).toBe("running");
  });

  it("keeps running after an interrupt, because the process survives one", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({ type: "interrupted", payload: { reason: "aborted_streaming" } });
    await settle();

    expect(worker.status).toBe("running");
  });
});

describe("queueing", () => {
  it("holds workers of one kind at the configured concurrency", async () => {
    const settings: WileySettings = {
      ...DEFAULT_SETTINGS,
      workers: {
        ...DEFAULT_SETTINGS.workers,
        claude: { ...DEFAULT_SETTINGS.workers.claude, maxConcurrent: 2 },
      },
    };
    const bench = harness({ settings: () => settings });
    const first = bench.spawn();
    const second = bench.spawn();
    const third = bench.spawn();
    await settle();

    expect([first.status, second.status, third.status]).toEqual(["starting", "starting", "queued"]);

    bench.transportFor(first).emit({ type: "completed", payload: { report: "one" } });
    await settle();

    expect(third.status).toBe("starting");
  });

  it("counts the two kinds against separate limits", async () => {
    const settings: WileySettings = {
      ...DEFAULT_SETTINGS,
      workers: {
        claude: { ...DEFAULT_SETTINGS.workers.claude, maxConcurrent: 1 },
        codex: { ...DEFAULT_SETTINGS.workers.codex, maxConcurrent: 1 },
      },
    };
    const bench = harness({ settings: () => settings });
    const claude = bench.spawn({ kind: "claude" });
    const codex = bench.spawn({ kind: "codex" });
    await settle();

    expect(claude.status).toBe("starting");
    expect(codex.status).toBe("starting");
  });

  it("cancels a queued worker without ever starting it", async () => {
    const settings: WileySettings = {
      ...DEFAULT_SETTINGS,
      workers: {
        ...DEFAULT_SETTINGS.workers,
        claude: { ...DEFAULT_SETTINGS.workers.claude, maxConcurrent: 1 },
      },
    };
    const bench = harness({ settings: () => settings });
    bench.spawn();
    const queued = bench.spawn();
    await settle();

    await queued.interrupt("stop");
    expect(queued.status).toBe("cancelled");
    expect(bench.transports).toHaveLength(1);
  });
});

describe("steering", () => {
  it("delivers a correction to a running worker", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    await worker.send("use the other endpoint");
    expect(bench.transportFor(worker).sent).toEqual(["use the other endpoint"]);
  });

  it("holds a correction that arrives before the engine is listening", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();

    await worker.send("actually, use TypeScript");
    expect(bench.transportFor(worker).sent).toEqual([]);

    bench.transportFor(worker).ready();
    await settle();
    expect(bench.transportFor(worker).sent).toEqual(["actually, use TypeScript"]);
  });

  it("refuses to steer a worker that already finished, in plain language", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({ type: "completed", payload: { report: "done" } });
    await settle();

    await expect(worker.send("one more thing")).rejects.toThrow(/already done/);
  });
});

describe("wind-down", () => {
  it("interrupts first, then asks for a report, and leaves the process alive", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    await worker.interrupt("The user changed their mind");
    const transport = bench.transportFor(worker);

    expect(transport.calls).toEqual(["start", "interrupt", "send"]);
    expect(transport.sent[0]).toBe(windDownMessage("The user changed their mind"));
    expect(transport.signals).toEqual([]);
    expect(worker.status).toBe("winding_down");
  });

  it("cancels, but does not kill, a worker that never reports back in time", async () => {
    const bench = harness({ windDownGraceMs: 20_000 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    await worker.interrupt("stop");

    await vi.advanceTimersByTimeAsync(19_000);
    expect(worker.status).toBe("winding_down");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.status).toBe("cancelled");
    // Still resumable: nothing was signalled, so the engine keeps its session.
    expect(bench.transportFor(worker).signals).toEqual([]);
  });

  it("lets a winding-down worker finish cleanly if it reports in time", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();
    await worker.interrupt("stop");

    bench.transportFor(worker).emit({ type: "completed", payload: { report: "wrapped up" } });
    await settle();

    expect(worker.status).toBe("done");
    expect(worker.report).toBe("wrapped up");
  });

  it("skips the wind-down message entirely when the caller wants it gone now", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    await worker.interrupt("dangerous command", { windDown: false });
    expect(bench.transportFor(worker).sent).toEqual([]);
    expect(worker.status).toBe("cancelled");
  });

  it("winds every active worker down at once and leaves finished ones alone", async () => {
    const bench = harness();
    const first = bench.spawn();
    const second = bench.spawn();
    await settle();
    bench.transportFor(first).ready();
    bench.transportFor(second).ready();
    bench.transportFor(second).emit({ type: "completed", payload: { report: "done" } });
    await settle();

    await bench.manager.interruptAll("Application is closing");
    expect(first.status).toBe("winding_down");
    expect(second.status).toBe("done");
  });
});

describe("killing", () => {
  it("escalates SIGTERM to SIGKILL after the grace period", async () => {
    const bench = harness({ killGraceMs: 5_000 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    const killed = worker.kill();
    await settle();
    expect(bench.transportFor(worker).signals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(5_000);
    await killed;

    expect(bench.transportFor(worker).signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(worker.status).toBe("cancelled");
  });

  it("stops waiting as soon as the process actually exits", async () => {
    const bench = harness({ killGraceMs: 60_000 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    const killed = worker.kill();
    await settle();
    bench.transportFor(worker).exit({ code: null, signal: "SIGTERM" });
    await killed;

    expect(worker.status).toBe("cancelled");
  });

  it("signals every worker synchronously for the exit hook", async () => {
    const bench = harness();
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    bench.manager.killAllSync();
    expect(bench.transportFor(worker).signals).toEqual(["SIGKILL"]);
  });
});

describe("turn timeout", () => {
  it("fails a worker that goes silent for longer than the configured turn", async () => {
    const settings: WileySettings = {
      ...DEFAULT_SETTINGS,
      workers: {
        ...DEFAULT_SETTINGS.workers,
        claude: { ...DEFAULT_SETTINGS.workers.claude, turnTimeoutMs: 60_000 },
      },
    };
    const bench = harness({ settings: () => settings, killGraceMs: 10 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(worker.status).toBe("failed");
    expect(bench.spoken.join(" ")).toContain("went quiet");
  });

  it("resets the clock on every event the worker produces", async () => {
    const settings: WileySettings = {
      ...DEFAULT_SETTINGS,
      workers: {
        ...DEFAULT_SETTINGS.workers,
        claude: { ...DEFAULT_SETTINGS.workers.claude, turnTimeoutMs: 60_000 },
      },
    };
    const bench = harness({ settings: () => settings });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(50_000);
      bench.transportFor(worker).emit({ type: "assistant_message", payload: { text: `step ${index}` } });
    }

    expect(worker.status).toBe("running");
  });
});

describe("event rate limiting", () => {
  it("collapses a burst and says how many events were dropped", async () => {
    let clock = 0;
    const bench = harness({ now: () => clock, eventsPerSecond: 5 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    for (let index = 0; index < 40; index++) {
      bench.transportFor(worker).emit({ type: "assistant_message", payload: { text: `${index}` } });
    }
    await settle();
    const messages = bench.events.filter((event) => event.type === "assistant_message");
    expect(messages).toHaveLength(4);

    clock += 1_500;
    bench.transportFor(worker).emit({ type: "assistant_message", payload: { text: "after" } });
    await settle();
    const collapsed = bench.events.find(
      (event) => (event.payload as { kind?: string }).kind === WORKER_MILESTONE.collapsed,
    );
    expect(collapsed).toBeDefined();
    expect((collapsed?.payload as { count: number }).count).toBe(36);
  });

  it("never drops a terminal event, however loud the worker was", async () => {
    const bench = harness({ now: () => 0, eventsPerSecond: 2 });
    const worker = bench.spawn();
    await settle();
    bench.transportFor(worker).ready();

    for (let index = 0; index < 30; index++) {
      bench.transportFor(worker).emit({ type: "tool_started", payload: { toolName: "Bash" } });
    }
    bench.transportFor(worker).emit({ type: "completed", payload: { report: "finished anyway" } });
    await settle();

    expect(bench.events.at(-1)?.type).toBe("completed");
    expect(worker.status).toBe("done");
  });
});

describe("codex command tripwire", () => {
  it("stops a codex worker the moment it starts a dangerous command", async () => {
    const bench = harness({
      reviewCommand: async ({ command }) =>
        command.includes("rm -rf /") ? { allow: false, reason: "Recursive delete outside the project" } : { allow: true },
    });
    const worker = bench.spawn({ kind: "codex" });
    await settle();
    bench.transportFor(worker).ready();

    bench.transportFor(worker).emit({
      type: "tool_started",
      payload: { toolName: "bash", input: { command: "rm -rf /" } },
    });
    await settle();

    expect(worker.status).toBe("cancelled");
    expect(bench.spoken.join(" ")).toContain("dangerous command");
    expect(bench.events.some((event) => (event.payload as { blocked?: boolean }).blocked)).toBe(true);
  });

  it("leaves an ordinary command alone", async () => {
    const bench = harness({ reviewCommand: async () => ({ allow: true }) });
    const worker = bench.spawn({ kind: "codex" });
    await settle();
    bench.transportFor(worker).ready();

    bench.transportFor(worker).emit({
      type: "tool_started",
      payload: { toolName: "bash", input: { command: "npm test" } },
    });
    await settle();

    expect(worker.status).toBe("running");
  });

  it("does not run the tripwire for claude, which is checked before the fact", async () => {
    const reviewCommand = vi.fn(async () => ({ allow: false, reason: "no" }));
    const bench = harness({ reviewCommand });
    const worker = bench.spawn({ kind: "claude" });
    await settle();
    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({
      type: "tool_started",
      payload: { toolName: "bash", input: { command: "rm -rf /" } },
    });
    await settle();

    expect(reviewCommand).not.toHaveBeenCalled();
    expect(worker.status).toBe("running");
  });
});

describe("recording", () => {
  it("tees raw stream lines and tracks the process group", async () => {
    const lines: Array<[string, string]> = [];
    const pids: PidRecord[] = [];
    const recorder: WorkerRecorder = {
      line: (id, value) => lines.push([id, value]),
      registerPid: (record) => pids.push(record),
      clearPid: (id) => {
        const index = pids.findIndex((entry) => entry.workerId === id);
        if (index >= 0) pids.splice(index, 1);
      },
      listPids: () => pids,
    };
    const bench = harness({ recorder });
    const worker = bench.spawn({ kind: "codex" });
    await settle();

    bench.transportFor(worker).raw('{"type":"thread.started"}');
    await settle();
    expect(lines).toEqual([[worker.spec.id, '{"type":"thread.started"}']]);
    expect(pids).toEqual([{
      workerId: worker.spec.id,
      pid: 4242,
      kind: "codex",
      startedAt: expect.any(String) as never,
    }]);

    bench.transportFor(worker).ready();
    bench.transportFor(worker).emit({ type: "completed", payload: { report: "done" } });
    await settle();
    expect(pids).toEqual([]);
  });
});

describe("pid registry and reaper", () => {
  const record = (overrides: Partial<PidRecord> = {}): PidRecord => ({
    workerId: "w-1",
    pid: 999,
    kind: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("only reaps a pid the caller can confirm is still our worker", () => {
    const records = [record({ pid: 100 }), record({ workerId: "w-2", pid: 200 })];
    const reapable = stalePids(records, (entry) => entry.pid === 100);

    expect(reapable.map((entry) => entry.pid)).toEqual([100]);
  });

  it("ignores nonsense pids that could signal the whole process group", () => {
    expect(stalePids([record({ pid: 0 }), record({ pid: -1 }), record({ pid: 1 })], () => true)).toEqual([]);
  });

  it("kills every confirmed leftover and clears the registry", () => {
    const stored = [record({ pid: 100 }), record({ workerId: "w-2", pid: 200 })];
    const killed: number[] = [];
    const recorder: WorkerRecorder = {
      line: () => undefined,
      registerPid: () => undefined,
      clearPid: (id) => {
        const index = stored.findIndex((entry) => entry.workerId === id);
        if (index >= 0) stored.splice(index, 1);
      },
      listPids: () => [...stored],
    };

    const reaped = reapStaleWorkers({ recorder, isOurs: (entry) => entry.pid === 100, kill: (pid) => killed.push(pid) });

    expect(killed).toEqual([100]);
    expect(reaped).toHaveLength(1);
    // Even the unconfirmed record goes, so a dead pid is not retried forever.
    expect(stored).toEqual([]);
  });

  it("survives a corrupt or hand-edited registry file", () => {
    expect(parsePidRecords("not json")).toEqual([]);
    expect(parsePidRecords('{"pid":1}')).toEqual([]);
    expect(parsePidRecords('[{"workerId":"w","pid":5,"kind":"nope"}]')).toEqual([]);
    expect(parsePidRecords('[{"workerId":"w","pid":5,"kind":"codex","startedAt":"x"}]')).toHaveLength(1);
  });
});
