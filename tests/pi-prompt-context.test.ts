import { describe, expect, it } from "vitest";

import type { BoardSnapshot } from "../src/shared/contracts";
import { buildBoardContext, buildSubagentMessage, buildTaskMessage } from "../src/main/pi/prompt-context";

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
  const match = new RegExp(`<${tag}>\\n(.*)\\n</${tag}>`).exec(message);
  if (!match) throw new Error(`Message is missing the <${tag}> envelope`);
  return match[1];
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
    const context = JSON.parse(section(message, "current_canvas_context")) as { elementCount: number };
    expect(context.elementCount).toBe(2);
  });

  it("passes the truncation flag through to the canvas envelope", () => {
    const big = buildTaskMessage({
      task: "t",
      userWords: "w",
      transcriptEntries: [],
      board: board(101),
    });
    const context = JSON.parse(section(big, "current_canvas_context")) as { truncated: boolean };
    expect(context.truncated).toBe(true);
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
