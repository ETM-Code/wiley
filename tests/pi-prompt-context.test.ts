import { describe, expect, it } from "vitest";

import type { BoardSnapshot } from "../src/shared/contracts";
import {
  boardDiagrams,
  buildBoardContext,
  buildSubagentMessage,
  buildTaskMessage,
  formatDiagramListing,
} from "../src/main/pi/prompt-context";

function board(elementCount: number): BoardSnapshot {
  return {
    revision: 7,
    appState: { viewBackgroundColor: "#fff" },
    elements: Array.from({ length: elementCount }, (_unused, index) => ({
      id: `el-${index}`,
      type: "rectangle",
      x: index,
      y: index * 2,
      width: 100,
      height: 60,
      text: `label ${index}`,
      seed: 12345,
      versionNonce: 999,
    })),
  };
}

function section(message: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*)\\n</${tag}>`).exec(message);
  if (!match) throw new Error(`Message is missing the <${tag}> envelope`);
  return match[1];
}

/** The canvas envelope leads with the JSON context, then the diagram listing. */
function canvasContext<T>(message: string): T {
  return JSON.parse(section(message, "current_canvas_context").split("\n")[0]) as T;
}

describe("buildBoardContext", () => {
  it("reports the true element count while sampling the first 100 elements", () => {
    const context = buildBoardContext(board(140));
    expect(context.elementCount).toBe(140);
    expect(context.elements).toHaveLength(100);
    expect(context.truncated).toBe(true);
  });

  it("does not flag truncation at exactly the limit", () => {
    const context = buildBoardContext(board(100));
    expect(context.elements).toHaveLength(100);
    expect(context.truncated).toBe(false);
  });

  it("carries the revision and viewport, and drops noisy element internals", () => {
    const context = buildBoardContext(board(1));
    expect(context.revision).toBe(7);
    expect(context.viewport).toEqual({ viewBackgroundColor: "#fff" });
    expect(context.elements[0]).toEqual({
      id: "el-0",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      text: "label 0",
    });
  });
});

describe("buildTaskMessage", () => {
  const message = buildTaskMessage({
    task: "Draw the login flow",
    userWords: "draw the login flow please",
    transcriptEntries: [{ role: "user", text: "draw the login flow please" }],
    board: board(2),
  });

  it("leads with the task", () => {
    expect(message.startsWith("Draw the login flow\n")).toBe(true);
  });

  it("includes the user's verbatim words as a JSON string", () => {
    expect(message).toContain('User\'s words, verbatim: "draw the login flow please"');
  });

  it("wraps the transcript delta in a voice_conversation_context envelope", () => {
    expect(JSON.parse(section(message, "voice_conversation_context")))
      .toEqual([{ role: "user", text: "draw the login flow please" }]);
  });

  it("wraps the board context in a current_canvas_context envelope", () => {
    expect(canvasContext<{ elementCount: number }>(message).elementCount).toBe(2);
  });

  it("passes the truncation flag through to the canvas envelope", () => {
    const big = buildTaskMessage({
      task: "t",
      userWords: "w",
      transcriptEntries: [],
      board: board(101),
    });
    expect(canvasContext<{ truncated: boolean }>(big).truncated).toBe(true);
  });
});

describe("board diagrams", () => {
  const stamped: BoardSnapshot = {
    revision: 3,
    appState: {},
    elements: [
      { id: "human-box", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      {
        id: "wd-flow-1-title", type: "text", x: 0, y: 0, width: 100, height: 40, text: "Login flow",
        customData: { wiley: { diagram: "wd-flow-1", role: "title" } },
      },
      {
        id: "wd-flow-1-n-start", type: "rectangle", x: 0, y: 60, width: 100, height: 40,
        customData: { wiley: { diagram: "wd-flow-1", role: "node", key: "start" } },
      },
      {
        id: "wd-flow-1-n-done", type: "rectangle", x: 200, y: 60, width: 100, height: 40,
        customData: { wiley: { diagram: "wd-flow-1", role: "node", key: "done" } },
      },
      {
        id: "wd-other-2-n-a", type: "ellipse", x: 0, y: 400, width: 80, height: 40,
        customData: { wiley: { diagram: "wd-other-2", role: "node", key: "a" } },
      },
    ],
  };

  it("groups stamped elements by diagram and ignores hand-drawn ones", () => {
    expect(boardDiagrams(stamped)).toEqual([
      { id: "wd-flow-1", title: "Login flow", nodeKeys: ["start", "done"], elementCount: 3 },
      { id: "wd-other-2", nodeKeys: ["a"], elementCount: 1 },
    ]);
  });

  it("reports no diagrams for a board of hand-drawn elements", () => {
    expect(boardDiagrams(board(3))).toEqual([]);
    expect(formatDiagramListing([])).toBe("(none)");
  });

  it("lists one line per diagram with its title and node keys", () => {
    expect(formatDiagramListing(boardDiagrams(stamped)).split("\n")).toEqual([
      'wd-flow-1 "Login flow" nodes=[start, done] elements=3',
      "wd-other-2 (untitled) nodes=[a] elements=1",
    ]);
  });

  it("carries the listing inside the canvas envelope of a task message", () => {
    const message = buildTaskMessage({
      task: "extend it",
      userWords: "extend it",
      transcriptEntries: [],
      board: stamped,
    });
    expect(section(message, "diagrams")).toContain("wd-flow-1");
    expect(canvasContext<{ diagrams: unknown[] }>(message).diagrams).toHaveLength(2);
  });
});

describe("buildSubagentMessage", () => {
  const message = buildSubagentMessage({
    task: "Research the auth code",
    transcriptContext: [{ role: "user", text: "look at auth" }],
    peerEvents: [{ type: "tool_started", payload: { toolName: "read" } }],
  });

  it("leads with the task", () => {
    expect(message.startsWith("Research the auth code\n")).toBe(true);
  });

  it("wraps the conversation context and the peer event feed in their envelopes", () => {
    expect(JSON.parse(section(message, "voice_conversation_context")))
      .toEqual([{ role: "user", text: "look at auth" }]);
    expect(JSON.parse(section(message, "peer_agent_events")))
      .toEqual([{ type: "tool_started", payload: { toolName: "read" } }]);
  });

  it("carries no canvas envelope, which subagents receive through tools instead", () => {
    expect(message).not.toContain("current_canvas_context");
  });
});
