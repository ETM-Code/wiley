import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolvePackagedPath,
  resolveProjectDir,
  sweepStaleHandoffs,
} from "../src/main/host-environment";
import { resetEnvWarnings } from "../src/shared/env";

const HOME = "/Users/tester";

afterEach(() => {
  resetEnvWarnings();
  vi.restoreAllMocks();
});

function resolve(options: Parameters<typeof resolveProjectDir>[0]) {
  const made: string[] = [];
  const dir = resolveProjectDir({ makeDir: (target) => made.push(target), ...options });
  return { dir, made };
}

describe("resolveProjectDir", () => {
  it("prefers the environment over everything else", () => {
    const { dir } = resolve({
      packaged: true,
      home: HOME,
      configured: "/other/place",
      source: { WILEY_PROJECT_DIR: "/from/env" },
    });
    expect(dir).toBe("/from/env");
  });

  it("falls back to the deprecated variable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dir } = resolve({ packaged: true, home: HOME, source: { BOARD_AI_PROJECT_DIR: "/from/env" } });
    expect(dir).toBe("/from/env");
  });

  it("uses the saved setting when the environment is silent", () => {
    const { dir } = resolve({ packaged: true, home: HOME, configured: "/saved/workspace", source: {} });
    expect(dir).toBe("/saved/workspace");
  });

  it("expands a leading ~ the way a person typing a path expects", () => {
    const { dir } = resolve({ packaged: false, home: HOME, configured: "~/code/thing", source: {} });
    expect(dir).toBe(path.join(HOME, "code/thing"));
  });

  it("creates and uses ~/Wiley for a packaged run with nothing configured", () => {
    const { dir, made } = resolve({ packaged: true, home: HOME, source: {}, cwd: "/" });
    expect(dir).toBe(path.join(HOME, "Wiley"));
    expect(made).toEqual([path.join(HOME, "Wiley")]);
  });

  it("keeps the launch directory when running from a checkout", () => {
    const { dir, made } = resolve({ packaged: false, home: HOME, source: {}, cwd: "/repo/wiley" });
    expect(dir).toBe("/repo/wiley");
    expect(made).toEqual([]);
  });

  // "/" is what a Finder-launched app inherits as its working directory, and
  // pointing a coding agent at the whole filesystem is never what was meant.
  it("never resolves to the filesystem root", () => {
    expect(resolve({ packaged: false, home: HOME, source: {}, cwd: "/" }).dir).toBe(path.join(HOME, "Wiley"));
    expect(resolve({ packaged: true, home: HOME, configured: "/", source: {} }).dir).toBe(path.join(HOME, "Wiley"));
    expect(resolve({ packaged: true, home: HOME, source: { WILEY_PROJECT_DIR: "/" } }).dir)
      .toBe(path.join(HOME, "Wiley"));
  });
});

describe("resolvePackagedPath", () => {
  const home = "/Users/tester";

  it("takes the login shell's PATH when it knows more places", () => {
    const result = resolvePackagedPath({
      currentPath: "/usr/bin:/bin",
      home,
      readLoginPath: () => "/opt/homebrew/bin:/usr/bin:/bin:/Users/tester/.bun/bin",
    });
    expect(result.split(":")).toContain("/Users/tester/.bun/bin");
    expect(result.split(":")).toContain("/opt/homebrew/bin");
  });

  it("keeps the inherited PATH when the login shell says less", () => {
    const result = resolvePackagedPath({
      currentPath: "/usr/bin:/bin:/Users/tester/.cargo/bin",
      home,
      readLoginPath: () => "/usr/bin",
    });
    expect(result.split(":")).toContain("/Users/tester/.cargo/bin");
  });

  it("still adds the worker directories when the shell fails", () => {
    const result = resolvePackagedPath({ currentPath: "/usr/bin", home, readLoginPath: () => undefined });
    expect(result.split(":")).toEqual([
      "/usr/bin",
      "/Users/tester/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  it("never repeats a directory already on the PATH", () => {
    const result = resolvePackagedPath({
      currentPath: "/opt/homebrew/bin:/usr/bin",
      home,
      readLoginPath: () => undefined,
    });
    expect(result.split(":").filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
  });
});

describe("sweepStaleHandoffs", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function age(target: string, days: number): Promise<void> {
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    await utimes(target, when, when);
  }

  it("removes handoff directories older than a week and leaves the rest alone", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wiley-sweep-"));
    const stale = path.join(root, "wiley-handoff-old");
    const fresh = path.join(root, "wiley-handoff-new");
    const foreign = path.join(root, "someone-elses-dir");
    for (const dir of [stale, fresh, foreign]) {
      await mkdir(dir);
      await writeFile(path.join(dir, "session.sh"), "echo hi\n");
    }
    await age(stale, 9);
    await age(foreign, 400);

    expect(sweepStaleHandoffs({ dir: root })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it("reports nothing swept when the directory cannot be read", () => {
    expect(sweepStaleHandoffs({ dir: path.join(os.tmpdir(), "wiley-not-a-directory-anywhere") })).toBe(0);
  });
});
