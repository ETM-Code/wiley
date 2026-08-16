import {
  ModelRuntime,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  BOARD_AGENT_SYSTEM_PROMPT,
  EXTERNAL_WORKER_BRIEF,
  INTERRUPT_NOTE,
  SUBAGENT_SYSTEM_PROMPT,
} from "./agent-prompt";
import type { AgentEvent, JobSummary, WorkerProbes } from "../shared/contracts";
import type { RuntimeLedger } from "./ledger";
import { type TranscriptStore } from "./transcript";
import { type CanvasBridge } from "./canvas-bridge";
import type { ApprovalJudge } from "./safety";
import { type VoiceBridge } from "./voice-bridge";
import { MAX_ACTIVE_SUBAGENTS } from "./pi/constants";
import { lastAssistantText } from "./pi/messages";
import { buildSubagentMessage, buildTaskMessage, buildWorkerMessage } from "./pi/prompt-context";
import {
  clearsPreviewWhenDone,
  DiagramPreviewQueue,
  previewsWhileStreaming,
} from "./pi/diagram-preview-queue";
import { redact } from "./pi/redact";
import { createApprovalJudge, createGuardExtension } from "./pi/safety-extension";
import { createRootSession, createSubagentSession, resolveModel, type PiSessionOptions } from "./pi/session-factory";
import {
  assertSpawnModelAllowed,
  diffSessionModels,
  resolveSessionModels,
  type SessionModelPlan,
} from "./pi/session-models";
import { createPiTools, type CanvasMutation, type PiToolHost } from "./pi/tools";
import { resolveOpenAiKey } from "./settings/secret-store";
import { DEFAULT_SETTINGS, type WileySettings } from "./settings/settings-schema";
import { type SettingsStore } from "./settings/settings-store";
import { WorkerCursors } from "./workers/worker-context";
import type { WorkerManager } from "./workers/worker-manager";
import { createWorkerManager, createWorkerProbes, reapStaleWorkerProcesses } from "./workers/worker-runtime";
import { assertWorkerSpawnAllowed, resolveWorkerModel } from "./workers/worker-spawn";
import { isCliWorkerKind, type WorkerEvent, type WorkerHandle, type WorkerKind } from "./workers/worker-types";

export { DEFAULT_APPROVAL_MODEL, PI_MODEL, PI_PROVIDER, PI_THINKING_LEVEL } from "./pi/constants";

type SubStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** How long a probe answer is trusted before the CLIs are checked again. */
const PROBE_CACHE_MS = 60_000;

export interface AgentListing {
  id: string;
  kind: WorkerKind;
  status: string;
  task: string;
  report?: string;
}

interface Subagent {
  id: string;
  parentJobId: string;
  task: string;
  status: SubStatus;
  session?: AgentSession;
  report?: string;
  runGeneration: number;
}

interface WarmSubagent {
  id: string;
  session: AgentSession;
}

/**
 * Persistent root Pi session plus event-driven in-process subagents.
 * Every inbound root delivery passes through #mainDeliveryTail, which protects
 * abort + prompt acceptance without waiting for the full run.
 */
export class PiRuntime {
  #main?: AgentSession;
  #modelRuntime?: ModelRuntime;
  #rootGeneration = 0;
  #mainDeliveryTail: Promise<unknown> = Promise.resolve();
  #subDeliveryTails = new Map<string, Promise<unknown>>();
  #subagents = new Map<string, Subagent>();
  #spawnQueue: Subagent[] = [];
  #warmSubagent?: WarmSubagent;
  #warmingSubagent?: Promise<void>;
  #pendingSubQuestions = new Map<string, (answer: string) => void>();
  #currentJobId?: string;
  #eventListeners = new Set<(event: AgentEvent) => void>();
  #diagramPreviews: DiagramPreviewQueue;
  #approvalJudge?: ApprovalJudge;
  #eventBaseline = 0;
  #plan: SessionModelPlan = resolveSessionModels(DEFAULT_SETTINGS);
  /** A model change that arrived mid-turn, applied at the next quiet point. */
  #pendingRootPlan?: SessionModelPlan;
  #unsubscribeSettings?: () => void;
  #apiKey?: string;
  #workers?: WorkerManager;
  /** Per-worker transcript cursors; the root's is never touched by these. */
  #workerCursors = new WorkerCursors();
  #probes?: WorkerProbes;
  #probedAt = 0;
  #probeWorkers = createWorkerProbes(() => this.#settings());

  constructor(
    private readonly projectDir: string,
    private readonly ledger: RuntimeLedger,
    private readonly transcript: TranscriptStore,
    private readonly canvas: CanvasBridge,
    private readonly voice: VoiceBridge,
    private readonly skillsDir?: string,
    private readonly settings?: SettingsStore,
    /** Where worker transcripts and the pid registry live. */
    private readonly dataDir?: string,
  ) {
    this.#diagramPreviews = new DiagramPreviewQueue(canvas);
  }

  /** Exposed so the settings surface can list the models this install can run. */
  get modelRuntime(): ModelRuntime | undefined {
    return this.#modelRuntime;
  }

  async initialize(): Promise<void> {
    this.#modelRuntime = await ModelRuntime.create();
    this.#plan = resolveSessionModels(this.#settings());
    await this.#applyApiKey();
    if (!resolveModel(this.#modelRuntime, this.#plan.provider, this.#plan.rootModel)) {
      throw new Error(`Pi model not found: ${this.#plan.provider}/${this.#plan.rootModel}`);
    }
    this.#approvalJudge = this.#buildApprovalJudge();
    this.#startWorkerRuntime();
    this.#unsubscribeSettings = this.settings?.onChange((next) => this.#onSettingsChanged(next));
    await this.#createRootSession();
    await this.#ensureWarmSubagent();
  }

  /**
   * External workers are optional: a machine with neither CLI installed runs
   * exactly as before, and the reaper only has to look where a previous run
   * would have recorded something.
   */
  #startWorkerRuntime(): void {
    const reaped = reapStaleWorkerProcesses(this.dataDir);
    if (reaped > 0) console.log(`Stopped ${reaped} worker process group(s) left by a previous run`);
    this.#workers = createWorkerManager({
      projectDir: this.projectDir,
      dataDir: this.dataDir,
      settings: () => this.#settings(),
      voice: this.voice,
      recentUserRequests: () => this.ledger.getTranscript()
        .filter((entry) => entry.role === "user")
        .slice(-6)
        .map((entry) => entry.text),
      approvalJudge: () => this.#approvalJudge,
      emit: (event) => this.#onWorkerEvent(event),
      executables: () => ({
        claude: this.#probes?.claude.path,
        codex: this.#probes?.codex.path,
      }),
    });
  }

  /** Cached briefly: a spawn should not wait on two process probes every time. */
  async #workerProbes(): Promise<WorkerProbes | undefined> {
    if (this.#probes && Date.now() - this.#probedAt < PROBE_CACHE_MS) return this.#probes;
    try {
      this.#probes = await this.#probeWorkers();
      this.#probedAt = Date.now();
    } catch (error) {
      console.error("Could not check which worker CLIs are available", error);
    }
    return this.#probes;
  }

  async #spawnWorker(input: { task: string; kind: WorkerKind; model?: string; effort?: string }): Promise<string> {
    const manager = this.#workers;
    if (!manager || !isCliWorkerKind(input.kind)) {
      throw new Error(`Background ${input.kind} workers are not available in this session.`);
    }
    const settings = this.#settings();
    assertWorkerSpawnAllowed({
      kind: input.kind,
      settings,
      probes: await this.#workerProbes(),
      model: input.model,
    });
    const id = `${input.kind}-${crypto.randomUUID().slice(0, 8)}`;
    const worker = settings.workers[input.kind];
    manager.register({
      id,
      kind: input.kind,
      parentJobId: this.#currentJobId ?? "system",
      task: input.task,
      prompt: buildWorkerMessage({
        brief: EXTERNAL_WORKER_BRIEF,
        task: input.task,
        // The worker's own cursor opens here. The root's delivery cursor is
        // deliberately untouched: it must still see every entry exactly once.
        transcriptContext: this.#workerCursors.open(id, this.transcript),
        peerEvents: this.ledger.getAgentEvents(this.#eventBaseline),
      }),
      model: resolveWorkerModel(input.kind, settings, input.model),
      effort: input.effort ?? worker.effort,
    });
    return id;
  }

  #worker(id: string): WorkerHandle | undefined {
    return this.#workers?.get(id);
  }

  /**
   * A worker's terminal event is the coordinator's cue, exactly as an
   * in-process subagent's is, so both arrive on the root in the same envelope.
   */
  async #onWorkerEvent(event: WorkerEvent): Promise<void> {
    await this.#emit(event);
    const payload = event.payload as { report?: string; error?: string; fatal?: boolean } | undefined;
    if (event.type === "completed") {
      await this.#deliverWorkerResult(event.agentId, "done", payload?.report ?? "");
    } else if (event.type === "error" && payload?.fatal) {
      await this.#deliverWorkerResult(event.agentId, "failed", payload?.error ?? "The worker stopped.");
    }
  }

  async #deliverWorkerResult(id: string, status: string, report: string): Promise<void> {
    this.#workerCursors.close(id);
    if (!this.#main) return;
    try {
      await this.#injectMain(
        this.#main,
        "[update from your own background work]",
        `<subagent_result id="${id}" status="${status}">\n${report}\n</subagent_result>`,
        true,
      );
    } catch (error) {
      console.error(`Could not deliver the report from ${id}`, error);
    }
  }

  #settings(): WileySettings {
    return this.settings?.get() ?? DEFAULT_SETTINGS;
  }

  #buildApprovalJudge(): ApprovalJudge | undefined {
    return createApprovalJudge({
      enabled: this.#plan.approvalEnabled,
      provider: this.#plan.provider,
      model: this.#plan.approvalModel,
    });
  }

  /**
   * A key typed into Settings has to reach the SDK, but the environment still
   * wins so a developer's .env keeps behaving the way it always has.
   */
  async #applyApiKey(): Promise<void> {
    const resolved = resolveOpenAiKey({ env: process.env, store: this.settings?.secrets });
    if (!resolved.key || resolved.key === this.#apiKey) return;
    this.#apiKey = resolved.key;
    await this.#modelRuntime?.setRuntimeApiKey(this.#plan.provider, resolved.key);
  }

  /**
   * Settings changes never interrupt work. The approval judge and the warm
   * worker are rebuilt immediately because neither is mid-turn; the root
   * session's model is queued behind the main delivery lock and, if a turn is
   * streaming, deferred again until that turn settles.
   */
  #onSettingsChanged(settings: WileySettings): void {
    const previous = this.#plan;
    const next = resolveSessionModels(settings);
    this.#plan = next;
    const changed = diffSessionModels(previous, next);
    void this.#applyApiKey().catch((error: unknown) =>
      console.error("Could not apply the configured API key", error));
    if (changed.approval) this.#approvalJudge = this.#buildApprovalJudge();
    if (changed.subagent) {
      // The warm worker was built on the old model, so it is no longer the
      // thing the next spawn asked for.
      this.#warmSubagent?.session.dispose();
      this.#warmSubagent = undefined;
      void this.#ensureWarmSubagent().catch((error: unknown) =>
        console.error("Could not prewarm a worker on the new model", error));
    }
    if (changed.root) {
      this.#pendingRootPlan = next;
      void this.#flushPendingRootPlan();
    }
  }

  #flushPendingRootPlan(): Promise<void> {
    return this.#withMainLock(async () => {
      const plan = this.#pendingRootPlan;
      const session = this.#main;
      const runtime = this.#modelRuntime;
      if (!plan || !session || !runtime) return;
      // Swapping the model underneath a turn in flight would finish that turn
      // on a different model than it started. #afterRootRun retries instead.
      if (session.isStreaming) return;
      this.#pendingRootPlan = undefined;
      try {
        const model = resolveModel(runtime, plan.provider, plan.rootModel);
        if (!model) throw new Error(`Pi model unavailable: ${plan.provider}/${plan.rootModel}`);
        await session.setModel(model);
        session.setThinkingLevel(plan.thinkingLevel);
      } catch (error) {
        await this.#emit({
          jobId: this.#currentJobId ?? "system",
          agentId: "root",
          type: "error",
          payload: { error: `Could not switch to ${plan.rootModel}: ${String(error)}` },
        });
      }
    });
  }

  async #createRootSession(): Promise<void> {
    const session = await createRootSession(
      this.#sessionOptions(BOARD_AGENT_SYSTEM_PROMPT, "root", this.#plan.rootModel),
    );
    this.#main = session;
    this.#subscribeSession(session, "root", () => this.#currentJobId ?? "system");
  }

  #sessionOptions(systemPrompt: string, agentId: string, model: string): PiSessionOptions {
    if (!this.#modelRuntime) throw new Error(`Pi model unavailable: ${this.#plan.provider}/${model}`);
    return {
      projectDir: this.projectDir,
      systemPrompt,
      guardExtension: this.#guardExtension(),
      modelRuntime: this.#modelRuntime,
      customTools: this.#tools(agentId),
      provider: this.#plan.provider,
      model,
      thinkingLevel: this.#plan.thinkingLevel,
      skillPaths: this.skillsDir ? [this.skillsDir] : [],
    };
  }

  /**
   * Fresh start: a brand-new root session with empty context, all workers
   * gone, and the shared event feed baselined so new agents never see the
   * previous session's noise. The durable ledger keeps everything.
   */
  async startNewSession(): Promise<void> {
    await this.abort("Starting a fresh session");
    for (const sub of this.#subagents.values()) sub.session?.dispose();
    this.#subagents.clear();
    this.#spawnQueue.length = 0;
    this.#subDeliveryTails.clear();
    this.#pendingSubQuestions.clear();
    this.#warmSubagent?.session.dispose();
    this.#warmSubagent = undefined;
    await this.#workers?.killAll();
    this.#workerCursors.clear();
    this.#main?.dispose();
    this.#main = undefined;
    this.#currentJobId = undefined;
    this.#eventBaseline = this.ledger.getAgentEvents().at(-1)?.sequence ?? 0;
    await this.#createRootSession();
    await this.#ensureWarmSubagent();
  }

  get isRunning(): boolean {
    return Boolean(this.#main?.isStreaming);
  }

  /** Every worker the coordinator can address, in-process ones and CLI ones. */
  listSubagents(): AgentListing[] {
    const pi: AgentListing[] = [...this.#subagents.values()].map(({ id, status, task, report }) => ({
      id,
      kind: "pi",
      status,
      task,
      report,
    }));
    const external: AgentListing[] = (this.#workers?.list() ?? []).map((worker) => ({
      id: worker.spec.id,
      kind: worker.spec.kind,
      status: worker.status,
      task: worker.spec.task,
      report: worker.report,
    }));
    return [...pi, ...external];
  }

  hasActiveSubagents(jobId?: string): boolean {
    const pi = [...this.#subagents.values()].some(
      (sub) => (sub.status === "queued" || sub.status === "running") && (!jobId || sub.parentJobId === jobId),
    );
    return pi || Boolean(this.#workers?.hasActive(jobId));
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async runTask(job: JobSummary, options: { queue?: boolean } = {}): Promise<void> {
    const session = this.#requireMain();
    this.voice.beginWork();
    this.#currentJobId = job.id;
    const delta = this.transcript.prepareDelta();
    const message = buildTaskMessage({
      task: job.task,
      userWords: job.userWords,
      transcriptEntries: delta.entries,
      board: this.canvas.getSnapshot(),
    });
    await this.#injectMain(session, "[new user message]", message, options.queue ?? false);
    this.transcript.commitDelivered(delta.cursor);
  }

  async abort(reason = "User stopped the current work"): Promise<void> {
    this.#rootGeneration += 1;
    this.#clearDiagramPreview();
    const main = this.#main;
    if (main?.isStreaming) await main.abort();
    await Promise.allSettled([
      ...[...this.#subagents.values()]
        .filter((sub) => sub.status === "running" && sub.session?.isStreaming)
        .map((sub) => this.#interruptSubagent(sub, reason, false)),
      // Wind-down rather than kill: an external worker keeps its session, so
      // the same work can be resumed instead of restarted from nothing.
      this.#workers?.interruptAll(reason, { windDown: true }) ?? Promise.resolve(),
    ]);
    this.voice.endWork();
  }

  async dispose(): Promise<void> {
    this.#unsubscribeSettings?.();
    this.#unsubscribeSettings = undefined;
    await this.abort("Application is closing");
    this.#main?.dispose();
    for (const sub of this.#subagents.values()) sub.session?.dispose();
    this.#warmSubagent?.session.dispose();
    this.#warmSubagent = undefined;
    await this.#workers?.killAll();
    this.#workerCursors.clear();
    this.#subagents.clear();
  }

  async #injectMain(session: AgentSession, origin: string, text: string, queue: boolean): Promise<void> {
    return this.#withMainLock(async () => {
      const generation = ++this.#rootGeneration;
      if (session.isStreaming && queue) {
        await this.#promptAccepted(session, text, generation, { streamingBehavior: "steer" });
      } else if (session.isStreaming) {
        await session.abort();
        await this.#emit({
          jobId: this.#currentJobId ?? "system",
          agentId: "root",
          type: "interrupted",
          payload: { origin },
        });
        await this.#promptAccepted(session, `${INTERRUPT_NOTE}\n${origin}\n${text}`, generation);
      } else {
        await this.#promptAccepted(session, text, generation);
      }
    });
  }

  #withMainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#mainDeliveryTail.then(fn, fn);
    this.#mainDeliveryTail = run.catch(() => undefined);
    return run;
  }

  #promptAccepted(
    session: AgentSession,
    text: string,
    generation: number,
    options: Record<string, unknown> = {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let preflightSettled = false;
      const run = session.prompt(text, {
        ...options,
        preflightResult: (accepted) => {
          preflightSettled = true;
          if (accepted) resolve();
          else reject(new Error("Pi rejected prompt preflight"));
        },
      });
      void run.then(
        () => {
          if (!preflightSettled) resolve();
          void this.#finishRootRun(generation).finally(() => this.#afterRootRun());
        },
        (error) => {
          if (!preflightSettled) reject(error);
          this.#afterRootRun();
          if (generation === this.#rootGeneration) {
            void this.#emit({
              jobId: this.#currentJobId ?? "system",
              agentId: "root",
              type: "error",
              payload: { error: String(error) },
            });
          }
        },
      );
    });
  }

  /** A turn just settled, so a model change that arrived during it can land. */
  #afterRootRun(): void {
    if (this.#pendingRootPlan) void this.#flushPendingRootPlan();
  }

  async #finishRootRun(generation: number): Promise<void> {
    if (generation !== this.#rootGeneration || this.hasActiveSubagents(this.#currentJobId)) return;
    const session = this.#main;
    if (!session) return;
    const report = lastAssistantText(session.messages);
    await this.#emit({
      jobId: this.#currentJobId ?? "system",
      agentId: "root",
      type: "completed",
      payload: { report },
    });
    this.voice.push(`[agent finished] ${report}`, { interrupt: true });
    this.voice.endWork();
  }

  #tools(agentId: string): ToolDefinition[] {
    return createPiTools(this.#toolHost(), agentId);
  }

  #toolHost(): PiToolHost {
    return {
      projectDir: this.projectDir,
      mutateCanvas: (agentId, operation, params, signal) => this.#mutateCanvas(agentId, operation, params, signal),
      canvasRequest: (op, signal) => this.canvas.request(op, undefined, signal),
      readConversation: (afterSequence) => this.transcript.after(afterSequence),
      readAgentEvents: (afterSequence) => this.ledger.getAgentEvents(Math.max(afterSequence, this.#eventBaseline)),
      narrate: (message, interrupt) => this.voice.push(`[agent progress] ${message}`, { interrupt }),
      askUser: (question, signal) => this.voice.ask(question, signal),
      askRoot: (subagentId, question, signal) => this.#askRoot(subagentId, question, signal),
      listSubagents: () => this.listSubagents(),
      messageSubagent: async (id, message) => {
        const worker = this.#worker(id);
        if (worker) {
          // The worker reads the conversation on its own cursor, so anything
          // said since it last heard from us rides along with the correction.
          const delta = this.#workerCursors.delta(id, this.transcript);
          const text = delta.length
            ? `${message}\n\n<voice_conversation_update>\n${JSON.stringify(delta)}\n</voice_conversation_update>`
            : message;
          await worker.send(text);
          return;
        }
        const sub = this.#subagents.get(id);
        if (!sub) throw new Error(`No such background task: ${id}`);
        await this.#interruptSubagent(sub, message, true);
      },
      spawnSubagent: (input) => (input.kind && input.kind !== "pi"
        ? this.#spawnWorker({ task: input.task, kind: input.kind, model: input.model, effort: input.effort })
        : this.#spawnSubagent(input.task, this.#currentJobId ?? "system")),
      checkSubagent: (id) => {
        const worker = this.#worker(id);
        if (worker) return { status: worker.status, report: worker.report, kind: worker.spec.kind };
        const sub = this.#subagents.get(id);
        if (!sub) throw new Error(`No such background task: ${id}`);
        return { status: sub.status, report: sub.report, kind: "pi" as const };
      },
      answerSubagent: (qid, answer) => {
        const resolve = this.#pendingSubQuestions.get(qid);
        if (!resolve) throw new Error(`No pending question: ${qid}`);
        this.#pendingSubQuestions.delete(qid);
        resolve(answer);
      },
    };
  }

  #askRoot(subId: string, question: string, signal?: AbortSignal): Promise<string> {
    const qid = crypto.randomUUID();
    return new Promise<string>((resolve) => {
      this.#pendingSubQuestions.set(qid, resolve);
      signal?.addEventListener("abort", () => {
        this.#pendingSubQuestions.delete(qid);
        resolve("Aborted before an answer arrived.");
      }, { once: true });
      void this.#injectMain(
        this.#requireMain(),
        "[question from your own background work]",
        `<subagent_question id="${subId}" qid="${qid}">\n${question}\n</subagent_question>\nAnswer via answer_subagent.`,
        true,
      );
    });
  }

  async #spawnSubagent(task: string, parentJobId: string): Promise<string> {
    assertSpawnModelAllowed(this.#settings(), this.#plan.subagentModel);
    const warm = this.#warmSubagent;
    if (warm) this.#warmSubagent = undefined;
    const sub: Subagent = {
      id: warm?.id ?? `sub-${crypto.randomUUID().slice(0, 8)}`,
      parentJobId,
      task,
      status: "queued",
      session: warm?.session,
      runGeneration: 0,
    };
    this.#subagents.set(sub.id, sub);
    this.#spawnQueue.push(sub);
    void this.#drainSpawnQueue();
    return sub.id;
  }

  async #drainSpawnQueue(): Promise<void> {
    const active = [...this.#subagents.values()].filter((sub) => sub.status === "running").length;
    if (active >= MAX_ACTIVE_SUBAGENTS) return;
    const sub = this.#spawnQueue.shift();
    if (!sub) return;
    try {
      await this.#startSubagent(sub);
    } catch (error) {
      sub.status = "failed";
      sub.report = String(error);
      await this.#emit({
        jobId: sub.parentJobId,
        agentId: sub.id,
        parentAgentId: "root",
        type: "error",
        payload: { error: String(error) },
      });
    } finally {
      if (this.#spawnQueue.length) void this.#drainSpawnQueue();
    }
  }

  async #startSubagent(sub: Subagent): Promise<void> {
    const session = sub.session ?? await this.#createSubagentSession(sub.id);
    sub.session = session;
    sub.status = "running";
    this.#subscribeSession(session, sub.id, () => sub.parentJobId, "root");
    void this.#ensureWarmSubagent().catch((error) => this.#emit({
      jobId: sub.parentJobId,
      agentId: "root",
      type: "error",
      payload: { error: `Could not prewarm replacement worker: ${String(error)}` },
    }));
    const message = buildSubagentMessage({
      task: sub.task,
      transcriptContext: this.transcript.contextForNewAgent(),
      peerEvents: this.ledger.getAgentEvents(this.#eventBaseline),
    });
    this.#startSubRun(sub, message);
  }

  async #createSubagentSession(agentId: string): Promise<AgentSession> {
    return createSubagentSession(this.#sessionOptions(SUBAGENT_SYSTEM_PROMPT, agentId, this.#plan.subagentModel));
  }

  async #ensureWarmSubagent(): Promise<void> {
    if (this.#warmSubagent) return;
    if (this.#warmingSubagent) return this.#warmingSubagent;
    const id = `sub-${crypto.randomUUID().slice(0, 8)}`;
    const warming = this.#createSubagentSession(id).then((session) => {
      this.#warmSubagent = { id, session };
    });
    this.#warmingSubagent = warming.finally(() => {
      this.#warmingSubagent = undefined;
    });
    return this.#warmingSubagent;
  }

  #startSubRun(sub: Subagent, message: string): void {
    const session = sub.session;
    if (!session) throw new Error(`${sub.id} has no session`);
    const generation = ++sub.runGeneration;
    void session.prompt(message).then(
      () => this.#finishSubRun(sub, generation, "done", lastAssistantText(session.messages)),
      (error) => this.#finishSubRun(sub, generation, "failed", String(error)),
    );
  }

  async #finishSubRun(sub: Subagent, generation: number, status: "done" | "failed", report: string): Promise<void> {
    if (generation !== sub.runGeneration) return;
    sub.status = status;
    sub.report = report;
    await this.#emit({ jobId: sub.parentJobId, agentId: sub.id, parentAgentId: "root", type: status === "done" ? "completed" : "error", payload: { report } });
    await this.#injectMain(
      this.#requireMain(),
      "[update from your own background work]",
      `<subagent_result id="${sub.id}" status="${status}">\n${report}\n</subagent_result>`,
      true,
    );
    sub.session?.dispose();
    void this.#drainSpawnQueue();
  }

  async #interruptSubagent(sub: Subagent, message: string, restart: boolean): Promise<void> {
    if (sub.status !== "running" || !sub.session) throw new Error(`${sub.id} is ${sub.status}`);
    const tail = this.#subDeliveryTails.get(sub.id) ?? Promise.resolve();
    const run = tail.then(async () => {
      // Invalidate the current run before aborting. Its settle callback can
      // now fire in any order without ever publishing a premature result.
      sub.runGeneration += 1;
      if (sub.session?.isStreaming) await sub.session.abort();
      await this.#emit({ jobId: sub.parentJobId, agentId: sub.id, parentAgentId: "root", type: "interrupted", payload: { message } });
      if (restart) this.#startSubRun(sub, `${INTERRUPT_NOTE}\n[message from coordinator]\n${message}`);
      else {
        sub.status = "cancelled";
      }
    });
    this.#subDeliveryTails.set(sub.id, run.catch(() => undefined));
    return run;
  }

  #subscribeSession(session: AgentSession, agentId: string, jobId: () => string, parentAgentId?: string): void {
    session.subscribe((event) => {
      const value = event as unknown as Record<string, unknown>;
      if (value.type === "message_update" && agentId === "root") {
        const update = value.assistantMessageEvent as Record<string, unknown> | undefined;
        if (update?.type === "toolcall_delta" || update?.type === "toolcall_end") {
          const toolCall = update.type === "toolcall_end"
            ? update.toolCall as Record<string, unknown> | undefined
            : ((update.partial as { content?: unknown[] } | undefined)?.content?.[Number(update.contentIndex)] as Record<string, unknown> | undefined);
          if (toolCall && previewsWhileStreaming(toolCall.name)) {
            this.#diagramPreviews.queue(toolCall.arguments, update.type === "toolcall_end");
          }
        } else if (update?.type === "error") {
          this.#clearDiagramPreview();
        }
      } else if (value.type === "tool_execution_start") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_started", payload: redact({ toolName: value.toolName, input: value.args ?? value.input }) });
      } else if (value.type === "tool_execution_end") {
        if (agentId === "root" && previewsWhileStreaming(value.toolName)) {
          if (value.isError) this.#clearDiagramPreview();
          else this.#diagramPreviews.reset();
        } else if (agentId === "root" && clearsPreviewWhenDone(value.toolName)) {
          // An update is never previewed, so anything still showing is stale
          // from an earlier draw and has to come off either way.
          this.#clearDiagramPreview();
        }
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_completed", payload: redact({ toolName: value.toolName, isError: value.isError, result: value.result }) });
      } else if (value.type === "tool_execution_update") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_progress", payload: redact(value) });
      } else if (value.type === "message_end") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "assistant_message", payload: redact(value.message) });
      }
    });
  }

  #clearDiagramPreview(): void {
    this.#diagramPreviews.reset();
    this.canvas.clearDiagramPreview();
  }

  async #emit(event: Omit<AgentEvent, "id" | "sequence" | "at">): Promise<void> {
    const persisted = await this.ledger.appendAgentEvent(event);
    for (const listener of this.#eventListeners) listener(persisted);
  }

  async #mutateCanvas(
    agentId: string,
    operation: CanvasMutation,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ids = operation === "apply-patch"
      ? [
          ...((params.updates as Array<{ id?: string }> | undefined) ?? []).map((update) => update.id),
          ...((params.deletes as string[] | undefined) ?? []),
        ].filter((id): id is string => Boolean(id))
      : [];
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error("Canvas mutation aborted");
      const lease = ids.length ? this.canvas.acquireLease(agentId, ids) : undefined;
      const snapshot = this.canvas.getSnapshot();
      try {
        return await this.canvas.applyTransaction({
          id: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          agentId,
          jobId: agentId === "root"
            ? this.#currentJobId ?? "system"
            : this.#subagents.get(agentId)?.parentJobId ?? "system",
          baseRevision: snapshot.revision,
          leaseIds: lease ? [lease.id] : [],
          summary: `${operation} by ${agentId}`,
          operation,
          params,
        }, signal);
      } catch (error) {
        lastError = error;
        if (!/revision conflict/i.test(String(error))) throw error;
      } finally {
        if (lease) this.canvas.releaseLease(lease.id, agentId);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #requireMain(): AgentSession {
    if (!this.#main) throw new Error("Pi runtime is not initialized");
    return this.#main;
  }

  #guardExtension(): InlineExtension {
    return createGuardExtension({
      projectDir: this.projectDir,
      voice: this.voice,
      ledger: this.ledger,
      approvalJudge: () => this.#approvalJudge,
    });
  }
}
