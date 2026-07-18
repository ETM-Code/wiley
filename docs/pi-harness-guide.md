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
- The channel is **duplex**. Downward: voice → pi tasks and steering. Upward: pi → voice answers, questions, and progress messages ("I'm going to draw the auth flow now"), which the voice model narrates live while pi keeps working. gpt-realtime-2.1's native async tool calling makes this work without blocking the conversation.
- **Subagents** are extra pi sessions the main agent spawns for parallel implementation work. Context passes up the chain (subagent → main pi agent → voice → user) and steering passes down it.
- A **safety layer** gives pi Claude Code-style permission checks, approved by a light critique model instead of the user, plus read-before-edit enforcement.
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
      "get_canvas", "draw_on_canvas", "screenshot_canvas",
      "tell_user", "ask_user",
      "spawn_agent", "steer_agent", "check_agent",
    ],
    customTools: [...canvasTools, ...voiceTools, ...subagentTools],

    // Persist sessions to ~/.pi/agent/sessions/ so runs are resumable
    sessionManager: SessionManager.create(projectDir),
    settingsManager: SettingsManager.create(),
  });

  return session;
}

const BOARD_AGENT_SYSTEM_PROMPT = `
You are the working agent behind a voice-driven whiteboard coding app.
The user speaks to a voice model, which relays tasks to you. A shared
Excalidraw board is the visual medium between you and the user.

Board protocol:
- Call get_canvas for the precise scene JSON (ids, positions, text, arrows).
- Call screenshot_canvas when you need spatial/visual understanding of a
  sketch: rough drawings, arrows between clusters, handwriting.
- Call draw_on_canvas to present plans, diagrams, and results. Prefer
  drawing over long text replies: the user is looking at the board.
- Never overlap existing elements; place new content in empty space.

You also have full coding tools (read/bash/edit/write/grep/find/ls) in the
project directory. Prefer spawn_agent for implementation work: delegate
subtasks to subagents, keep yourself free for coordination, review, and
the board. Use steer_agent to redirect a running subagent (including when
the user changes their mind mid-task). Subagent results arrive on their own
as <subagent_result> messages; use check_agent only for a mid-task look.
Relay important subagent findings to the user via tell_user.

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

Every task automatically carries the voice transcript, so pi sees the whole exchange by default and can catch the voice model summarizing badly. Two rules: never re-append transcript pi has already seen (earlier attachments are still in its session context), and cap any single attachment at 750,000 characters:

```typescript
const MAX_TRANSCRIPT_CHARS = 750_000;
let transcriptCursor = 0; // how many transcript entries pi has already seen

// Send a task to the agent. Resolves when the agent goes idle.
export async function runTask(session: AgentSession, task: string, opts?: { urgent?: boolean }) {
  const transcript = getVoiceTranscript();
  const fresh = transcript.slice(transcriptCursor);
  transcriptCursor = transcript.length;

  let delta = JSON.stringify(fresh);
  if (delta.length > MAX_TRANSCRIPT_CHARS) delta = delta.slice(-MAX_TRANSCRIPT_CHARS);

  const message = [
    task,
    "",
    "<voice_conversation_context>",
    delta, // only transcript pi hasn't seen yet
    "</voice_conversation_context>",
  ].join("\n");

  if (session.isStreaming && opts?.urgent) {
    // Hard interrupt: kill the current run, then send.
    await session.abort();
    await session.prompt(message);
  } else if (session.isStreaming) {
    // Soft interrupt: delivered after the current turn's tool calls finish.
    await session.prompt(message, { streamingBehavior: "steer" });
  } else {
    await session.prompt(message);
  }
}
```

`prompt()` resolves only when the full run (all turns, all tool calls) finishes. Do not block the voice conversation on it; section 10 covers how the voice side handles long runs.

While the agent is streaming, `steer` delivers a message after the current turn's tool calls finish, and `followUp` waits until the agent is completely done. This is how "actually, make it blue" works mid-run without killing the run.

Images go in via `PromptOptions`, using the flat `ImageContent` shape:

```typescript
await session.prompt("The user sketched this while you were working:", {
  images: [{ type: "image", data: pngBase64, mimeType: "image/png" }],
});
```

(Trap: pi's own sdk.md shows a nested `source`/`mediaType` shape for `PromptOptions.images`, but the actual `ImageContent` type in `packages/ai/src/types.ts` is this flat shape everywhere. The docs example doesn't match the types; trust the types.)

---

## 5. Canvas tools (the Vision x JSON bridge)

Three tools give the agent both representations of the board: structured JSON for precision, rendered PNG for spatial understanding.

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
      "Get the current Excalidraw scene as JSON: all elements with ids, types, positions, sizes, text, and bindings. Use for precise reads and before drawing, to find empty space.",
    parameters: Type.Object({}),
    execute: async () => {
      const elements = await canvasRequest("get-scene");
      return {
        content: [{ type: "text", text: JSON.stringify(elements) }],
        details: {},
      };
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
    name: "draw_on_canvas",
    label: "Draw on Canvas",
    description:
      "Add elements to the board. Takes an array of Excalidraw skeleton elements (rectangle, ellipse, diamond, arrow, text, line, frame). Arrows can bind to element ids via start/end. Coordinates are scene coordinates; call get_canvas first to find empty space.",
    parameters: Type.Object({
      elements: Type.Array(Type.Any(), {
        description: "ExcalidrawElementSkeleton[] as documented at docs.excalidraw.com (convertToExcalidrawElements input format)",
      }),
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
];
```

Tool results carrying `{ type: "image", data, mimeType }` blocks are natively supported by pi (the same flat `ImageContent` shape used everywhere, including `PromptOptions.images`). The screenshot lands in the model's context as real vision input. Make sure the chosen model has image input, i.e. `model.input.includes("image")` (Claude Opus 4.8 / Sonnet 5, GPT-5.6, Gemini 3.x all do; pi silently drops images on non-vision models).

Renderer side, the actual Excalidraw calls:

```typescript
// renderer/canvas-handlers.ts
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";

// excalidrawAPI captured from <Excalidraw excalidrawAPI={(api) => ...} />

async function handleCanvasRequest(op: string, params: any) {
  switch (op) {
    case "get-scene":
      return excalidrawAPI.getSceneElements();

    case "export-png": {
      const blob = await exportToBlob({
        elements: excalidrawAPI.getSceneElements(),
        appState: { ...excalidrawAPI.getAppState(), exportBackground: true },
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      const buf = new Uint8Array(await blob.arrayBuffer());
      return uint8ToBase64(buf);
    }

    case "add-elements": {
      const newElements = convertToExcalidrawElements(params.elements);
      excalidrawAPI.updateScene({
        elements: [...excalidrawAPI.getSceneElements(), ...newElements],
      });
      if (params.scrollTo !== false) {
        excalidrawAPI.scrollToContent(newElements, { fitToViewport: true, animate: true });
      }
      return { count: newElements.length, ids: newElements.map((e) => e.id) };
    }
  }
}
```

`convertToExcalidrawElements` accepts the skeleton format (simplified elements, with `label` for contained text and arrow `start`/`end` bindings), which is far easier for an LLM to emit than full `ExcalidrawElement` objects. Point the system prompt at that format, and consider pasting the skeleton type definition into a project `AGENTS.md` so it is always in context.

Worth adding early: a `mermaid` parameter on `draw_on_canvas`. For standard diagrams (flowcharts, sequence, class), LLMs emit far better Mermaid than raw coordinates, and `@excalidraw/mermaid-to-excalidraw` (the library behind Excalidraw's own text-to-diagram feature) converts it to elements. Reserve raw skeletons for spatial or free-form drawing where the agent is responding to the user's layout.

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

export const voiceTools = [
  defineTool({
    name: "tell_user",
    label: "Tell User",
    description:
      "Send a short progress or intent message to the user, spoken aloud by the voice model while you continue working. Use tell_user before notable actions and at milestones. Fire and forget.",
    parameters: Type.Object({
      message: Type.String({ description: "One or two conversational sentences" }),
    }),
    execute: async (_id, params) => {
      pushToVoice(`[agent progress] ${params.message}`);
      return { content: [{ type: "text", text: "Narrated to user." }], details: {} };
    },
  }),

  defineTool({
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
  }),
];
```

The bridge behind these (`main/voice-bridge.ts`) talks to the renderer's realtime data channel over IPC. This is small but load-bearing, so here it is in full:

```typescript
// main/voice-bridge.ts
let pendingAnswer: { finish: (answer: string) => void } | null = null;

export function pushToVoice(text: string) {
  // Renderer queues it into the response outbox (section 10) and the voice
  // model narrates it as soon as no other response is active.
  sendToRenderer("voice-inject", text);
}

export function askViaVoice(question: string, signal?: AbortSignal): Promise<string> {
  pushToVoice(`[agent question] ${question}`);
  return new Promise((resolve) => {
    const finish = (answer: string) => {
      clearTimeout(timer);
      pendingAnswer = null;
      resolve(answer);
    };
    // A walked-away user must not hang the run forever.
    const timer = setTimeout(() => finish("No answer after 2 minutes; use your best judgement."), 120_000);
    signal?.addEventListener("abort", () => finish("Run aborted before the user answered."));
    pendingAnswer = { finish };
  });
}

// Called from the voice model's answer_agent tool (section 10)
export function deliverAnswer(answer: string) {
  pendingAnswer?.finish(answer);
}
```

Notes on the two paths:

- `pushToVoice` is fire-and-forget; gpt-realtime-2.1 tool calling is natively async, so the narration happens while the pi run is still going.
- `askViaVoice` resolves when the voice model calls `answer_agent`. One subtlety: while `ask_user` is blocking, the whole pi turn is blocked, so a `send_task_to_agent` steer sent during that window queues behind it. That is why the voice model's instructions bind "answering an agent question" to `answer_agent`, never `send_task_to_agent`; the timeout is the backstop if it misbehaves anyway.

Pi's final assistant text also flows up on `agent_end` (section 8), so the voice model narrates the outcome without pi having to call tell_user for it.

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
        const exists = fs.existsSync(target);
        if (exists && !readFiles.has(target)) {
          return {
            block: true,
            reason: `You must read ${target} before modifying it. Read it first, then retry.`,
          };
        }
      }

      // Rule 2: light approval model on risky calls.
      if (!RISKY.has(event.toolName)) return;

      const verdict = await models.complete(judge, {
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
      });
      const text = verdict.content.find((b) => b.type === "text")?.text ?? "";
      if (!text.startsWith("BLOCK")) return; // default allow

      const why = text.slice("BLOCK".length).trim();
      pushToVoice(`[safety] I stopped the agent from: ${summarizeCall(event)}. Reason: ${why}`);
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

- **Default allow.** The judge is a tripwire, not a gatekeeper. If it blocks good work the agent grinds to a halt, so the prompt is biased hard toward APPROVE.
- **No thinking, cheap model.** `claude-haiku-4-5` with plain `complete()` (no reasoning options) adds well under a second per risky call. Use a different provider if you want the judge decorrelated from the main model.
- **The block message is the enforcement.** Pi's model sees the reason as a failed tool result and is explicitly told not to retry or work around it without `ask_user` approval. That escalation path goes straight up to the voice model and the user, so the user is the final authority.
- **Escalation is audible.** The `pushToVoice` call means the user hears "I stopped the agent from running rm -rf" in real time, another layer of the same upward channel.
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
    case "agent_end":
      // Run finished: push the outcome up so the voice model narrates it.
      pushToVoice(`[agent finished] ${finalAssistantText(event.messages)}`);
      break;
  }
});
```

Event stream (per run): `agent_start → turn_start → message_* → tool_execution_* → turn_end → ... → agent_end`. The `agent_end` event carries all new messages from the run, which is what you compress into a spoken summary.

---

## 9. Subagents

Pi deliberately has none built in ("build your own"), and since we're already in-process with the SDK, the cleanest subagent is simply another `createAgentSession()`. That gives us the thing the diagram demands and a subprocess can't do cheaply: the main agent can **message a running subagent mid-task**, so user steering flows all the way down the chain (user → voice → main pi → subagent).

```typescript
// main/subagent-tools.ts
import { Type, getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession, defineTool, DefaultResourceLoader,
  SessionManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { guardExtension } from "./guard-extension";

interface Sub { session: AgentSession; done: Promise<string>; }
const subagents = new Map<string, Sub>();
let nextId = 1;

async function spawnSub(task: string, fast: boolean): Promise<string> {
  const id = `sub-${nextId++}`;
  const loader = new DefaultResourceLoader({
    cwd: PROJECT_DIR,
    systemPromptOverride: () =>
      "You are a subagent of a larger coding agent. Do the task completely, " +
      "then summarize what you did and anything important you learned in your final message.",
    extensionFactories: [guardExtension], // safety layer applies down here too
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    model: getModel("anthropic", fast ? "claude-haiku-4-5" : "claude-opus-4-8")!,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], // no canvas/voice tools
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  const done = session
    .prompt(task)
    .then(() => lastAssistantText(session.messages))
    .finally(() => session.dispose());
  subagents.set(id, { session, done });
  return id;
}

export const subagentTools = [
  defineTool({
    name: "spawn_agent",
    label: "Spawn Subagent",
    description:
      "Start an isolated subagent with fresh context on a task; returns an agent id immediately while it works in the background. Use spawn_agent for implementation subtasks; collect results with wait_agent.",
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained task description" }),
      fast: Type.Optional(Type.Boolean({ description: "Use the cheap model for mechanical work" })),
    }),
    execute: async (_tc, params) => {
      const id = await spawnSub(params.task, params.fast ?? false);
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
      await sub.session.prompt(params.message, { streamingBehavior: "steer" });
      return { content: [{ type: "text", text: "delivered" }], details: {} };
    },
  }),

  defineTool({
    name: "wait_agent",
    label: "Wait for Subagent",
    description: "Block until a subagent finishes and return its final report.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_tc, params) => {
      const sub = subagents.get(params.id);
      if (!sub) throw new Error(`no such subagent: ${params.id}`);
      const report = await sub.done;
      subagents.delete(params.id);
      return { content: [{ type: "text", text: report }], details: {} };
    },
  }),
];
```

How this plays out:

- **Fan-out:** pi's tools run in parallel by default (`toolExecution: "parallel"`), so the model can issue several `spawn_agent` calls in one turn and they genuinely run concurrently: the four diamonds in the plan diagram. Each is just an event loop citizen; the work is all provider-API IO.
- **Context passes up:** each subagent's final report returns through `wait_agent` into the main agent's context, and the main agent relays anything user-relevant via `tell_user`. Nudge both ends in their system prompts ("summarize what you learned" down below, "relay important subagent findings via tell_user" up top). Full chain: subagent → main pi → voice → user's ears.
- **Steering passes down:** "tell the test agent to skip the flaky suite" goes voice → `send_task_to_agent` (steer) → main pi → `steer_agent`. For live progress, subscribe to each subagent session's events and forward `tool_execution_start`/text to your status UI.
- **Safety holds:** the same `guardExtension` loads into every subagent, so the approval model and read-before-edit rules apply at every level.

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
    "instructions": "You are the voice of a whiteboard coding app. You are warm, brief, and conversational. You never write code or draw yourself; you delegate to the coding agent via send_task_to_agent (always passing the user's verbatim words in user_words) and narrate its progress messages as they arrive. Set urgent=true only when the user wants the agent to stop or change course immediately. When the agent asks the user a question, relay it aloud, and return the spoken answer ONLY via answer_agent, never via send_task_to_agent.",
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
        "description": "Send a task or instruction to the coding agent. Works mid-run too: by default it steers the agent after its current step; urgent=true aborts the current run first.",
        "parameters": { "type": "object", "properties": {
          "task": { "type": "string", "description": "Clear task description" },
          "user_words": { "type": "string", "description": "The user's request verbatim, as they said it" },
          "urgent": { "type": "boolean", "description": "Interrupt the agent's current run instead of steering it" }
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
        urgent: args.urgent,
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
      const els = await canvasRequest("get-scene");
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

export function pushToVoiceRaw(text: string) {
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
- `[agent finished] ...` from the `agent_end` event, summarizing the run's final assistant message

`look_at_board` should stay cheap (element count plus text contents from `getSceneElements()`). The realtime model takes image input, but it doesn't need vision for "what's on the board": the pi agent handles anything visual.

**Mute button** (the one piece of custom UI): flip the mic track. Semantic VAD means the user just talks; muting stops frames without tearing down the connection.

```typescript
micTrack.enabled = !micTrack.enabled;
```

---

## 11. The full loop, end to end

1. User speaks as they draw: "sketch the auth flow we discussed, then implement the login endpoint."
2. Voice model sees the sketch and calls `send_task_to_agent`; the task arrives at pi with the raw voice transcript attached. The voice model says "on it."
3. Pi agent (main process): `get_canvas` → sees the user's rough sketch as JSON, `screenshot_canvas` → understands the hand-drawn arrows visually, `tell_user("I'll draw the flow properly first, then implement")` → the user hears this narrated a second later.
4. `edit excalidraw` → proper diagram appears (hot refreshing once a new valid json, for visual effect; `spawn_agent` fans out the endpoint implementation and tests to subagents while pi reviews the flow; a subagent's milestone report gets relayed up via `tell_user`.
5. Pi (or pi subagent) hits an ambiguity: `ask_user("Sessions in Redis or Postgres?")` → main pi agent, which sends another ask user command, the voice model asks aloud, the user answers, `answer_agent` delivers it, and pi's blocked tool call resumes.
6. A subagent tries `rm -rf` on the wrong directory: the guard extension's approval model blocks it, the subagent is told not to retry without permission, and the user hears "[safety] I stopped the agent from..." through the same narration channel.
7. User: "actually tell the test agent to skip the flaky suite" → voice steers main pi (`send_task_to_agent`), pi calls `steer_agent` on the running subagent. Steering flows the whole way down.
8. `agent_end` → summary injected into the voice session → the model narrates: "diagram's on the board, endpoint's implemented, tests pass."
9. User draws a correction on the board and says "stop, the token refresh is wrong": `send_task_to_agent` with `urgent: true` aborts the run, transcript attached, and pi gets the new prompt and rechecks the board.

## 12. Fallback: RPC mode instead of the SDK

If Electron's bundled Node is below 22.19 or you want process isolation, spawn `pi --mode rpc --no-session` (with the system Node) and speak newline-delimited JSON over stdin/stdout: `{"type":"prompt","message":"..."}`, `{"type":"steer",...}`, `{"type":"abort"}`, with the same event stream coming back as JSON lines. Prompts accept base64 images. The catch, as noted in section 1: canvas tools must then be loaded into the subprocess as pi extensions (`--extension ./canvas-tools.ts`) and bridge back to Electron themselves (e.g. over a local HTTP port). Use the SDK unless you hit a hard blocker. Note pi's RPC framing is strict LF-delimited JSONL; don't use naive line splitting that breaks on Unicode separators inside JSON strings.

## 13. Reuse map: adapt, don't build

Almost every hard problem here has a mature, battle-tested answer. The custom code in this guide is deliberately confined to thin glue at the seams.

| Need | Reuse | Instead of |
| --- | --- | --- |
| Agent loop, tools, sessions, compaction, retries | pi SDK (`createAgentSession`) | any hand-rolled agent loop |
| Multi-provider LLM calls (the guard's judge) | `@earendil-works/pi-ai` | per-provider SDKs |
| Voice transport, audio, turn-taking, tool plumbing | `@openai/agents/realtime` (`RealtimeSession`) | hand-rolled `RTCPeerConnection` (keep raw events only for the injection outbox) |
| LLM-generated diagrams | `@excalidraw/mermaid-to-excalidraw` + `convertToExcalidrawElements` | teaching the model raw element coordinates |
| Board rendering, export | `@excalidraw/excalidraw` (`exportToBlob`, `getSceneElements`) | any custom canvas work |
| Agent instructions ecosystem | pi skills + `AGENTS.md`; point pi's `skills` setting at `~/.claude/skills` to reuse existing Claude Code skills wholesale (pi implements the Agent Skills standard) | rewriting skills per harness |
| Subagents with process isolation | pi's `examples/extensions/subagent/` | a new process manager |
| Deterministic agent tests | pi-ai's faux provider (`fauxProvider`, `fauxToolCall`) | a hand-built LLM mock |
| App scaffold | `electron-vite` | manual Electron config |

What stays custom, because nothing mature exists for these exact seams: the canvas IPC bridge, the voice bridge and its response outbox, the guard extension, and the transcript plumbing. Each is under a hundred lines, and that's the point.

## 14. Build order

(Trivial helpers referenced but not defined in the snippets, e.g. `lastAssistantText`, `summarizeCall`, `recentTranscriptSummary`, `uint8ToBase64`, `sendToRenderer`, are a few lines each; write them as you go. Test each step against `agent-test-procedure.md`, which layers an automated agent-driven test rig over exactly these seams.)

1. Electron + Excalidraw shell; verify `getSceneElements` / `updateScene` / `exportToBlob` from devtools.
2. Pi session in main with only canvas tools + a debug text box instead of voice. Get "draw a flowchart of X" working end to end. This proves the harness, the IPC bridge, and the skeleton-element drawing.
3. Add coding tools (they are just the built-ins list) and test a real coding task.
4. Add the guard extension: read-before-edit first (pure logic, easy to test), then the approval model.
5. Add the realtime voice layer with the dispatcher tools, transcript capture, and the mute button.
6. Add the upward channel (`tell_user`, `ask_user` + `answer_agent`, the response outbox) and delta transcript attachment to tasks.
7. Add subagents (`spawn_agent`/`steer_agent`/`check_agent` with event-driven result delivery), session resume (`SessionManager.continueRecent`), and the `urgent` interrupt path.

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

