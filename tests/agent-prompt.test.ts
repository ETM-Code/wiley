import { describe, expect, it } from "vitest";

import { BOARD_AGENT_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT } from "../src/main/agent-prompt";

describe("shared canvas instructions", () => {
  it.each([
    ["root", BOARD_AGENT_SYSTEM_PROMPT],
    ["subagent", SUBAGENT_SYSTEM_PROMPT],
  ])("requires perimeter-bound connectors for the %s agent", (_name, prompt) => {
    expect(prompt).toContain("attach to the visible perimeter");
    expect(prompt).toContain("must never terminate in");
    expect(prompt).toContain("valid\n  start and end element bindings");
  });
});
