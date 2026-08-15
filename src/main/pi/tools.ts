import path from "node:path";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  DIAGRAM_CONTAINER_RENDERS,
  DIAGRAM_EDGE_ARROWS,
  DIAGRAM_EDGE_LABEL_MODES,
  DIAGRAM_EDGE_LINE_STYLES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_NODE_EMPHASES,
  DIAGRAM_NODE_ROLES,
  DIAGRAM_THEME_NAMES,
} from "../../shared/diagram-stamp";

import { IMAGE_MIME_BY_EXT, sniffImageSize } from "./image";

export type CanvasMutation =
  | "add-shape"
  | "layout-diagram"
  | "add-elements"
  | "connect-elements"
  | "clear-scene"
  | "apply-patch";

/**
 * Everything the tool definitions are allowed to reach. PiRuntime implements
 * it, which keeps the delivery lock, the subagent lifecycle, and the abort
 * ordering out of the tool bodies.
 */
export interface PiToolHost {
  readonly projectDir: string;
  mutateCanvas(agentId: string, operation: CanvasMutation, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  canvasRequest<T>(op: "get-scene-full" | "get-scene-summary" | "export-png", signal?: AbortSignal): Promise<T>;
  readConversation(afterSequence: number): unknown;
  readAgentEvents(afterSequence: number): unknown;
  narrate(message: string, interrupt?: boolean): void;
  askUser(question: string, signal?: AbortSignal): Promise<string>;
  /** A subagent asks the coordinating root, which may in turn ask the user. */
  askRoot(subagentId: string, question: string, signal?: AbortSignal): Promise<string>;
  listSubagents(): unknown;
  messageSubagent(id: string, message: string): Promise<void>;
  spawnSubagent(task: string): Promise<string>;
  checkSubagent(id: string): { status: string; report?: string };
  answerSubagent(qid: string, answer: string): void;
}

export function toolText(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} };
}

/**
 * The full quality report is eight arrays of element-id pairs: useful to
 * carry, useless to read. The agent gets one line saying whether the drawing
 * came out clean and, if not, exactly which checks it tripped.
 */
export function summarizeDiagramQuality(quality: unknown): string | undefined {
  if (!quality || typeof quality !== "object") return undefined;
  const checks = Object.entries(quality as Record<string, unknown>)
    .filter(([, findings]) => Array.isArray(findings));
  if (checks.length === 0) return undefined;
  const tripped = checks
    .filter(([, findings]) => (findings as unknown[]).length > 0)
    .map(([name, findings]) => `${(findings as unknown[]).length} ${name}`);
  return tripped.length === 0 ? `clean on ${checks.length} checks` : tripped.join(", ");
}

/** draw_diagram's result, with the report collapsed to its one-line summary. */
export function diagramToolText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return toolText(value);
  const { quality, ...rest } = value as Record<string, unknown>;
  const summary = summarizeDiagramQuality(quality);
  return toolText(summary === undefined ? rest : { ...rest, quality: summary });
}

function canvasTools(host: PiToolHost, agentId: string): ToolDefinition[] {
  return [
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
      execute: async (_id, params, signal) => toolText(
        await host.mutateCanvas(agentId, "add-shape", params, signal),
      ),
    }),
    defineTool({
      name: "get_canvas",
      label: "Get Canvas",
      description: "Get the board scene summary. Pass full only when complete element JSON is necessary.",
      parameters: Type.Object({ full: Type.Optional(Type.Boolean()) }),
      execute: async (_id, params, signal) => toolText(
        await host.canvasRequest(params.full ? "get-scene-full" : "get-scene-summary", signal),
      ),
    }),
    defineTool({
      name: "screenshot_canvas",
      label: "Screenshot Canvas",
      description: "Render the current board to PNG for spatial or visual understanding.",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        const data = await host.canvasRequest<string>("export-png", signal);
        return { content: [{ type: "text" as const, text: "Current board:" }, { type: "image" as const, data, mimeType: "image/png" }], details: {} };
      },
    }),
    defineTool({
      name: "clear_canvas",
      label: "Clear Canvas",
      description: "Remove every element from the canvas, destroying the user's own drawings. Call it only when the user's verbatim words explicitly ask to wipe the board (clear, erase everything, start over, replace it all). Requests to fill in, connect, finish, extend, or tidy existing content must never clear; work with the elements already on the board instead.",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => toolText(await host.mutateCanvas(agentId, "clear-scene", {}, signal)),
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
      execute: async (_id, params, signal) => toolText(await host.mutateCanvas(agentId, "connect-elements", params, signal)),
    }),
    defineTool({
      name: "draw_diagram",
      label: "Draw Diagram",
      description: "Draw one complete, validated graph in a single call, including its title, node shapes, colors, rounded action boxes, edges, and layout direction. Supply semantic nodes and edges, never coordinates. Colour by meaning, not by hex: pick one theme for the whole diagram (slate is neutral, ocean blue, forest green, sunset warm, grape violet, mono grayscale) and give each node a role (primary, success, warning, danger, accent, muted, neutral) plus optional emphasis (strong to foreground it, quiet to recede it). Edges take style solid/dashed/dotted, weight normal/strong/quiet, arrow none/end/both, and color as a role name. An edge label rides the arrow when the route has room for it and stands beside the route when it does not; override with labelMode bound or standalone only when you need one specifically. Keep the palette tight: roughly one distinct colour per three nodes reads as a designed diagram, more reads as noise. Only set backgroundColor or strokeColor when the user names a specific colour. Shape text draws a bare caption with no box, for annotations and legends inside the graph. Group nodes into labelled regions with containers: declare each region once with an id and label, give it a role for its tint, and put a node inside it with container. A region may name a parent region, two levels deep at most, and the layout keeps its members together and its label in the band above them. Set render frame for a real Excalidraw frame instead of a tinted box; a frame is top level only and cannot hold another region. Containers force the layered algorithm, which is reported back. Pick layout.algorithm for the shape of the graph: layered (default) for flows and processes, tree for hierarchies and org charts, radial for a hub with spokes, force or stress for meshes and networks with no direction. layout.direction (RIGHT, DOWN, LEFT, UP) applies to layered and tree only and is reported back as ignored otherwise; the result also reports which algorithm was actually used, since an algorithm that cannot handle a given graph falls back to layered. Layout, grid snapping, viewport fitting, and perimeter bindings are automatic. To add the diagram beside existing content, pass anchor (an existing element id, or omit to use the whole scene) with anchorDirection right, left, above, or below. The result validates rendered shapes and styles, so do not call get_canvas afterward unless this tool reports an error or the user explicitly asks for visual inspection. It also returns diagramId, the stable name of the diagram you just drew, plus idMap from your node ids to element ids; the canvas context lists the diagrams already on the board under the same ids, so refer to one by its diagramId instead of redrawing it.",
      parameters: Type.Object({
        title: Type.Optional(Type.String()),
        theme: Type.Optional(Type.Union(DIAGRAM_THEME_NAMES.map((name) => Type.Literal(name)))),
        nodes: Type.Array(Type.Object({
          id: Type.String(),
          label: Type.String(),
          shape: Type.Optional(Type.Union([
            Type.Literal("rectangle"),
            Type.Literal("diamond"),
            Type.Literal("ellipse"),
            Type.Literal("text"),
          ])),
          role: Type.Optional(Type.Union(DIAGRAM_NODE_ROLES.map((role) => Type.Literal(role)))),
          emphasis: Type.Optional(Type.Union(DIAGRAM_NODE_EMPHASES.map((value) => Type.Literal(value)))),
          backgroundColor: Type.Optional(Type.String()),
          strokeColor: Type.Optional(Type.String()),
          rounded: Type.Optional(Type.Boolean()),
          container: Type.Optional(Type.String()),
        }, { additionalProperties: false })),
        containers: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          label: Type.Optional(Type.String()),
          parent: Type.Optional(Type.String()),
          role: Type.Optional(Type.Union(DIAGRAM_NODE_ROLES.map((role) => Type.Literal(role)))),
          render: Type.Optional(Type.Union(
            DIAGRAM_CONTAINER_RENDERS.map((value) => Type.Literal(value)),
          )),
        }, { additionalProperties: false }))),
        edges: Type.Array(Type.Object({
          from: Type.String(),
          to: Type.String(),
          label: Type.Optional(Type.String()),
          style: Type.Optional(Type.Union(DIAGRAM_EDGE_LINE_STYLES.map((value) => Type.Literal(value)))),
          weight: Type.Optional(Type.Union(DIAGRAM_EDGE_WEIGHTS.map((value) => Type.Literal(value)))),
          color: Type.Optional(Type.String()),
          arrow: Type.Optional(Type.Union(DIAGRAM_EDGE_ARROWS.map((value) => Type.Literal(value)))),
          labelMode: Type.Optional(Type.Union(
            DIAGRAM_EDGE_LABEL_MODES.map((value) => Type.Literal(value)),
          )),
        }, { additionalProperties: false })),
        anchor: Type.Optional(Type.String()),
        anchorDirection: Type.Optional(Type.Union([
          Type.Literal("right"),
          Type.Literal("left"),
          Type.Literal("above"),
          Type.Literal("below"),
        ])),
        layout: Type.Optional(Type.Object({
          algorithm: Type.Optional(Type.Union([
            Type.Literal("layered"),
            Type.Literal("tree"),
            Type.Literal("radial"),
            Type.Literal("force"),
            Type.Literal("stress"),
          ])),
          direction: Type.Optional(Type.Union([
            Type.Literal("RIGHT"),
            Type.Literal("DOWN"),
            Type.Literal("LEFT"),
            Type.Literal("UP"),
          ])),
          nodeSpacing: Type.Optional(Type.Number()),
          layerSpacing: Type.Optional(Type.Number()),
        }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => diagramToolText(
        await host.mutateCanvas(agentId, "layout-diagram", params, signal),
      ),
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
      execute: async (_id, params, signal) => toolText(await host.mutateCanvas(agentId, "add-elements", params, signal)),
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
        const filePath = path.resolve(host.projectDir, params.path);
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
        return toolText(await host.mutateCanvas(agentId, "add-elements", {
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
      execute: async (_id, params, signal) => toolText(await host.mutateCanvas(agentId, "apply-patch", params, signal)),
    }),
  ];
}

function rootOnlyTools(host: PiToolHost): ToolDefinition[] {
  return [
    defineTool({
      name: "spawn_agent",
      label: "Spawn Subagent",
      description: "Start a Luna-medium worker with the complete voice conversation and shared canvas access. Returns immediately after dispatch.",
      parameters: Type.Object({ task: Type.String() }),
      execute: async (_id, params) => {
        const id = await host.spawnSubagent(params.task);
        return toolText(`${id} started`);
      },
    }),
    defineTool({
      name: "check_agent",
      label: "Check Subagent",
      description: "Non-blocking status check; completion is delivered automatically.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => toolText(host.checkSubagent(params.id)),
    }),
    defineTool({
      name: "answer_subagent",
      label: "Answer Subagent",
      description: "Resolve a pending subagent question by qid.",
      parameters: Type.Object({ qid: Type.String(), answer: Type.String() }),
      execute: async (_id, params) => {
        host.answerSubagent(params.qid, params.answer);
        return toolText("Delivered.");
      },
    }),
  ];
}

function rootAskTool(host: PiToolHost): ToolDefinition {
  return defineTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the user a real decision through voice and wait for the spoken answer.",
    parameters: Type.Object({ question: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => toolText(`User answered: ${await host.askUser(params.question, signal)}`),
  });
}

function subagentAskTool(host: PiToolHost, subId: string): ToolDefinition {
  return defineTool({
    name: "ask_user",
    label: "Ask Up",
    description: "Ask the coordinating root for a blocking decision. The root may consult the user.",
    parameters: Type.Object({ question: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => toolText(`Answer: ${await host.askRoot(subId, params.question, signal)}`),
  });
}

export function createPiTools(host: PiToolHost, agentId: string): ToolDefinition[] {
  return [
    ...canvasTools(host, agentId),
    defineTool({
      name: "read_conversation",
      label: "Read Conversation",
      description: "Read the lossless voice conversation after a sequence cursor.",
      parameters: Type.Object({ afterSequence: Type.Optional(Type.Number()) }),
      execute: async (_id, params) => toolText(host.readConversation(params.afterSequence ?? 0)),
    }),
    defineTool({
      name: "tell_user",
      label: "Tell User",
      description: "Speak a short truthful first-person progress update while continuing work.",
      parameters: Type.Object({ message: Type.String(), interrupt: Type.Optional(Type.Boolean()) }),
      execute: async (_id, params) => {
        host.narrate(params.message, params.interrupt);
        return toolText("Narrated to user.");
      },
    }),
    agentId === "root" ? rootAskTool(host) : subagentAskTool(host, agentId),
    defineTool({
      name: "list_agents",
      label: "List Agents",
      description: "List current peer work and status.",
      parameters: Type.Object({}),
      execute: async () => toolText(host.listSubagents()),
    }),
    defineTool({
      name: "read_agent_events",
      label: "Read Agent Events",
      description: "Read observable messages, tools, changes, milestones, and results from all agents.",
      parameters: Type.Object({ afterSequence: Type.Optional(Type.Number()) }),
      execute: async (_id, params) => toolText(host.readAgentEvents(params.afterSequence ?? 0)),
    }),
    defineTool({
      name: "send_agent_message",
      label: "Message Agent",
      description: "Interrupt a running peer with a correction or useful context.",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id, params) => {
        await host.messageSubagent(params.id, params.message);
        return toolText("Delivered immediately; current work was interrupted.");
      },
    }),
    ...(agentId === "root" ? rootOnlyTools(host) : []),
  ];
}
