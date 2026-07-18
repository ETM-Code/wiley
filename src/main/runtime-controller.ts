import { IPC, type AgentEvent, type JobSummary, type RuntimeState } from "./contracts";
import type { RuntimeLedger } from "./ledger";
import { PiRuntime } from "./pi-runtime";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";

export class RuntimeController {
  #microphoneEnabled = false;

  constructor(
    private readonly ledger: RuntimeLedger,
    private readonly transcript: TranscriptStore,
    private readonly pi: PiRuntime,
    private readonly canvas: CanvasBridge,
    private readonly send: (channel: string, payload: unknown) => void,
  ) {
    this.pi.onEvent((event) => void this.#onAgentEvent(event));
  }

  getState(): RuntimeState {
    return {
      microphoneEnabled: this.#microphoneEnabled,
      agentRunning: this.pi.isRunning,
      activeJobs: this.listActiveJobs(),
      boardRevision: this.canvas.getSnapshot().revision,
      voiceModel: "gpt-realtime-2.1",
      agentModel: "gpt-5.6-luna",
      reasoningEffort: "medium",
    };
  }

  setMicrophoneEnabled(enabled: boolean): RuntimeState {
    this.#microphoneEnabled = enabled;
    return this.#broadcastState();
  }

  async recoverInterruptedJobs(): Promise<void> {
    const now = new Date().toISOString();
    for (const job of this.listActiveJobs()) {
      await this.ledger.putJob({ ...job, status: "paused", updatedAt: now });
    }
    this.#broadcastState();
  }

  listActiveJobs(): JobSummary[] {
    return this.ledger
      .listJobs()
      .filter((job) => !["completed", "failed", "cancelled"].includes(job.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async submitJob(task: string, userWords: string, queue = false): Promise<{ status: "started"; jobId: string }> {
    const now = new Date().toISOString();
    const normalizedTask = task.trim();
    const normalizedWords = userWords.trim();
    if (!normalizedTask || !normalizedWords) throw new Error("Task and user_words are required");
    const active = queue ? undefined : this.listActiveJobs().at(-1);
    if (active) {
      const steered: JobSummary = {
        ...active,
        task: normalizedTask,
        userWords: normalizedWords,
        status: "interrupting",
        updatedAt: now,
      };
      await this.ledger.putJob(steered);
      void this.#dispatch(steered, false);
      this.#broadcastState();
      return { status: "started", jobId: active.id };
    }
    const job: JobSummary = {
      id: crypto.randomUUID(),
      task: normalizedTask,
      userWords: normalizedWords,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    await this.ledger.putJob(job);
    void this.#dispatch(job, queue);
    this.#broadcastState();
    return { status: "started", jobId: job.id };
  }

  async steerJob(jobId: string, task: string, userWords: string): Promise<{ status: "steering"; jobId: string }> {
    const job = this.#requireJob(jobId);
    const interrupting = { ...job, task, userWords, status: "interrupting" as const, updatedAt: new Date().toISOString() };
    await this.ledger.putJob(interrupting);
    // runTask's single-flight delivery aborts the root turn before accepting
    // the correction; the root then propagates it to affected workers.
    void this.#dispatch(interrupting, false);
    this.#broadcastState();
    return { status: "steering", jobId };
  }

  async pauseJob(jobId: string): Promise<void> {
    const job = this.#requireJob(jobId);
    await this.pi.abort(`Pause job ${jobId}`);
    await this.ledger.putJob({ ...job, status: "paused", updatedAt: new Date().toISOString() });
    this.#broadcastState();
  }

  async resumeJob(jobId: string): Promise<void> {
    const job = this.#requireJob(jobId);
    if (job.status !== "paused") throw new Error(`Job ${jobId} is not paused`);
    void this.#dispatch({ ...job, task: `Resume this paused job: ${job.task}` }, false);
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = this.#requireJob(jobId);
    await this.pi.abort(`Cancel job ${jobId}`);
    await this.ledger.putJob({ ...job, status: "cancelled", updatedAt: new Date().toISOString() });
    this.#broadcastState();
  }

  async abortCurrent(): Promise<void> {
    await this.pi.abort();
    for (const job of this.listActiveJobs()) {
      await this.ledger.putJob({ ...job, status: "cancelled", updatedAt: new Date().toISOString() });
    }
    this.#broadcastState();
  }

  #requireJob(id: string): JobSummary {
    const job = this.ledger.getJob(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  async #dispatch(job: JobSummary, queue: boolean): Promise<void> {
    const running = { ...job, status: "running" as const, updatedAt: new Date().toISOString() };
    await this.ledger.putJob(running);
    this.#broadcastState();
    try {
      await this.pi.runTask(running, { queue });
    } catch (error) {
      await this.ledger.putJob({ ...running, status: "failed", updatedAt: new Date().toISOString() });
      this.#broadcastState();
      this.#send(IPC.agentEvents, { type: "error", error: String(error), jobId: job.id });
    }
  }

  async #onAgentEvent(event: AgentEvent): Promise<void> {
    this.#send(IPC.agentEvents, event);
    if (event.agentId === "root" && event.type === "error" && !this.pi.hasActiveSubagents(event.jobId)) {
      const job = this.ledger.getJob(event.jobId);
      if (job && !["cancelled", "completed"].includes(job.status)) {
        await this.ledger.putJob({ ...job, status: "failed", updatedAt: new Date().toISOString() });
      }
    }
    if (event.agentId === "root" && event.type === "completed" && !this.pi.hasActiveSubagents(event.jobId)) {
      const job = this.ledger.getJob(event.jobId);
      if (job && !["cancelled", "failed"].includes(job.status)) {
        await this.ledger.putJob({ ...job, status: "completed", updatedAt: new Date().toISOString() });
      }
    }
    this.#broadcastState();
  }

  #broadcastState(): RuntimeState {
    const state = this.getState();
    this.#send(IPC.runtimeState, state);
    return state;
  }

  #send(channel: string, payload: unknown): void {
    this.send(channel, payload);
  }
}
