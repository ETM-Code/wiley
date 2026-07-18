# Pi Agent Harness Setup Guide

How to wire the [pi agent](https://github.com/earendil-works/pi) into the board-ai Electron app as the working agent behind the voice model and the Excalidraw canvas.

This maps directly onto `Plan.excalidraw`:

```
Human ──voice──▶ Voice Model (gpt-realtime-2.1) ──tool calling──▶ Pi Agent ──▶ Subagents
  │                                                                  │
  └──draws/views──▶ Excalidraw ◀──JSON (draw)──────────────────────┘
                        │
                        └──Vision x JSON (screenshot + scene)──────▶ Pi Agent
```

- The **voice model** is the pretty frontend: lovely to talk to, never does real work. It interprets intent, dispatches to pi, and narrates what comes back.
- The **pi agent** is the backend brain and hands: it reads the board (JSON + PNG vision), draws on the board, and edits code / runs commands like Claude Code or Codex would. It mostly outsources implementation to subagents.
- The channel is **duplex and interrupt-first**. Downward: voice → pi tasks, delivered by interruption at every layer by default (the voice model interrupts pi, pi interrupts the relevant subagents), so the user never waits for a task to finish to be heard. Upward: pi → voice answers, questions, and progress messages ("I'm going to draw the auth flow now"), which the voice model narrates live while pi keeps working. gpt-realtime-2.1's native async tool calling makes this work without blocking the conversation.
- **Subagents** are extra pi sessions the main agent spawns for parallel implementation work. Context passes up the chain (subagent → main pi agent → voice → user) and steering passes down it.
- A **safety layer** gives pi Claude Code-style permission checks, approved by a light critique model instead of the user, plus read-before-edit enforcement.
- To the user, the whole stack is **one persona: Wiley**. The voice speaks as Wiley, progress messages are narrated in first person ("I just finished the frontend"), and no layer ever mentions agents or subagents. The layering is pure implementation detail.
- The only custom frontend beyond Excalidraw is a mute/unmute button.

---

## 1. Why pi, and which integration mode

Pi ships three integration surfaces (all in the `@earendil-works/pi-coding-agent` package):


| Mode                                | What it is                                           | Use here?                                           |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| **SDK (in-process)**                | `createAgentSession()` in your own Node process      | **Yes, for the main agent**                         |
| RPC (`pi --mode rpc`)               | JSON-lines protocol over a subprocess's stdin/stdout | Fallback if Electron's Node is too old              |
| Print/JSON (`pi -p`, `--mode json`) | One-shot CLI runs                                    | Subagent alternative when process isolation matters |


The SDK is the right call for the main agent because custom tools execute inside your Electron main process. A `draw_on_canvas` tool can `await` an IPC round-trip to the renderer and hand the result straight back to the LLM. In RPC mode those tools would have to live as extensions inside the pi subprocess and bridge back to Electron over another channel, which is strictly more plumbing.

Two properties of pi that matter for this app:

1. **No permission system, by design.** Pi has no approval popups at all. Tools (bash, write, edit) just execute with the process's privileges. That is exactly the "auto-approve" behavior the README calls for, and there is nothing to configure. The flip side: there is no safety net either. Restrict with `tools: [...]` / `excludeTools: [...]` if needed, or run inside a container for untrusted work.
2. **No built-in subagents, by design.** Pi's docs say "No sub-agents... build your own with extensions." Ours are additional in-process `createAgentSession()` instances behind custom tools, which makes them steerable mid-run (section 9); the repo's first-party example extension (`packages/coding-agent/examples/extensions/subagent/`) shows the subprocess variant.

---

## 2. Prerequisites

- **Node >= 22.19.0** (pi's hard `engines` requirement, all packages).
- **Electron version check:** the SDK runs in Electron's *bundled* Node, not your system Node. Verify with `process.versions.node` in the main process. If Electron's Node is older than 22.19, either upgrade Electron or fall back to spawning `pi --mode rpc` with the system Node (section 12).
- **API keys:**
  - `ANTHROPIC_API_KEY` (or another provider) for the pi agent. Pi resolves credentials in this order: runtime override → `~/.pi/agent/auth.json` → env vars → `models.json` fallback. A Claude Pro/Max subscription also works via OAuth: install the CLI globally once and run `/login`.
  - `OPENAI_API_KEY` for the realtime voice model (kept in the main process only; the renderer gets short-lived ephemeral tokens).

Scaffold (bun for everything JS):

```bash
bun create electron-vite board-ai   # electron + vite + react template
cd board-ai
bun add @earendil-works/pi-coding-agent @earendil-works/pi-ai
bun add @excalidraw/excalidraw react react-dom
bun add elkjs   # auto-layout for agent-drawn diagrams (section 5)
```

Tool parameter schemas use TypeBox; import `Type` from `@earendil-works/pi-ai` (it re-exports TypeBox) rather than adding a separate `typebox` dependency that may not match pi's version.

Optionally install the CLI globally too, for debugging sessions outside the app and for subagent spawning:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi   # then /login, or rely on ANTHROPIC_API_KEY
```

---

## 3. Process architecture

```
┌─ Electron main process ────────────────────────────────┐
│  • pi AgentSession (SDK) + custom canvas tools          │
│  • ephemeral-token endpoint for the realtime API        │
│  • ipcMain handlers: canvas ops, agent control          │
└──────────────▲──────────────────────────┬──────────────┘
               │ ipcRenderer.invoke        │ webContents / ipc events
┌──────────────┴──────────────────────────▼──────────────┐
│  Renderer                                               │
│  • <Excalidraw excalidrawAPI={...}/>  (whole window)    │
│  • WebRTC connection to gpt-realtime-2.1 (mic+speaker)  │
│  • mute button (bottom-right)                           │
└─────────────────────────────────────────────────────────┘
```

Rules of thumb:

- The pi session lives in **main**. It owns the working directory (the project the agent codes in) and all coding tools.
- The canvas lives in the **renderer**. Canvas tools defined in main call into the renderer over IPC and await the response.
- The voice connection lives in the **renderer** (it needs mic and speaker). Its tool calls are forwarded to main over IPC.

---

## 4. Setting up the pi harness (main process)

This is the core of the app. One persistent `AgentSession`, created at app start, kept alive across voice interactions.

```typescript
// main/agent.ts
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { canvasTools } from "./canvas-tools";
import { voiceTools } from "./voice-tools";
import { subagentTools } from "./subagent-tools";
import { guardExtension } from "./guard-extension";

export async function createBoardAgent(projectDir: string): Promise<AgentSession> {
  const modelRuntime = await ModelRuntime.create(); // reads ~/.pi/agent/auth.json + env vars

  const model = getModel("anthropic", "claude-opus-4-8");
  if (!model) throw new Error("model not found"); // check modelRuntime.getAvailable() for the current catalog

  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    systemPromptOverride: () => BOARD_AGENT_SYSTEM_PROMPT,
    extensionFactories: [guardExtension], // safety layer, section 7
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: projectDir,                       // where bash/edit/write operate
    model,
    thinkingLevel: "medium",
    modelRuntime,
    resourceLoader: loader,

    // Full coding-agent toolset plus our canvas tools plus subagents.
    // Built-ins available: read, bash, edit, write, grep, find, ls
    tools: [
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "get_canvas", "screenshot_canvas", "draw_diagram", "draw_on_canvas", "edit_canvas",
      "tell_user", "ask_user",
      "spawn_agent", "steer_agent", "check_agent", "answer_subagent",
    ],
    customTools: [...canvasTools, ...voiceTools, ...subagentTools],

    // Persist sessions to ~/.pi/agent/sessions/ so runs are resumable
    sessionManager: SessionManager.create(projectDir),
    settingsManager: SettingsManager.create(),
  });

  return session;
}

const BOARD_AGENT_SYSTEM_PROMPT = `
You are the working mind of Wiley, a voice-driven whiteboard coding
assistant. The user speaks to Wiley's voice, which relays tasks to you;
a shared Excalidraw board is the visual medium. To the user there are no
agents, layers, or subagents, only Wiley: write every tell_user and
ask_user message in first person as Wiley ("I'm drawing the auth flow
now"), and never reference internal machinery.

Board protocol:
- Call get_canvas for a summary of what's on the board (ids, boxes, text,
  connections); screenshot_canvas when you need to SEE it (hand-drawn
  sketches, rough arrows, handwriting).
- Call draw_diagram for structured diagrams: give nodes and edges only,
  never coordinates; layout is automatic.
- Call draw_on_canvas for free-form annotation around the user's sketch,
  anchored to existing element ids via placeNear.
- Call edit_canvas to change or delete existing elements with a minimal
  patch; never redraw what you can patch.
- Prefer drawing over long text replies: the user is looking at the board.

You also have full coding tools (read/bash/edit/write/grep/find/ls) in the
project directory. Prefer spawn_agent for implementation work: delegate
subtasks to subagents, keep yourself free for coordination, review, and
the board. Use steer_agent to redirect a running subagent (including when
the user changes their mind mid-task). Subagent results arrive on their own
as <subagent_result> messages; use check_agent only for a mid-task look.
When a <subagent_question> arrives, answer it via answer_subagent from your
own knowledge and context if you can; only take it to the user (ask_user)
when it is genuinely their call. Relay important subagent findings to the
user via tell_user.

When you see [INTERRUPTED], your previous action was cut off mid-flight.
First verify whether it actually took effect (re-read the file, re-check
the state); never retry it blind and never move on assuming it worked.
Then triage the new message: interrupt the subagents it affects via
steer_agent, and resume whatever still matters.

Every task you receive includes the voice-conversation transcript as raw
JSON in <voice_conversation_context>. Each block contains only what is new
since your previous task; together with earlier blocks in your context you
have the full conversation. The task text is the voice model's summary of
what the user wants; the transcript is ground truth. If they disagree, or
the task seems garbled, trust the transcript and do what the user actually
asked for.

Talking to the user (this is a voice app; the user hears, not reads):
- Call tell_user BEFORE notable actions ("I'm going to draw the auth flow,
  then implement the endpoint") and at milestones. The voice model narrates
  these live while you keep working.
- Call ask_user when you need a decision. It blocks until the user answers
  by voice; design around it (batch questions, ask early).
- Your final text output is also relayed to the voice model. Keep it short
  and conversational; put detail on the board or in code, not in prose.
`;
```

Notes on the pieces:

- `**ModelRuntime.create()**` owns credential resolution. To bundle keys with the app instead of `~/.pi/agent/`, pass `{ authPath, modelsPath }` or call `modelRuntime.setRuntimeApiKey("anthropic", key)` (not persisted).
- `**SessionManager.create(projectDir)**` persists a JSONL session tree per working directory under `~/.pi/agent/sessions/`. Use `SessionManager.continueRecent(projectDir)` to resume the last session on app relaunch, or `SessionManager.inMemory()` while prototyping.
- `**DefaultResourceLoader**` also discovers extensions, skills (`.pi/skills/`, `.agents/skills/`), and `AGENTS.md` context files from the project, so the agent picks up per-project instructions exactly like Claude Code picks up `CLAUDE.md`.
- **Model choice** is per-session and switchable at runtime (`session.setModel(...)`). Pattern strings like `"anthropic/claude-opus-4-5:high"` can be resolved with `resolveCliModel()` if you want user-configurable models later.

### Prompting the agent

The voice model's tool calls land here:

Every task automatically carries the voice transcript, so pi sees the whole exchange by default and can catch the voice model summarizing badly. Two rules: never re-append transcript pi has already seen (earlier attachments are still in its session context), and cap any single attachment at 750,000 characters.

One piece of plumbing is load-bearing here: **all deliveries into the main session go through a single-flight lock.** Deliveries arrive concurrently (the user speaks while a subagent finishes; two subagents finish together), and interleaved `abort()` + `prompt()` calls would throw pi's "already processing" error and silently drop a message. The lock covers only the delivery window (abort + prompt acceptance, via `preflightResult`), never the run itself, so interruption still works:

```typescript
// main/agent.ts
let mainLock: Promise<unknown> = Promise.resolve();
function withMainLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mainLock.then(fn, fn);
  mainLock = run.catch(() => {});
  return run;
}

// Resolves at prompt ACCEPTANCE, not run completion; the run continues after.
function promptAccepted(session: AgentSession, text: string, opts?: object): Promise<void> {
  return new Promise((accepted) => {
    void session.prompt(text, { ...opts, preflightResult: () => accepted() });
  });
}

// The one entry point for everything entering the main session: user tasks,
// subagent results, subagent questions. Interrupt-first by default.
export function injectMain(
  session: AgentSession,
  origin: string, // e.g. "[new user message]", "[update from your own background work]"
  text: string,
  opts?: { queue?: boolean },
): Promise<void> {
  return withMainLock(async () => {
    if (session.isStreaming && opts?.queue) {
      await promptAccepted(session, text, { streamingBehavior: "steer" });
    } else if (session.isStreaming) {
      await session.abort();
      await promptAccepted(session, `${INTERRUPT_NOTE}\n${origin}\n${text}`);
    } else {
      await promptAccepted(session, text);
    }
  });
}
```

```typescript
// Every interrupted agent, at every layer, gets the same discipline: know you
// were interrupted, and verify the state of whatever was cut off before
// retrying it or moving on. An aborted bash/edit may or may not have landed.
export const INTERRUPT_NOTE =
  "[INTERRUPTED] Your in-flight action was aborted and may or may not have " +
  "taken effect. Before retrying it or moving on, verify what actually " +
  "happened (re-read the file, re-check the command or its output). " +
  "Then handle this message:";

const MAX_TRANSCRIPT_CHARS = 750_000;
let transcriptCursor = 0; // how many transcript entries pi has already seen

// Send a task to the agent. Interrupts in-progress work by default: the user
// spoke, and nothing waits for tasks to finish. The aborted turn stays in the
// session, so no context is lost; the agent verifies what its cut-off action
// did, triages, and resumes whatever still matters. queue=true opts into
// non-interrupting delivery after the current turn.
export async function runTask(session: AgentSession, task: string, opts?: { queue?: boolean }) {
  const transcript = getVoiceTranscript();
  let fresh = transcript.slice(transcriptCursor);
  transcriptCursor = transcript.length;

  // Cap by dropping oldest entries before stringifying, so the JSON stays
  // valid. Dropped entries are gone for good (resending them later, out of
  // order, would be worse); at 750k chars this should not fire in practice.
  while (fresh.length > 1 && JSON.stringify(fresh).length > MAX_TRANSCRIPT_CHARS) {
    fresh = fresh.slice(Math.ceil(fresh.length / 10));
  }
  const delta = JSON.stringify(fresh);

  const message = [
    task,
    "",
    "<voice_conversation_context>",
    delta, // only transcript pi hasn't seen yet
    "</voice_conversation_context>",
  ].join("\n");

  await injectMain(session, "[new user message]", message, opts);
}
```

`prompt()` resolves only when the full run (all turns, all tool calls) finishes. Do not block the voice conversation on it; section 10 covers how the voice side handles long runs.

The default delivery is interruption, matching how a human collaborator would expect to be heard: `abort()` ends the in-flight turn immediately and the new message starts a fresh one. Nothing is lost, because the aborted turn's messages stay in the session; the system prompt tells the agent to triage the interruption, pass it down to affected subagents, and resume what still matters. The queued path (`steer`, delivered after the current turn's tool calls) is opt-in for genuine "also, afterwards" additions.

Images go in via `PromptOptions`, using the flat `ImageContent` shape:

```typescript
await session.prompt("The user sketched this while you were working:", {
  images: [{ type: "image", data: pngBase64, mimeType: "image/png" }],
});
```

(Trap: pi's own sdk.md shows a nested `source`/`mediaType` shape for `PromptOptions.images`, but the actual `ImageContent` type in `packages/ai/src/types.ts` is this flat shape everywhere. The docs example doesn't match the types; trust the types.)

---

## 5. Canvas tools (the Vision x JSON bridge)

Five tools give the agent both representations of the board (structured JSON for precision, rendered PNG for spatial understanding) plus real editing. Three design rules, lifted from the most mature prior art in this space (tldraw's agent SDK architecture, and what the better Excalidraw MCP servers converged on):

1. **Never ask the model for coordinates on structured diagrams.** The model emits graph *structure* (nodes, typed edges, labels); a real layout engine (elkjs, `elk.layered`) computes positions; a mapping function turns the layout into `ExcalidrawElementSkeleton`s. LLMs are bad at pixel math and layout engines are a solved problem.
2. **Reads are summaries, edits are patches.** The model gets a lightweight scene summary (id, type, bbox, text, connections), not full Excalidraw JSON, and edits by sending a small patch (per-id property updates, adds, deletes). Full-JSON round-trips waste tokens and invite the model to mangle elements it wasn't asked to touch.
3. **Sanitize before applying.** Every model-emitted placement or reference goes through a repair step: resolve relative anchors ("below element X") to absolute coordinates, validate referenced ids exist, drop or fix what doesn't. The model's output is a proposal, not a scene mutation.

Note on `@excalidraw/mermaid-to-excalidraw` (what Excalidraw's own paid text-to-diagram feature uses): it only truly supports flowcharts (other diagram types rasterize to a static image), and it can't edit anything. Keep it at most as a cheap fallback; the graph-spec + elkjs path above covers everything it does and more.

Main-process side, using `defineTool` with an IPC round-trip to the renderer:

```typescript
// main/canvas-tools.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { canvasRequest } from "./canvas-bridge"; // ipc helper, below

export const canvasTools = [
  defineTool({
    name: "get_canvas",
    label: "Get Canvas",
    description:
      "Summary of the current board: every element's id, type, bounding box, text, and arrow connections. Use before drawing or editing. Pass full=true only when you need complete element JSON.",
    parameters: Type.Object({
      full: Type.Optional(Type.Boolean({ description: "Return full element JSON instead of the summary" })),
    }),
    execute: async (_id, params) => {
      const scene = await canvasRequest(params.full ? "get-scene-full" : "get-scene-summary");
      return { content: [{ type: "text", text: JSON.stringify(scene) }], details: {} };
    },
  }),

  defineTool({
    name: "screenshot_canvas",
    label: "Screenshot Canvas",
    description:
      "Render the current board to a PNG and return it as an image. Use when spatial or visual understanding matters: hand-drawn sketches, rough arrows, layout.",
    parameters: Type.Object({}),
    execute: async () => {
      const pngBase64 = await canvasRequest("export-png"); // base64 string
      return {
        content: [
          { type: "text", text: "Current board:" },
          { type: "image", data: pngBase64, mimeType: "image/png" },
        ],
        details: {},
      };
    },
  }),

  defineTool({
    name: "draw_diagram",
    label: "Draw Diagram",
    description:
      "Draw a structured diagram (flow, architecture, sequence-ish) from a graph spec. Give nodes (id, label, kind: box/diamond/ellipse) and edges (from, to, label); do NOT give coordinates, layout is automatic. Optionally anchor the whole diagram near an existing element id.",
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        id: Type.String(),
        label: Type.String(),
        kind: Type.Optional(Type.String({ description: "box | diamond | ellipse" })),
      })),
      edges: Type.Array(Type.Object({
        from: Type.String(),
        to: Type.String(),
        label: Type.Optional(Type.String()),
      })),
      anchor: Type.Optional(Type.String({ description: "Existing element id to place the diagram near" })),
    }),
    execute: async (_id, params) => {
      const created = await canvasRequest("layout-diagram", params);
      return {
        content: [{ type: "text", text: `Drew ${created.count} elements. Node id → element id: ${JSON.stringify(created.idMap)}` }],
        details: {},
      };
    },
  }),

  defineTool({
    name: "draw_on_canvas",
    label: "Draw Freeform",
    description:
      "Add free-form elements (annotations, callouts, marks around the user's sketch). Takes Excalidraw skeleton elements; arrows can bind to existing element ids via start/end. Prefer anchored placement: give placeNear (an existing element id) plus offsets, rather than absolute coordinates. Use draw_diagram for structured diagrams.",
    parameters: Type.Object({
      elements: Type.Array(Type.Any(), {
        description: "ExcalidrawElementSkeleton[] (convertToExcalidrawElements input format)",
      }),
      placeNear: Type.Optional(Type.String({ description: "Existing element id; element coordinates are treated as offsets from its bounding box" })),
      scrollTo: Type.Optional(Type.Boolean({ description: "Scroll viewport to the new elements (default true)" })),
    }),
    execute: async (_id, params) => {
      const created = await canvasRequest("add-elements", params);
      return {
        content: [{ type: "text", text: `Drew ${created.count} elements. Ids: ${created.ids.join(", ")}` }],
        details: {},
      };
    },
  }),

  defineTool({
    name: "edit_canvas",
    label: "Edit Canvas",
    description:
      "Edit existing elements with a patch: per-id property updates (x, y, width, height, text, strokeColor, backgroundColor, ...) and/or deletions. Only include the properties you are changing. Get ids from get_canvas first.",
    parameters: Type.Object({
      updates: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        props: Type.Any(),
      }))),
      deletes: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params) => {
      const result = await canvasRequest("apply-patch", params);
      return {
        content: [{ type: "text", text: `Applied: ${result.updated} updated, ${result.deleted} deleted, ${result.skipped.length} skipped (unknown ids: ${result.skipped.join(", ") || "none"})` }],
        details: {},
      };
    },
  }),
];
```

Tool results carrying `{ type: "image", data, mimeType }` blocks are natively supported by pi (the same flat `ImageContent` shape used everywhere, including `PromptOptions.images`). The screenshot lands in the model's context as real vision input. Make sure the chosen model has image input, i.e. `model.input.includes("image")` (Claude Opus 4.8 / Sonnet 5, GPT-5.6, Gemini 3.x all do; pi silently drops images on non-vision models).

Renderer side, the actual Excalidraw calls. The interesting op is `layout-diagram`: elkjs computes positions, then the skeletons are built from the layout.

```typescript
// renderer/canvas-handlers.ts
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();
// excalidrawAPI captured from <Excalidraw excalidrawAPI={(api) => ...} />

async function handleCanvasRequest(op: string, params: any) {
  switch (op) {
    case "get-scene-summary":
      return excalidrawAPI.getSceneElements().map((e) => ({
        id: e.id, type: e.type,
        bbox: { x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) },
        text: (e as any).text ?? getBoundText(e),         // container label if any
        connects: e.type === "arrow" ? arrowEndpointIds(e) : undefined,
      }));

    case "get-scene-full":
      return excalidrawAPI.getSceneElements();

    case "export-png": {
      const blob = await exportToBlob({
        elements: excalidrawAPI.getSceneElements(),
        appState: { ...excalidrawAPI.getAppState(), exportBackground: true },
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      return uint8ToBase64(new Uint8Array(await blob.arrayBuffer()));
    }

    case "layout-diagram": {
      // 1. Graph spec -> elk layout (positions, sizes, edge routing)
      const layout = await elk.layout({
        id: "root",
        layoutOptions: { "elk.algorithm": "layered", "elk.direction": "DOWN" },
        children: params.nodes.map((n: any) => ({ id: n.id, width: 180, height: 64 })),
        edges: params.edges.map((e: any, i: number) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
      });
      // 2. elk output -> skeletons (offset into empty space / near anchor)
      const { x0, y0 } = placementOrigin(params.anchor);   // finds empty space
      const skeletons = layoutToSkeletons(layout, params, x0, y0); // ~40 lines of mapping
      // 3. Skeletons -> real elements
      const newElements = convertToExcalidrawElements(skeletons);
      excalidrawAPI.updateScene({ elements: [...excalidrawAPI.getSceneElements(), ...newElements] });
      excalidrawAPI.scrollToContent(newElements, { fitToViewport: true, animate: true });
      return { count: newElements.length, idMap: mapNodeIdsToElementIds(params.nodes, newElements) };
    }

    case "add-elements": {
      const sanitized = sanitizeSkeletons(params.elements, params.placeNear); // resolve anchors, validate ids
      const newElements = convertToExcalidrawElements(sanitized);
      excalidrawAPI.updateScene({ elements: [...excalidrawAPI.getSceneElements(), ...newElements] });
      if (params.scrollTo !== false) {
        excalidrawAPI.scrollToContent(newElements, { fitToViewport: true, animate: true });
      }
      return { count: newElements.length, ids: newElements.map((e) => e.id) };
    }

    case "apply-patch": {
      const byId = new Map(excalidrawAPI.getSceneElements().map((e) => [e.id, e]));
      const skipped: string[] = [];
      let updated = 0;
      const next = excalidrawAPI.getSceneElements()
        .filter((e) => !(params.deletes ?? []).includes(e.id))
        .map((e) => {
          const patch = (params.updates ?? []).find((u: any) => u.id === e.id);
          if (!patch) return e;
          updated++;
          return { ...e, ...patch.props, version: e.version + 1, versionNonce: Math.random() * 2 ** 31 };
        });
      for (const u of params.updates ?? []) if (!byId.has(u.id)) skipped.push(u.id);
      excalidrawAPI.updateScene({ elements: next }); // one call = one coherent undo step
      return { updated, deleted: (params.deletes ?? []).filter((d: string) => byId.has(d)).length, skipped };
    }
  }
}
```

Notes:

- `convertToExcalidrawElements` accepts the skeleton format (simplified elements, `label` for contained text, arrow `start`/`end` bindings that can reference **existing** element ids). That id-binding is the lever for "extend what the human drew": bind a new arrow to the human's sketch element without touching it. Paste the skeleton type definition into the project `AGENTS.md` so it's always in the agent's context.
- The skeleton API is create-only; that's why `apply-patch` builds a new element array and pushes one `updateScene` (one coherent undo step). Bumping `version`/`versionNonce` on patched elements is how Excalidraw's own collab reconciliation tracks changes, which matters because the human may be drawing at the same moment; on conflict, prefer the human's concurrent edit.
- `sanitizeSkeletons` is the tldraw-blueprint repair step: resolve `placeNear` offsets against the anchor's bbox, clamp anything landing on top of existing bounds into free space, drop arrow bindings to ids that don't exist. Cheap code, and it converts the model's most common mistakes from broken scenes into slightly-imperfect placements.

The bridge itself is ordinary Electron IPC:

```typescript
// main/canvas-bridge.ts
import { BrowserWindow, ipcMain } from "electron";

let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

export function canvasRequest(op: string, params?: any): Promise<any> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return Promise.reject(new Error("No window; canvas unavailable"));

  const id = ++seq;
  win.webContents.send("canvas-request", { id, op, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Never let a dead renderer hang the agent's turn forever.
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`canvas ${op} timed out`));
    }, 15_000);
  });
}

ipcMain.on("canvas-response", (_e, { id, result, error }) => {
  const p = pending.get(id);
  pending.delete(id);
  if (!p) return;
  error ? p.reject(new Error(error)) : p.resolve(result);
});
```

Rejections are fine: pi treats a thrown tool error as an `isError` tool result and the model recovers.

(Expose the renderer side through a preload script with `contextBridge`; keep `nodeIntegration` off.)

---

## 6. The upward channel: tell_user and ask_user

This is the duplex half that makes the app feel alive. Pi doesn't just return a result at the end; it pushes messages up to the voice model mid-run, and the voice model narrates them while pi keeps working.

```typescript
// main/voice-tools.ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pushToVoice, askViaVoice } from "./voice-bridge";

export const tellUserTool = defineTool({
    name: "tell_user",
    label: "Tell User",
    description:
      "Send a short progress or intent message to the user, spoken aloud while you continue working. Write it in first person as Wiley ('I'm drawing the auth flow now'). Use tell_user before notable actions and at milestones. Set interrupt=true for news worth breaking into current speech for ('I just finished the frontend'). Fire and forget.",
    parameters: Type.Object({
      message: Type.String({ description: "One or two conversational first-person sentences" }),
      interrupt: Type.Optional(Type.Boolean({ description: "Break into current speech to announce this now" })),
    }),
    execute: async (_id, params) => {
      pushToVoice(`[agent progress] ${params.message}`, { interrupt: params.interrupt });
      return { content: [{ type: "text", text: "Narrated to user." }], details: {} };
    },
});

export const askUserTool = defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question through the voice model and wait for their spoken answer. Blocks until answered. Use ask_user for real decisions only; batch questions where possible.",
    parameters: Type.Object({
      question: Type.String(),
    }),
    execute: async (_id, params, signal) => {
      const answer = await askViaVoice(params.question, signal);
      return { content: [{ type: "text", text: `User answered: ${answer}` }], details: {} };
    },
});

export const voiceTools = [tellUserTool, askUserTool];
```

The bridge behind these (`main/voice-bridge.ts`) talks to the renderer's realtime data channel over IPC. This is small but load-bearing, so here it is in full:

```typescript
// main/voice-bridge.ts
// FIFO, not a single slot: pi runs tools in parallel by default, so two
// ask_user calls can be in flight at once. Answers resolve oldest-first.
const pendingAnswers: Array<(answer: string) => void> = [];

export function pushToVoice(text: string, opts?: { interrupt?: boolean }) {
  // Renderer queues it into the response outbox (section 10). With interrupt,
  // it cancels any in-progress speech so the news lands immediately.
  sendToRenderer("voice-inject", { text, interrupt: opts?.interrupt ?? false });
}

export function askViaVoice(question: string, signal?: AbortSignal): Promise<string> {
  pushToVoice(`[agent question] ${question}`, { interrupt: true });
  return new Promise((resolve) => {
    const finish = (answer: string) => {
      clearTimeout(timer);
      const i = pendingAnswers.indexOf(finish);
      if (i >= 0) pendingAnswers.splice(i, 1);
      resolve(answer);
    };
    // A walked-away user must not hang the run forever.
    const timer = setTimeout(() => finish("No answer after 2 minutes; use your best judgement."), 120_000);
    signal?.addEventListener("abort", () => finish("Run aborted before the user answered."));
    pendingAnswers.push(finish);
  });
}

// Called from the voice model's answer_agent tool (section 10)
export function deliverAnswer(answer: string) {
  pendingAnswers.shift()?.(answer); // oldest question first
}
```

Notes on the two paths:

- `pushToVoice` is fire-and-forget; gpt-realtime-2.1 tool calling is natively async, so the narration happens while the pi run is still going.
- `askViaVoice` resolves when the voice model calls `answer_agent`. The voice model's instructions bind "answering an agent question" to `answer_agent`, never `send_task_to_agent`: a mis-routed `send_task_to_agent` would interrupt the run and cancel the pending question (its abort signal resolves the promise), which is self-limiting but still wrong. The timeout is the backstop for a user who walked away.
- Any interrupt that aborts the run while a question is pending resolves that question with "Run aborted". That's intended: the `[INTERRUPTED]` discipline has the agent re-verify state when it resumes, and it re-asks if the question still matters.

Pi's final assistant text also flows up on `agent_settled` (section 8), so the voice model narrates the outcome without pi having to call tell_user for it.

## 7. The safety layer: approval model and read-before-edit

Pi has no built-in permission system, so we add a Claude Code-style one ourselves: risky tool calls still get "permission prompts", but the approver is a light critique model instead of the user. It only exists to stop the agent from destroying things or going against the user's wishes; everything routine is approved without ceremony.

Pi's extension `tool_call` event fires before every tool execution and can block it by returning `{ block: true, reason }`. The blocked reason goes back to the agent as the tool result, which is where we tell it not to push its luck. One inline extension implements both safety rules:

```typescript
// main/guard-extension.ts
import * as path from "node:path";
import * as fs from "node:fs";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { pushToVoice } from "./voice-bridge";

const models = builtinModels();
const judge = models.getModel("anthropic", "claude-haiku-4-5")!; // cheap, no thinking

const RISKY = new Set(["bash", "write", "edit"]);

export const guardExtension: InlineExtension = {
  name: "approval-guard",
  factory: (pi) => {
    const readFiles = new Set<string>();

    // Track successful reads
    pi.on("tool_result", (event) => {
      if (event.toolName === "read" && !event.isError) {
        readFiles.add(path.resolve((event.input as any).path));
      }
    });

    pi.on("tool_call", async (event, ctx) => {
      // Rule 1: must read a file before editing it (Claude Code behavior).
      if (event.toolName === "edit" || event.toolName === "write") {
        const target = path.resolve((event.input as any).path);
        if (fs.existsSync(target) && !readFiles.has(target)) {
          return {
            block: true,
            reason: `You must read ${target} before modifying it. Read it first, then retry.`,
          };
        }
      }

      // Rule 2: light approval model on risky calls.
      if (!RISKY.has(event.toolName)) return;

      const verdict = await models.complete(
        judge,
        {
          systemPrompt: APPROVAL_PROMPT,
          messages: [{
            role: "user",
            content: JSON.stringify({
              tool: event.toolName,
              input: event.input,
              cwd: ctx.cwd,
              recentUserRequests: recentTranscriptSummary(), // last few user utterances
            }),
            timestamp: Date.now(),
          }],
        },
        { signal: ctx.signal }, // aborting the run also cancels the judge call
      );
      const text = verdict.content.find((b) => b.type === "text")?.text ?? "";
      if (!text.startsWith("BLOCK")) return; // default allow, including on malformed judge output

      const why = text.slice("BLOCK".length).trim();
      pushToVoice(`[safety] I stopped myself before: ${summarizeCall(event)}. Reason: ${why}`, { interrupt: true });
      return {
        block: true,
        reason:
          `Blocked by the safety reviewer: ${why}. Do not retry this action, ` +
          `and do not work around the block. If you believe it is necessary, ` +
          `explain and get explicit permission via ask_user first.`,
      };
    });
  },
};

const APPROVAL_PROMPT = `
You are a fast safety reviewer for a coding agent's tool calls. You see one
tool call plus recent context. Approve almost everything: normal edits,
builds, tests, installs, git commits are all fine.

BLOCK only if the call could destroy data or systems (recursive deletes,
overwriting unrelated files, force-pushes, touching paths outside the
project), leaks secrets, or clearly contradicts what the user asked for.

Reply with exactly APPROVE, or BLOCK followed by one short sentence saying
what is wrong.
`;
```

Design notes:

- **Default allow.** The judge is a tripwire, not a gatekeeper. If it blocks good work the agent grinds to a halt, so the prompt is biased hard toward APPROVE, and malformed judge output fails open by choice (a broken judge should not halt the agent). Pin both behaviors with tests.
- **No thinking, cheap model.** `claude-haiku-4-5` with plain `complete()` (no reasoning options) adds well under a second per risky call. Use a different provider if you want the judge decorrelated from the main model.
- **The block message is the enforcement, and escalation works at every level.** Pi's model sees the reason as a failed tool result and is told to get permission via `ask_user`. Every agent has an `ask_user` tool that routes one level up: the main agent's reaches the user through the voice model, a subagent's reaches the main agent (section 9), which can answer from its own context or escalate onward. Each hop adds the right amount of context, and the user is always the final authority.
- **Escalation is audible.** The `pushToVoice` call means the user hears "I stopped the agent from running rm -rf" in real time, another layer of the same upward channel.
- **Preflight serializes risky calls.** Sibling tool calls in one assistant turn are preflighted sequentially, so N risky calls cost N judge round-trips before execution starts. Fine at haiku latency; batch the judging if it ever isn't.
- `event.input` is also mutable in `tool_call` handlers, so a softer variant can rewrite calls (e.g. add `--dry-run`) instead of blocking.

## 8. Watching the agent: events

Subscribe once and forward what matters to the renderer (status display) and to the voice model (narration, section 6):

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "tool_execution_start":
      sendToRenderer("agent-status", `running ${event.toolName}`);
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        // stream agent prose if you want a transcript view
      }
      break;
    case "agent_settled":
      // Truly finished. agent_end fires per low-level run, and pi may still
      // auto-retry, auto-compact, or continue with queued follow-ups after it;
      // narrating on agent_end would announce "done" prematurely or twice.
      pushToVoice(`[agent finished] ${lastAssistantText(session.messages)}`, { interrupt: true });
      break;
  }
});
```

Event stream (per run): `agent_start → turn_start → message_* → tool_execution_* → turn_end → ... → agent_end → agent_settled`. Use `agent_end` for per-run bookkeeping if you need it, but gate anything user-facing ("finished") on `agent_settled`, which only fires once nothing automatic remains.

---

## 9. Subagents

Pi deliberately has none built in ("build your own"), and since we're already in-process with the SDK, the cleanest subagent is simply another `createAgentSession()`. That gives us the thing the diagram demands and a subprocess can't do cheaply: the main agent can **message a running subagent mid-task**, so user steering flows all the way down the chain (user → voice → main pi → subagent).

One design rule matters more than anything else here: **collecting results must not block the main agent.** A blocking `wait_for_subagent` tool would hold the main agent's turn open for minutes, and steering messages only deliver *between* turns, so the steer channel (and with it "tell the test agent to skip the flaky suite") would be starved exactly when it's needed. So collection is event-driven: `spawn_agent` returns an id immediately, the main agent finishes its turn (and tells the user what it kicked off), and each subagent's completion arrives as a new message into the main session.

```typescript
// main/subagent-tools.ts
import { Type, getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession, defineTool, DefaultResourceLoader,
  SessionManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { guardExtension } from "./guard-extension";
import { tellUserTool } from "./voice-tools";
import { INTERRUPT_NOTE, injectMain } from "./agent";

interface Sub {
  session: AgentSession;
  status: "running" | "done" | "failed";
  report?: string;
  interrupting?: boolean; // set while a steer aborts its current step
}
const subagents = new Map<string, Sub>();
let nextId = 1;

async function spawnSub(mainSession: AgentSession, task: string, fast: boolean): Promise<string> {
  const id = `sub-${nextId++}`;
  const loader = new DefaultResourceLoader({
    cwd: PROJECT_DIR,
    systemPromptOverride: () =>
      "You are a subagent of a larger coding agent. Do the task completely, " +
      "then summarize what you did and anything important you learned in your final message. " +
      "Your ask_user tool reaches the coordinating agent, which answers or asks the human. " +
      "If you see [INTERRUPTED], your cut-off action may or may not have taken effect: " +
      "verify what actually happened before retrying it or moving on.",
    extensionFactories: [guardExtension], // same safety layer at every level
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    model: getModel("anthropic", fast ? "claude-haiku-4-5" : "claude-opus-4-8")!,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user", "tell_user"], // no canvas tools
    // tell_user gives subagents a live milestone channel straight into Wiley's
    // speech; ask_user routes one level up to the coordinator instead.
    customTools: [makeSubagentAskUser(mainSession, id), tellUserTool],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  const sub: Sub = { session, status: "running" };
  subagents.set(id, sub);
  startSubRun(id, sub, mainSession, task);
  return id;
}

// Inject a message INTO the main agent, interrupting it if it's mid-turn.
// Same interrupt-first rule as every other layer, pointing up instead of
// down, and serialized through the same delivery lock as user tasks, so
// two subagents finishing together (or a finish landing as the user speaks)
// can never interleave abort/prompt and drop a message.
function interruptMain(mainSession: AgentSession, text: string): Promise<void> {
  return injectMain(mainSession, "[update from your own background work]", text);
}

function startSubRun(id: string, sub: Sub, mainSession: AgentSession, message: string) {
  sub.session
    .prompt(message)
    .then(() => {
      // Aborted for a steer, not actually finished. The settle callback (not
      // the steering code) consumes the flag: settle order between abort()
      // resolving and this callback is not guaranteed, and resetting the flag
      // anywhere else reopens a race that delivers a premature result.
      if (sub.interrupting) { sub.interrupting = false; return; }
      sub.status = "done";
      sub.report = lastAssistantText(sub.session.messages);
      finishSub(id, sub, mainSession);
    })
    .catch((err) => {
      if (sub.interrupting) { sub.interrupting = false; return; }
      sub.status = "failed";
      sub.report = String(err); // rejection still produces a report; nothing leaks
      finishSub(id, sub, mainSession);
    });
}

function finishSub(id: string, sub: Sub, mainSession: AgentSession) {
  sub.session.dispose();
  void interruptMain(
    mainSession,
    `<subagent_result id="${id}" status="${sub.status}">\n${sub.report}\n</subagent_result>`,
  );
}

export const subagentTools = [
  defineTool({
    name: "spawn_agent",
    label: "Spawn Subagent",
    description:
      "Start an isolated subagent with fresh context on a task. Returns an agent id immediately; the result is delivered to you automatically as a <subagent_result> message when it finishes. Use spawn_agent for implementation subtasks.",
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained task description" }),
      fast: Type.Optional(Type.Boolean({ description: "Use the cheap model for mechanical work" })),
    }),
    execute: async (_tc, params) => {
      const id = await spawnSub(mainSessionRef, params.task, params.fast ?? false);
      return { content: [{ type: "text", text: `${id} started` }], details: {} };
    },
  }),

  defineTool({
    name: "steer_agent",
    label: "Steer Subagent",
    description:
      "Send a message to a running subagent (correction, extra context, changed requirements). Delivered after its current turn.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    execute: async (_tc, params) => {
      const sub = subagents.get(params.id);
      if (!sub) throw new Error(`no such subagent: ${params.id}`);
      if (sub.status !== "running") throw new Error(`${params.id} already ${sub.status}; its report was delivered`);
      // Interrupt-first here too: abort its current step, deliver now.
      // The flag is consumed by the aborted run's settle callback, never here.
      sub.interrupting = true;
      await sub.session.abort();
      startSubRun(params.id, sub, mainSessionRef, `${INTERRUPT_NOTE}\n[message from coordinator]\n${params.message}`);
      return { content: [{ type: "text", text: "delivered; its current step was interrupted" }], details: {} };
    },
  }),

  defineTool({
    name: "check_agent",
    label: "Check Subagent",
    description:
      "Non-blocking status check on a subagent. Results arrive automatically on completion; use check_agent only for a mid-task look.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_tc, params) => {
      const sub = subagents.get(params.id);
      if (!sub) throw new Error(`no such subagent: ${params.id}`);
      const text = sub.status === "running" ? "still running" : `${sub.status}: ${sub.report}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  }),

  defineTool({
    name: "answer_subagent",
    label: "Answer Subagent",
    description:
      "Deliver an answer to a subagent's pending question (qid from its <subagent_question> message). Answer from your own context when you can; consult the user with ask_user first when you can't.",
    parameters: Type.Object({ qid: Type.String(), answer: Type.String() }),
    execute: async (_tc, params) => {
      const resolve = pendingSubQuestions.get(params.qid);
      if (!resolve) throw new Error(`no pending question ${params.qid}`);
      pendingSubQuestions.delete(params.qid);
      resolve(params.answer);
      return { content: [{ type: "text", text: "delivered" }], details: {} };
    },
  }),
];
```

Questions climb the same ladder as results, one level at a time. A subagent's `ask_user` is a custom tool that relays to the main agent and blocks until `answer_subagent` resolves it; the main agent answers from its richer context, or asks the human through its own `ask_user` first. Continuity at every hop:

```typescript
const pendingSubQuestions = new Map<string, (answer: string) => void>();
let qSeq = 0;

function makeSubagentAskUser(mainSession: AgentSession, subId: string) {
  return defineTool({
    name: "ask_user",
    label: "Ask Up",
    description:
      "Ask a question when blocked or facing a real decision. Answered by the coordinating agent, which may consult the user. Blocks until answered.",
    parameters: Type.Object({ question: Type.String() }),
    execute: async (_tc, params, signal) => {
      const qid = `q${++qSeq}`;
      const answer = await new Promise<string>((resolve) => {
        pendingSubQuestions.set(qid, resolve);
        signal?.addEventListener("abort", () => {
          pendingSubQuestions.delete(qid);
          resolve("Aborted before an answer arrived.");
        });
        const text =
          `<subagent_question id="${subId}" qid="${qid}">\n${params.question}\n</subagent_question>\n` +
          `Answer via answer_subagent. Consult the user with your own ask_user first if you are not sure.`;
        void interruptMain(mainSession, text);
      });
      return { content: [{ type: "text", text: `Answer: ${answer}` }], details: {} };
    },
  });
}
```

(`mainSessionRef` is the module's reference to the main `AgentSession`, set once at startup.)

How this plays out:

- **Fan-out:** pi's tools run in parallel by default (`toolExecution: "parallel"`), so the model can issue several `spawn_agent` calls in one turn and they genuinely run concurrently: the four diamonds in the plan diagram. Each is just an event loop citizen; the work is all provider-API IO.
- **Context passes up by interruption:** a finished subagent's report doesn't wait for the main agent to be free; `interruptMain` breaks into whatever it's doing. The main agent reviews the result and relays anything user-relevant via `tell_user` with `interrupt: true` for real milestones, which breaks into Wiley's speech: "Oh, I just finished the frontend." Full chain, all interrupt-first: subagent → main pi → voice → user's ears.
- **Steering passes down the same way:** "tell the test agent to skip the flaky suite" goes voice → `send_task_to_agent` (interrupts main pi) → `steer_agent` (interrupts the subagent's current step). Nothing anywhere waits for a task to finish first.
- **Questions pass up the same way:** a stuck subagent's `ask_user` becomes a `<subagent_question>` turn for the main agent, which answers it or takes it to the human. The user never gets asked something the main agent could have answered itself.
- **Safety holds at every level:** the same `guardExtension` loads into every subagent, and its "get permission via ask_user" escalation is meaningful there too, because `ask_user` routes up the chain (section 7).
- For live progress, subscribe to each subagent session's events and forward `tool_execution_start`/text to your status UI.

**Subprocess alternative.** The official example extension (`examples/extensions/subagent/` in the pi repo) instead spawns `pi` CLI subprocesses (`--mode json -p` together: stdout becomes JSONL events you parse, not plain text). Reach for it if you want hard process isolation. Two traps: a packaged Electron app's PATH usually lacks npm-global bins, so don't `execFile("pi", ...)`; resolve the bundled CLI entry and run it with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (the official example's `getPiInvocation()` does the equivalent fallback). And pass full model ids (`--model anthropic/claude-haiku-4-5`), not bare aliases. Pi's experimental `@earendil-works/pi-orchestrator` package is the eventual official answer here, but it is explicitly unstable.

---

## 10. Voice model wiring (gpt-realtime-2.1)

The voice model is the pretty frontend. It holds the conversation, dispatches to pi through a small tool surface, and narrates whatever pi pushes up.

**Connection:** renderer connects over WebRTC (Chromium has the full stack; mic and speaker are just `getUserMedia` and an `<audio>` element, and interruption truncation is handled server-side). The renderer must never see your real OpenAI key: main mints an ephemeral client secret per session and hands it over IPC.

```typescript
// main: mint ephemeral token
ipcMain.handle("voice-token", async () => {
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        audio: { output: { voice: "marin" } },
      },
    }),
  });
  return (await r.json()).value; // "ek_..." client secret; mint just before connecting
});
```

**Two ways to connect from the renderer:**

- **SDK (recommended to start):** `bun add @openai/agents` and use `RealtimeAgent` + `RealtimeSession` from `@openai/agents/realtime`. It auto-selects WebRTC in the browser, manages audio, tool execution, and history: `await new RealtimeSession(agent, { model: "gpt-realtime-2.1" }).connect({ apiKey: ephemeralKey })`.
- **Raw WebRTC** if you want full control of the event stream: `RTCPeerConnection`, add the mic track, `createDataChannel("oai-events")`, then POST the SDP offer to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ek_...>` and `Content-Type: application/sdp`. All events below flow over that data channel as JSON.

The raw shapes are shown below because you need them either way (the SDK is a thin wrapper, and the upward-channel injections use raw events).

**Session config** (`session.update` on the data channel once connected). Note the nested `audio.input`/`audio.output` schema, semantic VAD, and input transcription, which is what feeds the transcript that gets attached to every pi task:

```jsonc
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "instructions": "You are Wiley, a whiteboard coding assistant: one person, warm, brief, conversational. Internally you delegate work to a coding engine via send_task_to_agent (always passing the user's verbatim words in user_words), but the user must never hear about agents, subagents, engines, or layers: everything is you. Narrate [agent progress] messages in first person as things YOU are doing ('I'm drawing the auth flow now'). Your messages interrupt in-progress work immediately by default, which is what the user expects; set queue=true only when they are adding a task for later rather than changing what is happening now. When an [agent question] arrives, ask it as your own question, and return the spoken answer ONLY via answer_agent, never via send_task_to_agent.",
    "output_modalities": ["audio"],
    "audio": {
      "input": {
        "transcription": { "model": "gpt-realtime-whisper" },
        "turn_detection": { "type": "semantic_vad", "eagerness": "auto", "create_response": true, "interrupt_response": true }
      },
      "output": { "voice": "marin" }
    },
    "tools": [
      { "type": "function", "name": "send_task_to_agent",
        "description": "Send a task or instruction to the coding engine. Interrupts its current work immediately by default; queue=true delivers after the current step instead.",
        "parameters": { "type": "object", "properties": {
          "task": { "type": "string", "description": "Clear task description" },
          "user_words": { "type": "string", "description": "The user's request verbatim, as they said it" },
          "queue": { "type": "boolean", "description": "Deliver without interrupting, for 'also do X afterwards' additions" }
        }, "required": ["task", "user_words"] } },
      { "type": "function", "name": "answer_agent",
        "description": "Deliver the user's spoken answer to a question the agent asked.",
        "parameters": { "type": "object", "properties": { "answer": { "type": "string" } }, "required": ["answer"] } },
      { "type": "function", "name": "get_agent_status",
        "description": "Check what the agent is currently doing.",
        "parameters": { "type": "object", "properties": {} } },
      { "type": "function", "name": "look_at_board",
        "description": "Get a cheap text summary of what is on the whiteboard (element count and text contents).",
        "parameters": { "type": "object", "properties": {} } },
      { "type": "function", "name": "abort_agent",
        "description": "Stop the agent's current run.",
        "parameters": { "type": "object", "properties": {} } }
    ],
    "tool_choice": "auto"
  }
}
```

**Handling tool calls:** trigger on `response.function_call_arguments.done`, forward to main over IPC, return a `function_call_output` item, then explicitly request a response (submitting the item alone does not make the model speak):

```typescript
// renderer: data channel message handler (sketch)
dc.onmessage = async (e) => {
  const ev = JSON.parse(e.data);

  if (ev.type === "response.function_call_arguments.done") {
    const result = await window.api.agentToolCall(ev.name, JSON.parse(ev.arguments));
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) },
    }));
    requestResponse(); // queued, see below
  }

  // Only one response can be active at a time; track it for the outbox
  if (ev.type === "response.created") responseActive = true;
  if (ev.type === "response.done") {
    responseActive = false;
    if (needsRetry) {
      // Our injected item exists but was never voiced; request again without
      // re-creating the item (that would duplicate it in the conversation).
      needsRetry = false;
      requestResponse();
    } else {
      flushOutbox();
    }
  }
  if (ev.type === "error" && /active response/i.test(ev.error?.message ?? "")) {
    // Our response.create lost a race with a VAD-triggered response.
    responseActive = true;
    needsRetry = true;
  }

  // Transcript capture: mirror both sides to main for pi's context
  if (ev.type === "conversation.item.input_audio_transcription.completed") {
    window.api.appendTranscript({ role: "user", text: ev.transcript });
  }
  if (ev.type === "response.done") {
    for (const item of ev.response.output ?? []) {
      if (item.type === "message") {
        const text = item.content?.map((c: any) => c.transcript ?? c.text).join(" ");
        if (text) window.api.appendTranscript({ role: "assistant", text });
      }
    }
  }
};
```

Main appends these to a transcript array; `getVoiceTranscript()` in section 4 reads it. That is how pi gets the full voice conversation by default, no tool call needed: it can see exactly what the user said even when the voice model's task summary is off.

One race to know about: input transcription completes asynchronously, so when the model dispatches a task the instant the user stops talking, the triggering utterance may not be in the transcript array yet. That is why `send_task_to_agent` requires `user_words`: main composes the pi prompt as the task plus the verbatim words, so the ground truth always arrives even when the transcript lags a beat:

The main-process dispatcher behind `window.api.agentToolCall`, covering the full voice tool surface:

```typescript
// main: the voice tool-call dispatcher
async function agentToolCall(name: string, args: any) {
  switch (name) {
    case "send_task_to_agent":
      void runTask(session, `${args.task}\n\nUser's words, verbatim: "${args.user_words}"`, {
        queue: args.queue,
      });
      return { status: "started" };

    case "answer_agent":
      deliverAnswer(args.answer); // resolves the pending ask_user promise (section 6)
      return { ok: true };

    case "get_agent_status":
      return {
        agentRunning: session.isStreaming,
        subagents: [...subagents.entries()].map(([id, s]) => ({ id, status: s.status })),
      };

    case "look_at_board": {
      const els = await canvasRequest("get-scene-summary");
      return {
        elements: els.length,
        texts: els.filter((e: any) => e.type === "text").map((e: any) => e.text),
      };
    }

    case "abort_agent":
      await session.abort();
      return { ok: true, note: "Agent run aborted." };
  }
}
```

**Long-running tasks.** gpt-realtime-2.1 tool calling is natively async: the model keeps listening and talking while a call is outstanding, no special config. Still, keep `send_task_to_agent` snappy: start the run without awaiting it and return `{ status: "started" }` immediately so the model acknowledges out loud. Everything after that arrives through the upward channel.

One constraint shapes the upward channel's plumbing: the realtime session allows **one active response at a time**. `tell_user` narrations will frequently arrive while the model is already speaking (or while VAD just triggered a reply), and a bare `response.create` then errors and the narration is silently lost. So injections go through an outbox that drains one response at a time:

```typescript
// renderer side of the voice bridge: called from main over IPC
let responseActive = false;
let needsRetry = false;
const outbox: string[] = [];

export function pushToVoiceRaw(text: string, interrupt = false) {
  if (interrupt && responseActive) {
    // Cut current speech; the server truncates playback and emits response.done
    // for the cancelled response, which drains the outbox below.
    dc.send(JSON.stringify({ type: "response.cancel" }));
  }
  outbox.push(text);
  flushOutbox();
}

function flushOutbox() {
  if (responseActive || outbox.length === 0) return;
  const text = outbox.shift()!;
  dc.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "user",
      content: [{ type: "input_text", text }] },
  }));
  // VAD only reacts to speech; injected text needs an explicit response request
  requestResponse();
}

function requestResponse() {
  dc.send(JSON.stringify({ type: "response.create" }));
  responseActive = true;
}
```

The `response.created` / `response.done` handlers in the snippet above keep `responseActive` honest even for responses the model starts on its own (user speech via VAD), and the error handler covers the remaining race: if a `response.create` loses to a VAD-triggered response, the injected item is re-requested (not re-created) once that response finishes, so no narration is stranded or duplicated.

Main routes through this for all three upward message types, prefixed so the voice model knows what it is narrating:

- `[agent progress] ...` from pi's `tell_user` calls, spoken while the run continues
- `[agent question] ...` from pi's `ask_user` calls; the reply comes back via the `answer_agent` tool and resolves the pending promise in `voice-bridge.ts`
- `[agent finished] ...` from the `agent_settled` event, summarizing the run's final assistant message

`look_at_board` should stay cheap (element count plus text contents from the `get-scene-summary` op). The realtime model takes image input, but it doesn't need vision for "what's on the board": the pi agent handles anything visual.

**Mute button** (the one piece of custom UI): flip the mic track. Semantic VAD means the user just talks; muting stops frames without tearing down the connection.

```typescript
micTrack.enabled = !micTrack.enabled;
```

---

## 11. The full loop, end to end

1. User speaks as they draw: "sketch the auth flow we discussed, then implement the login endpoint."
2. Voice model sees the sketch and calls `send_task_to_agent`; the task arrives at pi with the raw voice transcript attached. The voice model says "on it."
3. Pi (main process): `get_canvas` → summary of the user's rough sketch, `screenshot_canvas` → sees the hand-drawn arrows visually, `tell_user("I'll draw the flow properly first, then implement")` → the user hears Wiley say this a second later.
4. `draw_diagram` → the proper flow appears, laid out by elkjs (for showmanship, apply it in small batches so the diagram visibly grows on the board). `spawn_agent` fans out the endpoint implementation and tests to subagents while pi reviews the flow; a subagent's milestone interrupts upward and Wiley breaks in: "oh, the endpoint's done."
5. Pi (or a subagent) hits an ambiguity: `ask_user("Sessions in Redis or Postgres?")`. A subagent's question interrupts main pi as a `<subagent_question>`; if pi can't answer it either, its own `ask_user` sends it up, Wiley asks aloud, the user answers, `answer_agent` delivers it to pi and `answer_subagent` passes it down, and the blocked tool call resumes.
6. A subagent tries `rm -rf` on the wrong directory: the guard's approval model blocks it, the subagent is told to verify and not retry without permission, and the user hears Wiley say "I stopped myself before deleting the wrong directory."
7. User: "actually skip the flaky test suite" → `send_task_to_agent` interrupts main pi, pi calls `steer_agent`, which interrupts the running subagent. Interruption flows the whole way down; each interrupted agent verifies what its cut-off action did before continuing.
8. `agent_settled` → summary breaks into the voice session → Wiley narrates: "diagram's on the board, endpoint's implemented, tests pass."
9. User draws a correction and says "stop, the token refresh is wrong": the message interrupts pi immediately (interruption is the default, no flag), transcript attached; pi checks what its aborted action actually did, interrupts the affected subagent, and re-checks the board.

## 12. Fallback: RPC mode instead of the SDK

If Electron's bundled Node is below 22.19 or you want process isolation, spawn `pi --mode rpc --no-session` (with the system Node) and speak newline-delimited JSON over stdin/stdout: `{"type":"prompt","message":"..."}`, `{"type":"steer",...}`, `{"type":"abort"}`, with the same event stream coming back as JSON lines. Prompts accept base64 images. The catch, as noted in section 1: canvas tools must then be loaded into the subprocess as pi extensions (`--extension ./canvas-tools.ts`) and bridge back to Electron themselves (e.g. over a local HTTP port). Use the SDK unless you hit a hard blocker. Note pi's RPC framing is strict LF-delimited JSONL; don't use naive line splitting that breaks on Unicode separators inside JSON strings.

## 13. Reuse map: adapt, don't build

Almost every hard problem here has a mature, battle-tested answer. The custom code in this guide is deliberately confined to thin glue at the seams.

| Need | Reuse | Instead of |
| --- | --- | --- |
| Agent loop, tools, sessions, compaction, retries | pi SDK (`createAgentSession`) | any hand-rolled agent loop |
| Multi-provider LLM calls (the guard's judge) | `@earendil-works/pi-ai` | per-provider SDKs |
| Voice transport, audio, turn-taking, tool plumbing | `@openai/agents/realtime` (`RealtimeSession`) | hand-rolled `RTCPeerConnection` (keep raw events only for the injection outbox) |
| Diagram auto-layout | `elkjs` (`elk.layered`) + `convertToExcalidrawElements` | teaching the model raw coordinates, or `mermaid-to-excalidraw` (flowchart-only, no editing) |
| Agent-on-canvas loop design | tldraw's MIT agent starter as the blueprint: screenshot + scene summary in, sanitize-then-apply out | inventing the loop blind |
| Board rendering, export | `@excalidraw/excalidraw` (`exportToBlob`, `getSceneElements`) | any custom canvas work |
| Agent instructions ecosystem | pi skills + `AGENTS.md`; point pi's `skills` setting at `~/.claude/skills` to reuse existing Claude Code skills wholesale (pi implements the Agent Skills standard) | rewriting skills per harness |
| Subagents with process isolation | pi's `examples/extensions/subagent/` | a new process manager |
| Deterministic agent tests | pi-ai's faux provider (`fauxProvider`, `fauxToolCall`) | a hand-built LLM mock |
| App scaffold | `electron-vite` | manual Electron config |

What stays custom, because nothing mature exists for these exact seams: the canvas IPC bridge, the voice bridge and its response outbox, the guard extension, and the transcript plumbing. Each is under a hundred lines, and that's the point.

## 14. Build order

(Trivial helpers referenced but not defined in the snippets, e.g. `lastAssistantText`, `summarizeCall`, `recentTranscriptSummary`, `uint8ToBase64`, `sendToRenderer`, are a few lines each; write them as you go. Test each step against `agent-test-procedure.md`, which layers an automated agent-driven test rig over exactly these seams.)

1. Electron + Excalidraw shell; verify `getSceneElements` / `updateScene` / `exportToBlob` from devtools.
2. Pi session in main with only canvas tools + a debug text box instead of voice. Get "draw a flowchart of X" working end to end via `draw_diagram` (graph spec → elkjs → skeletons). This proves the harness, the IPC bridge, and the layout pipeline.
3. Add coding tools (they are just the built-ins list) and test a real coding task.
4. Add the guard extension: read-before-edit first (pure logic, easy to test), then the approval model.
5. Add the realtime voice layer with the dispatcher tools, transcript capture, and the mute button.
6. Add the upward channel (`tell_user`, `ask_user` + `answer_agent`, the response outbox) and delta transcript attachment to tasks.
7. Add subagents (`spawn_agent`/`steer_agent`/`check_agent` with event-driven result delivery) and interrupt-by-default delivery through the whole chain, then session resume (`SessionManager.continueRecent`).

## Reference: docs worth keeping open

- Pi SDK: `packages/coding-agent/docs/sdk.md` (the main reference for everything in section 4)
- Pi extensions/tools: `packages/coding-agent/docs/extensions.md`
- Pi RPC protocol: `packages/coding-agent/docs/rpc.md`
- Pi sessions: `packages/coding-agent/docs/sessions.md`, `session-format.md`
- Subagent example: `packages/coding-agent/examples/extensions/subagent/`
- Excalidraw API: [https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api)
- Skeleton elements: [https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton)
- OpenAI Realtime guide: [https://platform.openai.com/docs/guides/realtime](https://platform.openai.com/docs/guides/realtime) (function calling, WebRTC, conversation events)
- OpenAI Agents SDK realtime quickstart: [https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/](https://openai.github.io/openai-agents-js/guides/voice-agents/quickstart/)

