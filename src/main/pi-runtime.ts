import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { BOARD_AGENT_SYSTEM_PROMPT, INTERRUPT_NOTE, SUBAGENT_SYSTEM_PROMPT } from "./agent-prompt";
import type { AgentEvent, JobSummary } from "./contracts";
import type { RuntimeLedger } from "./ledger";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";
import { stableDiagramPreview } from "./diagram-preview";
import { ApprovalJudge, CatastrophicCommandGuard, ReadBeforeEditGuard, isReadOnlyCommand } from "./safety";
import { VoiceBridge } from "./voice-bridge";

export const PI_PROVIDER = "openai" as const;
export const PI_MODEL = "gpt-5.6-luna" as const;
export const PI_THINKING_LEVEL = "medium" as const;
export const DEFAULT_APPROVAL_MODEL = "gpt-5.4-mini" as const;
const MAX_ACTIVE_SUBAGENTS = 4;
const JUDGED_TOOLS = new Set(["bash", "edit", "write"]);

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

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function sniffImageSize(data: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png" && data.length >= 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (mime === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) break;
        const marker = data[offset + 1];
        const size = data.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        }
        offset += 2 + size;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } =>
          Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"),
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "Work finished.";
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
  #diagramPreviewTimer?: NodeJS.Timeout;
  #pendingDiagramPreview?: Record<string, unknown>;
  #lastDiagramPreviewSignature = "";
  #approvalJudge?: ApprovalJudge;

  constructor(
    private readonly projectDir: string,
    private readonly ledger: RuntimeLedger,
    private readonly transcript: TranscriptStore,
    private readonly canvas: CanvasBridge,
    private readonly voice: VoiceBridge,
  ) {}

  async initialize(): Promise<void> {
    this.#modelRuntime = await ModelRuntime.create();
    const model = getModel(PI_PROVIDER, PI_MODEL);
    if (!model) throw new Error(`Pi model not found: ${PI_PROVIDER}/${PI_MODEL}`);
    this.#approvalJudge = this.#createApprovalJudge();
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const settingsManager = SettingsManager.create(this.projectDir, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: this.projectDir,
      agentDir,
      settingsManager,
      systemPromptOverride: () => BOARD_AGENT_SYSTEM_PROMPT,
      extensionFactories: [this.#guardExtension()],
    });
    await loader.reload();
    const customTools = this.#tools("root");
    const { session } = await createAgentSession({
      cwd: this.projectDir,
      model,
      thinkingLevel: PI_THINKING_LEVEL,
      modelRuntime: this.#modelRuntime,
      resourceLoader: loader,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...customTools.map((tool) => tool.name)],
      customTools,
      sessionManager: SessionManager.create(this.projectDir),
      settingsManager,
    });
    this.#main = session;
    this.#subscribeSession(session, "root", () => this.#currentJobId ?? "system");
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
    const board = this.canvas.getSnapshot();
    const boardContext = {
      revision: board.revision,
      elementCount: board.elements.length,
      viewport: board.appState,
      elements: board.elements.slice(0, 100).map((element) => ({
        id: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        text: element.text,
      })),
      truncated: board.elements.length > 100,
    };
    const message = [
      job.task,
      "",
      `User's words, verbatim: ${JSON.stringify(job.userWords)}`,
      "",
      "<voice_conversation_context>",
      JSON.stringify(delta.entries),
      "</voice_conversation_context>",
      "",
      "<current_canvas_context>",
      JSON.stringify(boardContext),
      "</current_canvas_context>",
    ].join("\n");
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

  #tools(agentId: string) {
    const canvasTools = [
      defineTool({
        name: "draw_shape",
        label: "Draw Shape",
        description: "Fast path: immediately add one rectangle, ellipse, or diamond centered in the visible viewport. The current canvas context is already in the task, so do not read the canvas first for a simple additive request.",
        parameters: Type.Object({
          shape: Type.Union([Type.Literal("rectangle"), Type.Literal("ellipse"), Type.Literal("diamond")]),
          width: Type.Optional(Type.Number()),
          height: Type.Optional(Type.Number()),
          label: Type.Optional(Type.String()),
          strokeColor: Type.Optional(Type.String()),
          backgroundColor: Type.Optional(Type.String()),
        }),
        execute: async (_id, params, signal) => this.#toolText(
          await this.#mutateCanvas(agentId, "add-shape", params, signal),
        ),
      }),
      defineTool({
        name: "get_canvas",
        label: "Get Canvas",
        description: "Get the board scene summary. Pass full only when complete element JSON is necessary.",
        parameters: Type.Object({ full: Type.Optional(Type.Boolean()) }),
        execute: async (_id, params, signal) => this.#toolText(
          await this.canvas.request(params.full ? "get-scene-full" : "get-scene-summary", undefined, signal),
        ),
      }),
      defineTool({
        name: "screenshot_canvas",
        label: "Screenshot Canvas",
        description: "Render the current board to PNG for spatial or visual understanding.",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          const data = await this.canvas.request<string>("export-png", undefined, signal);
          return { content: [{ type: "text" as const, text: "Current board:" }, { type: "image" as const, data, mimeType: "image/png" }], details: {} };
        },
      }),
      defineTool({
        name: "clear_canvas",
        label: "Clear Canvas",
        description: "Remove every element from the canvas, destroying the user's own drawings. Call it only when the user's verbatim words explicitly ask to wipe the board (clear, erase everything, start over, replace it all). Requests to fill in, connect, finish, extend, or tidy existing content must never clear; work with the elements already on the board instead.",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => this.#toolText(await this.#mutateCanvas(agentId, "clear-scene", {}, signal)),
      }),
      defineTool({
        name: "connect_shapes",
        label: "Connect Shapes",
        description: "Connect existing elements, including the user's hand-drawn ones, with properly bound arrows. Give element ids from the canvas context plus an optional short label; perimeter attachment points and routing are computed automatically and the arrows stay attached when shapes move. Set bidirectional true for a two-headed arrow. Always use this to link existing elements; never draw connector coordinates yourself.",
        parameters: Type.Object({
          connections: Type.Array(Type.Object({
            from: Type.String(),
            to: Type.String(),
            label: Type.Optional(Type.String()),
            bidirectional: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false })),
        }, { additionalProperties: false }),
        execute: async (_id, params, signal) => this.#toolText(await this.#mutateCanvas(agentId, "connect-elements", params, signal)),
      }),
      defineTool({
        name: "draw_diagram",
        label: "Draw Diagram",
        description: "Draw one complete, validated graph in a single call, including its title, node shapes, colors, rounded action boxes, edges, and layout direction. Supply semantic nodes and edges, never coordinates. Layout, grid snapping, viewport fitting, and perimeter bindings are automatic. To add the diagram beside existing content, pass anchor (an existing element id, or omit to use the whole scene) with anchorDirection right, left, above, or below. The result validates rendered shapes and styles, so do not call get_canvas afterward unless this tool reports an error or the user explicitly asks for visual inspection.",
        parameters: Type.Object({
          title: Type.Optional(Type.String()),
          nodes: Type.Array(Type.Object({
            id: Type.String(),
            label: Type.String(),
            shape: Type.Optional(Type.Union([
              Type.Literal("rectangle"),
              Type.Literal("diamond"),
              Type.Literal("ellipse"),
            ])),
            backgroundColor: Type.Optional(Type.String()),
            strokeColor: Type.Optional(Type.String()),
            rounded: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false })),
          edges: Type.Array(Type.Object({
            from: Type.String(),
            to: Type.String(),
            label: Type.Optional(Type.String()),
          }, { additionalProperties: false })),
          anchor: Type.Optional(Type.String()),
          anchorDirection: Type.Optional(Type.Union([
            Type.Literal("right"),
            Type.Literal("left"),
            Type.Literal("above"),
            Type.Literal("below"),
          ])),
          layout: Type.Optional(Type.Object({
            direction: Type.Optional(Type.Union([Type.Literal("RIGHT"), Type.Literal("DOWN")])),
            nodeSpacing: Type.Optional(Type.Number()),
            layerSpacing: Type.Optional(Type.Number()),
          }, { additionalProperties: false })),
        }, { additionalProperties: false }),
        execute: async (_id, params, signal) => this.#toolText(await this.#mutateCanvas(agentId, "layout-diagram", params, signal)),
      }),
      defineTool({
        name: "draw_on_canvas",
        label: "Draw On Canvas",
        description: "Add sanitized Excalidraw skeleton elements, optionally placed near an existing id. For annotations and callouts only; to link existing elements use connect_shapes, which computes routing and bindings. Any arrow drawn here must still use start and end element bindings; never aim arrow coordinates at box centers.",
        parameters: Type.Object({
          elements: Type.Array(Type.Any()),
          placeNear: Type.Optional(Type.String()),
          placeDirection: Type.Optional(Type.Union([
            Type.Literal("right"),
            Type.Literal("left"),
            Type.Literal("above"),
            Type.Literal("below"),
          ])),
          scrollTo: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, params, signal) => this.#toolText(await this.#mutateCanvas(agentId, "add-elements", params, signal)),
      }),
      defineTool({
        name: "place_image",
        label: "Place Image",
        description: "Put an image file from the workspace onto the canvas, such as a screenshot you rendered. Give the file path (relative to the project or absolute); size is read from the file. Use placeNear and placeDirection to position it beside existing content.",
        parameters: Type.Object({
          path: Type.String(),
          width: Type.Optional(Type.Number()),
          placeNear: Type.Optional(Type.String()),
          placeDirection: Type.Optional(Type.Union([
            Type.Literal("right"),
            Type.Literal("left"),
            Type.Literal("above"),
            Type.Literal("below"),
          ])),
        }, { additionalProperties: false }),
        execute: async (_id, params, signal) => {
          const filePath = path.resolve(this.projectDir, params.path);
          const mime = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
          if (!mime) throw new Error(`Unsupported image type: ${path.extname(filePath) || "(none)"}`);
          const data = await readFile(filePath);
          if (data.byteLength > 4_000_000) {
            throw new Error("Image exceeds 4 MB; render a smaller screenshot instead");
          }
          const natural = sniffImageSize(data, mime) ?? { width: 800, height: 600 };
          const width = Math.min(960, Math.max(120, params.width ?? Math.min(640, natural.width)));
          const height = Math.max(80, Math.round(width * (natural.height / Math.max(1, natural.width))));
          const fileId = crypto.randomUUID().replaceAll("-", "");
          return this.#toolText(await this.#mutateCanvas(agentId, "add-elements", {
            elements: [{ type: "image", fileId, width, height }],
            files: {
              [fileId]: {
                id: fileId,
                mimeType: mime,
                dataURL: `data:${mime};base64,${data.toString("base64")}`,
                created: Date.now(),
              },
            },
            placeNear: params.placeNear,
            placeDirection: params.placeDirection,
          }, signal));
        },
      }),
      defineTool({
        name: "edit_canvas",
        label: "Edit Canvas",
        description: "Patch or delete existing elements by id, including the user's hand-drawn ones: move, resize, recolor, restyle, or change text. Setting text or fontSize on a labelled shape automatically edits its attached label, moving a shape carries its label and bound arrows along, and deleting a shape removes its label. Read the canvas first and change only necessary properties.",
        parameters: Type.Object({ updates: Type.Optional(Type.Array(Type.Any())), deletes: Type.Optional(Type.Array(Type.String())) }),
        execute: async (_id, params, signal) => this.#toolText(await this.#mutateCanvas(agentId, "apply-patch", params, signal)),
      }),
    ];

    return [
      ...canvasTools,
      defineTool({
        name: "read_conversation",
        label: "Read Conversation",
        description: "Read the lossless voice conversation after a sequence cursor.",
        parameters: Type.Object({ afterSequence: Type.Optional(Type.Number()) }),
        execute: async (_id, params) => this.#toolText(this.ledger.getTranscript(params.afterSequence ?? 0)),
      }),
      defineTool({
        name: "tell_user",
        label: "Tell User",
        description: "Speak a short truthful first-person progress update while continuing work.",
        parameters: Type.Object({ message: Type.String(), interrupt: Type.Optional(Type.Boolean()) }),
        execute: async (_id, params) => {
          this.voice.push(`[agent progress] ${params.message}`, { interrupt: params.interrupt });
          return this.#toolText("Narrated to user.");
        },
      }),
      agentId === "root" ? this.#rootAskTool() : this.#subagentAskTool(agentId),
      defineTool({
        name: "list_agents",
        label: "List Agents",
        description: "List current peer work and status.",
        parameters: Type.Object({}),
        execute: async () => this.#toolText(this.listSubagents()),
      }),
      defineTool({
        name: "read_agent_events",
        label: "Read Agent Events",
        description: "Read observable messages, tools, changes, milestones, and results from all agents.",
        parameters: Type.Object({ afterSequence: Type.Optional(Type.Number()) }),
        execute: async (_id, params) => this.#toolText(this.ledger.getAgentEvents(params.afterSequence ?? 0)),
      }),
      defineTool({
        name: "send_agent_message",
        label: "Message Agent",
        description: "Interrupt a running peer with a correction or useful context.",
        parameters: Type.Object({ id: Type.String(), message: Type.String() }),
        execute: async (_id, params) => {
          const sub = this.#subagents.get(params.id);
          if (!sub) throw new Error(`No such subagent: ${params.id}`);
          await this.#interruptSubagent(sub, params.message, true);
          return this.#toolText("Delivered immediately; current work was interrupted.");
        },
      }),
      ...(agentId === "root" ? this.#rootOnlyTools() : []),
    ];
  }

  #rootOnlyTools() {
    return [
      defineTool({
        name: "spawn_agent",
        label: "Spawn Subagent",
        description: "Start a Luna-medium worker with the complete voice conversation and shared canvas access. Returns immediately after dispatch.",
        parameters: Type.Object({ task: Type.String() }),
        execute: async (_id, params) => {
          const id = await this.#spawnSubagent(params.task, this.#currentJobId ?? "system");
          return this.#toolText(`${id} started`);
        },
      }),
      defineTool({
        name: "check_agent",
        label: "Check Subagent",
        description: "Non-blocking status check; completion is delivered automatically.",
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => {
          const sub = this.#subagents.get(params.id);
          if (!sub) throw new Error(`No such subagent: ${params.id}`);
          return this.#toolText({ status: sub.status, report: sub.report });
        },
      }),
      defineTool({
        name: "answer_subagent",
        label: "Answer Subagent",
        description: "Resolve a pending subagent question by qid.",
        parameters: Type.Object({ qid: Type.String(), answer: Type.String() }),
        execute: async (_id, params) => {
          const resolve = this.#pendingSubQuestions.get(params.qid);
          if (!resolve) throw new Error(`No pending question: ${params.qid}`);
          this.#pendingSubQuestions.delete(params.qid);
          resolve(params.answer);
          return this.#toolText("Delivered.");
        },
      }),
    ];
  }

  #rootAskTool() {
    return defineTool({
      name: "ask_user",
      label: "Ask User",
      description: "Ask the user a real decision through voice and wait for the spoken answer.",
      parameters: Type.Object({ question: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params, signal) => this.#toolText(`User answered: ${await this.voice.ask(params.question, signal)}`),
    });
  }

  #subagentAskTool(subId: string) {
    return defineTool({
      name: "ask_user",
      label: "Ask Up",
      description: "Ask the coordinating root for a blocking decision. The root may consult the user.",
      parameters: Type.Object({ question: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params, signal) => {
        const qid = crypto.randomUUID();
        const answer = await new Promise<string>((resolve) => {
          this.#pendingSubQuestions.set(qid, resolve);
          signal?.addEventListener("abort", () => {
            this.#pendingSubQuestions.delete(qid);
            resolve("Aborted before an answer arrived.");
          }, { once: true });
          void this.#injectMain(
            this.#requireMain(),
            "[question from your own background work]",
            `<subagent_question id="${subId}" qid="${qid}">\n${params.question}\n</subagent_question>\nAnswer via answer_subagent.`,
            true,
          );
        });
        return this.#toolText(`Answer: ${answer}`);
      },
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
    const message = [
      sub.task,
      "",
      "<voice_conversation_context>",
      JSON.stringify(this.transcript.contextForNewAgent()),
      "</voice_conversation_context>",
      "",
      "<peer_agent_events>",
      JSON.stringify(this.ledger.getAgentEvents()),
      "</peer_agent_events>",
    ].join("\n");
    this.#startSubRun(sub, message);
  }

  async #createSubagentSession(agentId: string): Promise<AgentSession> {
    const model = getModel(PI_PROVIDER, PI_MODEL);
    if (!model || !this.#modelRuntime) throw new Error(`Pi model unavailable: ${PI_PROVIDER}/${PI_MODEL}`);
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const settingsManager = SettingsManager.create(this.projectDir, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: this.projectDir,
      agentDir,
      settingsManager,
      systemPromptOverride: () => SUBAGENT_SYSTEM_PROMPT,
      extensionFactories: [this.#guardExtension()],
    });
    await loader.reload();
    const customTools = this.#tools(agentId);
    const { session } = await createAgentSession({
      cwd: this.projectDir,
      model,
      thinkingLevel: PI_THINKING_LEVEL,
      modelRuntime: this.#modelRuntime,
      resourceLoader: loader,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...customTools.map((tool) => tool.name)],
      customTools,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });
    return session;
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
          if (toolCall?.name === "draw_diagram") {
            this.#queueDiagramPreview(toolCall.arguments, update.type === "toolcall_end");
          }
        } else if (update?.type === "error") {
          this.#clearDiagramPreview();
        }
      } else if (value.type === "tool_execution_start") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_started", payload: this.#redact({ toolName: value.toolName, input: value.args ?? value.input }) });
      } else if (value.type === "tool_execution_end") {
        if (agentId === "root" && value.toolName === "draw_diagram") {
          if (value.isError) this.#clearDiagramPreview();
          else this.#resetDiagramPreviewQueue();
        }
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_completed", payload: this.#redact({ toolName: value.toolName, isError: value.isError, result: value.result }) });
      } else if (value.type === "tool_execution_update") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "tool_progress", payload: this.#redact(value) });
      } else if (value.type === "message_end") {
        void this.#emit({ jobId: jobId(), agentId, parentAgentId, type: "assistant_message", payload: this.#redact(value.message) });
      }
    });
  }

  #queueDiagramPreview(value: unknown, immediate: boolean): void {
    const preview = stableDiagramPreview(value);
    if (!preview) return;
    const signature = JSON.stringify(preview);
    if (signature === this.#lastDiagramPreviewSignature) return;
    this.#lastDiagramPreviewSignature = signature;
    this.#pendingDiagramPreview = preview;
    if (immediate) {
      if (this.#diagramPreviewTimer) clearTimeout(this.#diagramPreviewTimer);
      this.#diagramPreviewTimer = undefined;
      this.#flushDiagramPreview();
      return;
    }
    if (this.#diagramPreviewTimer) return;
    this.#diagramPreviewTimer = setTimeout(() => {
      this.#diagramPreviewTimer = undefined;
      this.#flushDiagramPreview();
    }, 90);
  }

  #flushDiagramPreview(): void {
    const preview = this.#pendingDiagramPreview;
    this.#pendingDiagramPreview = undefined;
    if (preview) this.canvas.previewDiagram(preview);
  }

  #resetDiagramPreviewQueue(): void {
    if (this.#diagramPreviewTimer) clearTimeout(this.#diagramPreviewTimer);
    this.#diagramPreviewTimer = undefined;
    this.#pendingDiagramPreview = undefined;
    this.#lastDiagramPreviewSignature = "";
  }

  #clearDiagramPreview(): void {
    this.#resetDiagramPreviewQueue();
    this.canvas.clearDiagramPreview();
  }

  async #emit(event: Omit<AgentEvent, "id" | "sequence" | "at">): Promise<void> {
    const persisted = await this.ledger.appendAgentEvent(event);
    for (const listener of this.#eventListeners) listener(persisted);
  }

  #toolText(value: unknown) {
    return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
  }

  async #mutateCanvas(
    agentId: string,
    operation: "add-shape" | "layout-diagram" | "add-elements" | "connect-elements" | "clear-scene" | "apply-patch",
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

  #redact(value: unknown): unknown {
    const text = JSON.stringify(value, (key, item) =>
      /(?:api[_-]?key|authorization|token|secret|password|cookie)/i.test(key) ? "[REDACTED]" : item,
    ) ?? String(value);
    if (text.length > 100_000) return `${text.slice(0, 100_000)}…[truncated]`;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  #requireMain(): AgentSession {
    if (!this.#main) throw new Error("Pi runtime is not initialized");
    return this.#main;
  }

  #createApprovalJudge(): ApprovalJudge | undefined {
    if (process.env.WILEY_APPROVAL_DISABLED === "1") return undefined;
    const modelId = process.env.WILEY_APPROVAL_MODEL?.trim() || DEFAULT_APPROVAL_MODEL;
    const judgeModel = getModel(PI_PROVIDER, modelId as typeof DEFAULT_APPROVAL_MODEL);
    if (!judgeModel) return undefined;
    return new ApprovalJudge(async ({ systemPrompt, userMessage, signal }) => {
      const message = await complete(judgeModel, {
        systemPrompt,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      }, { signal });
      return message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    });
  }

  #guardExtension(): InlineExtension {
    const commandGuard = new CatastrophicCommandGuard(this.projectDir);
    const editGuard = new ReadBeforeEditGuard();
    return {
      name: "wiley-safety-guard",
      factory: (pi) => {
        pi.on("tool_result", (event) => {
          if (event.toolName === "read" && !event.isError) {
            const input = event.input as { path?: string };
            if (input.path) editGuard.markRead(path.resolve(this.projectDir, input.path));
          }
        });
        pi.on("tool_call", async (event, context) => {
          if (event.toolName === "edit" || event.toolName === "write") {
            const input = event.input as { path?: string };
            if (input.path) {
              const decision = editGuard.inspect(path.resolve(this.projectDir, input.path));
              if (!decision.allow) return { block: true, reason: decision.reason ?? "Read before editing" };
            }
          }
          if (event.toolName === "bash") {
            const input = event.input as { command?: string };
            const decision = commandGuard.inspect(input.command ?? "", context.cwd);
            if (!decision.allow) {
              this.voice.push(`[safety] I stopped a dangerous command. ${decision.reason}`, { interrupt: true });
              return { block: true, reason: `${decision.reason} Do not retry or work around this block.` };
            }
          }
          // Everything above is the hard floor. The approval judge is the
          // soft layer: a cheap model approves routine work and blocks only
          // destruction, secret leaks, or contradicting the user.
          if (!this.#approvalJudge || !JUDGED_TOOLS.has(event.toolName)) return undefined;
          if (event.toolName === "bash") {
            const input = event.input as { command?: string };
            if (isReadOnlyCommand(input.command ?? "")) return undefined;
          }
          const recentUserRequests = this.ledger.getTranscript()
            .filter((entry) => entry.role === "user")
            .slice(-6)
            .map((entry) => entry.text);
          const verdict = await this.#approvalJudge.review({
            tool: event.toolName,
            input: this.#redact(event.input),
            cwd: context.cwd,
            recentUserRequests,
          }, context.signal);
          if (verdict.allow) return undefined;
          this.voice.push(`[safety] I stopped myself before a risky ${event.toolName} action. ${verdict.reason}`, { interrupt: true });
          return {
            block: true,
            reason: `Blocked by the safety reviewer: ${verdict.reason} Do not retry this action or work `
              + "around the block. If it is genuinely necessary, explain and get explicit permission via ask_user first.",
          };
        });
      },
    };
  }
}
