import { describe, expect, it } from "vitest";

import { BOARD_AGENT_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "../src/main/agent-prompt";

describe("shared canvas instructions", () => {
  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("requires perimeter-bound connectors for the %s agent", (_name, prompt) => {
    expect(prompt).toContain("attach to the visible perimeter");
    expect(prompt).toContain("must never terminate in");
    expect(prompt).toContain("start and end element bindings");
  });

  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("routes existing-element connections through connect_shapes for the %s agent", (_name, prompt) => {
    expect(prompt).toContain("connect_shapes");
    expect(prompt).toContain("bidirectional");
    expect(prompt).toContain("Never hand-place connector coordinates");
  });

  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("protects the user's drawings from clearing for the %s agent", (_name, prompt) => {
    expect(prompt).toContain("never to discard");
    expect(prompt).toContain("clear_canvas only when the user's verbatim words explicitly ask");
    expect(prompt).toContain("fill in, connect, finish, extend, tidy, or annotate");
  });

  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("teaches directional placement beside existing content for the %s agent", (_name, prompt) => {
    expect(prompt).toContain("anchorDirection");
    expect(prompt).toContain("placeDirection");
  });

  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("mandates visible process for the %s agent: narration, look-draw-look, erasing, walkthrough", (_name, prompt) => {
    expect(prompt).toContain("coworker at the whiteboard");
    expect(prompt).toContain("Narrate as you go");
    expect(prompt).toContain("alternate looking and drawing");
    expect(prompt).toContain("erase or correct it on the board");
    expect(prompt).toContain("spoken\n  walkthrough");
  });

  it("gives the root agent the coding protocol with the safety escalation path", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("Coding protocol");
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("never retry it or work around the block");
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("ask_user");
  });

  it("tells subagents blocked calls escalate instead of retrying", () => {
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("safety reviewer");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("never retry it or work around the block");
  });
});
