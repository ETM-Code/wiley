import { afterEach, describe, expect, it, vi } from "vitest";

import { env, resetEnvWarnings } from "../src/shared/env";

afterEach(() => {
  resetEnvWarnings();
  vi.restoreAllMocks();
});

describe("env", () => {
  it("reads the current name", () => {
    expect(env("PROJECT_DIR", { WILEY_PROJECT_DIR: "/tmp/one" })).toBe("/tmp/one");
  });

  it("prefers the current name over the deprecated one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = { WILEY_PROJECT_DIR: "/tmp/one", BOARD_AI_PROJECT_DIR: "/tmp/two" };
    expect(env("PROJECT_DIR", source)).toBe("/tmp/one");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the deprecated name and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = { BOARD_AI_PORT: "5175" };
    expect(env("PORT", source)).toBe("5175");
    expect(env("PORT", source)).toBe("5175");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("WILEY_PORT");
  });

  it("warns per variable, not once for all of them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = { BOARD_AI_PORT: "5175", BOARD_AI_HOST: "0.0.0.0" };
    env("PORT", source);
    env("HOST", source);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when neither name is set", () => {
    expect(env("DATA_DIR", {})).toBeUndefined();
  });

  it("keeps an explicitly empty value, so it can mean 'unset this'", () => {
    expect(env("DATA_DIR", { WILEY_DATA_DIR: "" })).toBe("");
  });
});
