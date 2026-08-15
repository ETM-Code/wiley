import { getModel } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BOARD_AGENT_SYSTEM_PROMPT, INTERRUPT_NOTE, SUBAGENT_SYSTEM_PROMPT } from "./agent-prompt";
import type { AgentEvent, JobSummary } from "../shared/contracts";
import type { RuntimeLedger } from "./ledger";
import { type TranscriptStore } from "./transcript";
import { type CanvasBridge } from "./canvas-bridge";
import type { ApprovalJudge } from "./safety";
import { type VoiceBridge } from "./voice-bridge";
import { MAX_ACTIVE_SUBAGENTS, PI_MODEL, PI_PROVIDER } from "./pi/constants";
import { lastAssistantText } from "./pi/messages";
import { buildSubagentMessage, buildTaskMessage } from "./pi/prompt-context";
import {
  clearsPreviewWhenDone,
  DiagramPreviewQueue,
  previewsWhileStreaming,
} from "./pi/diagram-preview-queue";
import { redact } from "./pi/redact";
import { createApprovalJudge, createGuardExtension } from "./pi/safety-extension";
import { createRootSession, createSubagentSession, type PiSessionOptions } from "./pi/session-factory";
import { createPiTools, type CanvasMutation, type PiToolHost } from "./pi/tools";

export { DEFAULT_APPROVAL_MODEL, PI_MODEL, PI_PROVIDER, PI_THINKING_LEVEL } from "./pi/constants";

type SubStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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

  constructor(
    private readonly projectDir: string,
    private readonly ledger: RuntimeLedger,
    private readonly transcript: TranscriptStore,
    private readonly canvas: CanvasBridge,
    private readonly voice: VoiceBridge,
    private readonly skillsDir?: string,
  ) {
    this.#diagramPreviews = new DiagramPreviewQueue(canvas);
  }

  async initialize(): Promise<void> {
    this.#modelRuntime = await ModelRuntime.create();
    const model = getModel(PI_PROVIDER, PI_MODEL);
    if (!model) throw new Error(`Pi model not found: ${PI_PROVIDER}/${PI_MODEL}`);
    this.#approvalJudge = createApprovalJudge();
    await this.#createRootSession();
    await this.#ensureWarmSubagent();
  }

  async #createRootSession(): Promise<void> {
    const session = await createRootSession(this.#sessionOptions(BOARD_AGENT_SYSTEM_PROMPT, "root"));
    this.#main = session;
    this.#subscribeSession(session, "root", () => this.#currentJobId ?? "system");
  }

  #sessionOptions(systemPrompt: string, agentId: string): PiSessionOptions {
    if (!this.#modelRuntime) throw new Error(`Pi model unavailable: ${PI_PROVIDER}/${PI_MODEL}`);
    return {
      projectDir: this.projectDir,
      systemPrompt,
      guardExtension: this.#guardExtension(),
      modelRuntime: this.#modelRuntime,
      customTools: this.#tools(agentId),
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

  listSubagents(): Array<{ id: string; status: SubStatus; task: string; report?: string }> {
    return [...this.#subagents.values()].map(({ id, status, task, report }) => ({ id, status, task, report }));
  }

  hasActiveSubagents(jobId?: string): boolean {
    return [...this.#subagents.values()].some(
      (sub) => (sub.status === "queued" || sub.status === "running") && (!jobId || sub.parentJobId === jobId),
    );
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
    await Promise.allSettled(
      [...this.#subagents.values()]
        .filter((sub) => sub.status === "running" && sub.session?.isStreaming)
        .map((sub) => this.#interruptSubagent(sub, reason, false)),
    );
    this.voice.endWork();
  }

  async dispose(): Promise<void> {
    await this.abort("Application is closing");
    this.#main?.dispose();
    for (const sub of this.#subagents.values()) sub.session?.dispose();
    this.#warmSubagent?.session.dispose();
    this.#warmSubagent = undefined;
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
          void this.#finishRootRun(generation);
        },
        (error) => {
          if (!preflightSettled) reject(error);
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
        const sub = this.#subagents.get(id);
        if (!sub) throw new Error(`No such subagent: ${id}`);
        await this.#interruptSubagent(sub, message, true);
      },
      spawnSubagent: (task) => this.#spawnSubagent(task, this.#currentJobId ?? "system"),
      checkSubagent: (id) => {
        const sub = this.#subagents.get(id);
        if (!sub) throw new Error(`No such subagent: ${id}`);
        return { status: sub.status, report: sub.report };
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
    return createSubagentSession(this.#sessionOptions(SUBAGENT_SYSTEM_PROMPT, agentId));
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
