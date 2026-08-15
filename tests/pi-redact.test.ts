import { describe, expect, it } from "vitest";

import { redact } from "../src/main/pi/redact";

describe("redact", () => {
  it("leaves an ordinary payload untouched", () => {
    expect(redact({ toolName: "draw_shape", input: { shape: "rectangle" } }))
      .toEqual({ toolName: "draw_shape", input: { shape: "rectangle" } });
  });

  it("masks every credential-shaped key spelling", () => {
    const value = {
      apiKey: "sk-live-1",
      api_key: "sk-live-2",
      "api-key": "sk-live-3",
      Authorization: "Bearer abc",
      token: "t",
      SECRET: "s",
      password: "p",
      cookie: "c",
    };
    expect(redact(value)).toEqual({
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      "api-key": "[REDACTED]",
      Authorization: "[REDACTED]",
      token: "[REDACTED]",
      SECRET: "[REDACTED]",
      password: "[REDACTED]",
      cookie: "[REDACTED]",
    });
  });

  it("masks nested credentials and keys that merely contain the word", () => {
    expect(redact({ headers: { authorization: "Bearer x" }, refreshToken: "r", user: "ada" }))
      .toEqual({ headers: { authorization: "[REDACTED]" }, refreshToken: "[REDACTED]", user: "ada" });
  });

  it("does not mask a credential-shaped value under an innocent key", () => {
    expect(redact({ command: "export API_KEY=sk-live" })).toEqual({ command: "export API_KEY=sk-live" });
  });

  it("truncates a payload longer than 100 KB of JSON", () => {
    const result = redact({ blob: "x".repeat(150_000) });
    expect(typeof result).toBe("string");
    expect(result as string).toHaveLength(100_000 + "…[truncated]".length);
    expect(result as string).toMatch(/…\[truncated\]$/);
  });

  it("keeps a payload that serializes to just under the cap", () => {
    const value = { blob: "x".repeat(99_000) };
    expect(redact(value)).toEqual(value);
  });

  it("falls back to the stringified value when JSON has no representation", () => {
    expect(redact(undefined)).toBe("undefined");
  });
});
