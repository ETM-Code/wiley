import { describe, expect, it } from "vitest";

import { openedLabel, shortPath } from "../src/renderer/project-path";

describe("openedLabel", () => {
  it("says nothing for a folder that was never opened here", () => {
    expect(openedLabel({ lastOpenedAt: "1970-01-01T00:00:00.000Z" })).toBeUndefined();
    expect(openedLabel({ lastOpenedAt: "not a date" })).toBeUndefined();
  });

  it("dates a folder that was", () => {
    expect(openedLabel({ lastOpenedAt: "2026-08-16T10:00:00.000Z" })).toBeTruthy();
  });
});

describe("shortPath", () => {
  it("leaves a path that already fits alone", () => {
    expect(shortPath("/work/app")).toBe("/work/app");
  });

  // Every deep path shares its first few segments, so trimming the end would
  // turn a list of different folders into a column of identical strings.
  it("trims the front, which is the half that repeats", () => {
    const long = "/Users/tester/Library/Application Support/somewhere/deep/inside/the-project";
    const short = shortPath(long);
    expect(short.startsWith("…/")).toBe(true);
    expect(short.endsWith("the-project")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(52);
  });

  it("keeps at least the folder's own name however long it is", () => {
    expect(shortPath("/a/" + "x".repeat(80))).toBe(`…/${"x".repeat(80)}`);
  });
});
