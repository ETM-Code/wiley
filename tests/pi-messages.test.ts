import { describe, expect, it } from "vitest";

import { lastAssistantText } from "../src/main/pi/messages";

describe("lastAssistantText", () => {
  it("returns a fallback when there are no messages", () => {
    expect(lastAssistantText([])).toBe("Work finished.");
  });

  it("returns a fallback when no message came from the assistant", () => {
    expect(lastAssistantText([{ role: "user", content: "draw a box" }])).toBe("Work finished.");
  });

  it("reads string content", () => {
    expect(lastAssistantText([{ role: "assistant", content: "done" }])).toBe("done");
  });

  it("prefers the last assistant message", () => {
    const messages = [
      { role: "assistant", content: "first" },
      { role: "user", content: "and then?" },
      { role: "assistant", content: "second" },
    ];
    expect(lastAssistantText(messages)).toBe("second");
  });

  it("joins the text blocks of array content and ignores other block types", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    }];
    expect(lastAssistantText(messages)).toBe("line one\nline two");
  });

  it("skips an assistant message whose array content holds no text", () => {
    const messages = [
      { role: "assistant", content: "earlier" },
      { role: "assistant", content: [{ type: "toolcall", name: "draw_shape" }] },
    ];
    expect(lastAssistantText(messages)).toBe("earlier");
  });

  it("skips an assistant message whose text blocks are all blank", () => {
    const messages = [
      { role: "assistant", content: "earlier" },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    expect(lastAssistantText(messages)).toBe("earlier");
  });
});
