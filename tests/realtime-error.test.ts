import { describe, expect, it } from "vitest";
import { extractRealtimeErrorMessage } from "../src/renderer/realtime-error";

describe("extractRealtimeErrorMessage", () => {
  it("pulls the message out of an OpenAI error body", () => {
    const body = JSON.stringify({
      error: { message: "The model `gpt-realtime-mini-2.1` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" },
    });
    expect(extractRealtimeErrorMessage(body)).toBe(
      "The model `gpt-realtime-mini-2.1` does not exist or you do not have access to it.",
    );
  });

  it("returns undefined for a non-JSON body", () => {
    expect(extractRealtimeErrorMessage("not json")).toBeUndefined();
  });

  it("returns undefined when the error has no message", () => {
    expect(extractRealtimeErrorMessage(JSON.stringify({ error: {} }))).toBeUndefined();
  });

  it("returns undefined for an empty body", () => {
    expect(extractRealtimeErrorMessage("")).toBeUndefined();
  });
});
