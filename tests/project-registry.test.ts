import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_PROJECTS,
  normalizeProjectPath,
  normalizeRecentProjects,
  normalizeSettings,
  recordRecentProject,
} from "../src/main/settings/settings-schema";

function entry(path: string, lastOpenedAt: string) {
  return { path, lastOpenedAt };
}

describe("normalizeProjectPath", () => {
  it("trims and drops trailing separators so one folder is one entry", () => {
    expect(normalizeProjectPath("  /work/app  ")).toBe("/work/app");
    expect(normalizeProjectPath("/work/app/")).toBe("/work/app");
    expect(normalizeProjectPath("/work/app///")).toBe("/work/app");
    expect(normalizeProjectPath("C:\\work\\app\\")).toBe("C:\\work\\app");
  });

  it("refuses anything that is not a folder someone meant to open", () => {
    expect(normalizeProjectPath("")).toBeUndefined();
    expect(normalizeProjectPath("   ")).toBeUndefined();
    expect(normalizeProjectPath("/")).toBeUndefined();
    expect(normalizeProjectPath("C:\\")).toBeUndefined();
    expect(normalizeProjectPath(42)).toBeUndefined();
    expect(normalizeProjectPath(undefined)).toBeUndefined();
  });
});

describe("normalizeRecentProjects", () => {
  it("returns nothing for anything that is not a list", () => {
    expect(normalizeRecentProjects(undefined)).toEqual([]);
    expect(normalizeRecentProjects({ path: "/work/app" })).toEqual([]);
    expect(normalizeRecentProjects("/work/app")).toEqual([]);
  });

  it("orders newest first whatever order the file was in", () => {
    const list = normalizeRecentProjects([
      entry("/work/old", "2024-01-01T00:00:00.000Z"),
      entry("/work/new", "2026-01-01T00:00:00.000Z"),
      entry("/work/middle", "2025-01-01T00:00:00.000Z"),
    ]);
    expect(list.map((item) => item.path)).toEqual(["/work/new", "/work/middle", "/work/old"]);
  });

  it("keeps one entry per folder, at its most recent opening", () => {
    const list = normalizeRecentProjects([
      entry("/work/app", "2024-01-01T00:00:00.000Z"),
      entry("/work/app/", "2026-01-01T00:00:00.000Z"),
      entry("  /work/app  ", "2025-01-01T00:00:00.000Z"),
    ]);
    expect(list).toEqual([entry("/work/app", "2026-01-01T00:00:00.000Z")]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_RECENT_PROJECTS + 5 }, (_, index) =>
      entry(`/work/app-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`));
    const list = normalizeRecentProjects(many);
    expect(list).toHaveLength(MAX_RECENT_PROJECTS);
    // The oldest are the ones that fall off, not the newest.
    expect(list[0].path).toBe(`/work/app-${MAX_RECENT_PROJECTS + 4}`);
  });

  it("keeps a hand-written entry that is only a path, sorted last", () => {
    const list = normalizeRecentProjects(["/work/typed", entry("/work/tracked", "2026-01-01T00:00:00.000Z")]);
    expect(list.map((item) => item.path)).toEqual(["/work/tracked", "/work/typed"]);
    expect(list[1].lastOpenedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("drops entries with no usable path", () => {
    expect(normalizeRecentProjects([entry("/", "2026-01-01T00:00:00.000Z"), entry("  ", "x"), null, 7]))
      .toEqual([]);
  });

  it("normalizes a nonsense timestamp rather than dropping the folder", () => {
    expect(normalizeRecentProjects([entry("/work/app", "not a date")]))
      .toEqual([entry("/work/app", "1970-01-01T00:00:00.000Z")]);
  });
});

describe("recordRecentProject", () => {
  it("puts the folder just opened at the front", () => {
    const list = recordRecentProject(
      [entry("/work/other", "2026-06-01T00:00:00.000Z")],
      "/work/app",
      "2026-05-01T00:00:00.000Z",
    );
    expect(list.map((item) => item.path)).toEqual(["/work/app", "/work/other"]);
  });

  it("moves a folder already in the list rather than repeating it", () => {
    const list = recordRecentProject(
      [entry("/work/a", "2026-01-01T00:00:00.000Z"), entry("/work/b", "2025-01-01T00:00:00.000Z")],
      "/work/b/",
      "2026-08-01T00:00:00.000Z",
    );
    expect(list).toEqual([
      entry("/work/b", "2026-08-01T00:00:00.000Z"),
      entry("/work/a", "2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("never grows past the cap", () => {
    const full = Array.from({ length: MAX_RECENT_PROJECTS }, (_, index) =>
      entry(`/work/app-${index}`, "2026-01-01T00:00:00.000Z"));
    expect(recordRecentProject(full, "/work/fresh", "2026-09-01T00:00:00.000Z")).toHaveLength(MAX_RECENT_PROJECTS);
  });

  it("leaves the list alone when handed nothing openable", () => {
    const existing = [entry("/work/app", "2026-01-01T00:00:00.000Z")];
    expect(recordRecentProject(existing, "/", "2026-09-01T00:00:00.000Z")).toEqual(existing);
  });
});

describe("settings normalization of the registry", () => {
  it("defaults to an empty registry with no project remembered", () => {
    const settings = normalizeSettings({});
    expect(settings.recentProjects).toEqual([]);
    expect(settings.lastProject).toBeUndefined();
  });

  it("normalizes a stored registry and the last project together", () => {
    const settings = normalizeSettings({
      lastProject: " /work/app/ ",
      recentProjects: [entry("/work/app/", "2026-01-01T00:00:00.000Z"), entry("/work/app", "2025-01-01T00:00:00.000Z")],
    });
    expect(settings.lastProject).toBe("/work/app");
    expect(settings.recentProjects).toEqual([entry("/work/app", "2026-01-01T00:00:00.000Z")]);
  });

  it("drops a last project that is not a folder", () => {
    expect(normalizeSettings({ lastProject: "/" }).lastProject).toBeUndefined();
  });
});
