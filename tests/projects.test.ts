import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adoptGlobalLedger,
  buildProjectView,
  describeProject,
  LEDGER_FILE,
  projectDataDir,
  projectName,
  resolveLaunchProject,
  toProjectPath,
} from "../src/main/projects";
import { resetEnvWarnings } from "../src/shared/env";

const HOME = "/Users/tester";

afterEach(() => resetEnvWarnings());

/** A world where exactly the named paths exist. */
function world(...present: string[]) {
  const set = new Set(present);
  return (target: string) => set.has(target);
}

describe("projectDataDir", () => {
  it("uses .wiley for a project that has neither directory yet", () => {
    expect(projectDataDir("/work/app", world())).toBe(path.join("/work/app", ".wiley"));
  });

  it("keeps a .board-ai left by an older version", () => {
    expect(projectDataDir("/work/app", world(path.join("/work/app", ".board-ai"))))
      .toBe(path.join("/work/app", ".board-ai"));
  });

  it("prefers .wiley when a project somehow has both", () => {
    const project = "/work/app";
    const exists = world(path.join(project, ".wiley"), path.join(project, ".board-ai"));
    expect(projectDataDir(project, exists)).toBe(path.join(project, ".wiley"));
  });
});

describe("toProjectPath", () => {
  it("expands a leading ~ and resolves to an absolute path", () => {
    expect(toProjectPath("~/code/thing", HOME)).toBe(path.join(HOME, "code/thing"));
  });

  it("refuses the filesystem root however it is spelled", () => {
    expect(toProjectPath("/", HOME)).toBeUndefined();
    expect(toProjectPath("//", HOME)).toBeUndefined();
    expect(toProjectPath("", HOME)).toBeUndefined();
    expect(toProjectPath(undefined, HOME)).toBeUndefined();
  });
});

describe("resolveLaunchProject", () => {
  it("prefers the environment, and takes it on trust", () => {
    const resolved = resolveLaunchProject({
      settings: { lastProject: "/saved/last", projectDir: "/saved/manual" },
      home: HOME,
      source: { WILEY_PROJECT_DIR: "/from/env" },
      exists: world(),
    });
    expect(resolved).toBe("/from/env");
  });

  it("reopens the last project when it is still there", () => {
    const resolved = resolveLaunchProject({
      settings: { lastProject: "/saved/last", projectDir: "/saved/manual" },
      home: HOME,
      source: {},
      exists: world("/saved/last", "/saved/manual"),
    });
    expect(resolved).toBe("/saved/last");
  });

  it("falls back to the manual override when the last project is gone", () => {
    const resolved = resolveLaunchProject({
      settings: { lastProject: "/saved/last", projectDir: "/saved/manual" },
      home: HOME,
      source: {},
      exists: world("/saved/manual"),
    });
    expect(resolved).toBe("/saved/manual");
  });

  // Silently recreating a folder someone deleted would put the agent to work
  // in an empty directory that looks like their project and is not.
  it("asks rather than recreating a project that is no longer on disk", () => {
    const resolved = resolveLaunchProject({
      settings: { lastProject: "/saved/last" },
      home: HOME,
      source: {},
      exists: world(),
    });
    expect(resolved).toBeUndefined();
  });

  it("asks when nothing at all has been chosen yet", () => {
    expect(resolveLaunchProject({ settings: {}, home: HOME, source: {}, exists: world() })).toBeUndefined();
  });
});

describe("describeProject and buildProjectView", () => {
  it("names a project after its folder and flags one that is gone", () => {
    const entry = describeProject("/work/app", "2026-01-01T00:00:00.000Z", world("/work/app"));
    expect(entry).toEqual({
      path: "/work/app",
      name: "app",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      missing: false,
    });
    expect(describeProject("/work/gone", "2026-01-01T00:00:00.000Z", world()).missing).toBe(true);
    expect(projectName("/work/app/")).toBe("app");
  });

  it("carries the current project's own timestamp through from the registry", () => {
    const view = buildProjectView({
      current: "/work/app",
      recent: [
        { path: "/work/app", lastOpenedAt: "2026-02-02T00:00:00.000Z" },
        { path: "/work/gone", lastOpenedAt: "2025-01-01T00:00:00.000Z" },
      ],
      canOpen: true,
      exists: world("/work/app"),
    });
    expect(view.current).toEqual({
      path: "/work/app",
      name: "app",
      lastOpenedAt: "2026-02-02T00:00:00.000Z",
      missing: false,
    });
    expect(view.recent.map((entry) => entry.missing)).toEqual([false, true]);
    expect(view.canOpen).toBe(true);
  });

  it("has no current project before one is opened", () => {
    const view = buildProjectView({ canOpen: true, exists: world() });
    expect(view.current).toBeUndefined();
    expect(view.recent).toEqual([]);
  });
});

describe("adoptGlobalLedger", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function temp(): Promise<{ legacyDir: string; dataDir: string }> {
    root = await mkdtemp(path.join(os.tmpdir(), "wiley-adopt-"));
    const legacyDir = path.join(root, "userData");
    const dataDir = path.join(root, "project", ".wiley");
    mkdirSync(legacyDir, { recursive: true });
    return { legacyDir, dataDir };
  }

  function writeLedger(dir: string, contents: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, LEDGER_FILE), contents);
  }

  it("moves the old global ledger into the first project that has none", async () => {
    const { legacyDir, dataDir } = await temp();
    writeLedger(legacyDir, "old history");
    writeFileSync(path.join(legacyDir, `${LEDGER_FILE}-wal`), "wal");

    const adopted = adoptGlobalLedger({ legacyDir, dataDir });

    expect(adopted).toMatchObject({ to: path.join(dataDir, LEDGER_FILE) });
    expect(readFileSync(path.join(dataDir, LEDGER_FILE), "utf8")).toBe("old history");
    expect(readFileSync(path.join(dataDir, `${LEDGER_FILE}-wal`), "utf8")).toBe("wal");
    // Kept, not deleted, and no longer looking like a live ledger.
    expect(existsSync(path.join(legacyDir, LEDGER_FILE))).toBe(false);
    expect(existsSync(path.join(legacyDir, `${LEDGER_FILE}-wal`))).toBe(false);
    expect(readFileSync(`${adopted!.backup}`, "utf8")).toBe("old history");
    expect(readFileSync(`${adopted!.backup}-wal`, "utf8")).toBe("wal");
  });

  // The offer belongs to the first project opened, and only to that one. The
  // host consumes it whether or not it was taken up, so a returning user whose
  // first project already has a ledger never finds that shared history dropped
  // into whichever unrelated empty folder they open next.
  it("never drops a ledger on a project that already has its own", async () => {
    const { legacyDir, dataDir } = await temp();
    writeLedger(legacyDir, "old history");
    writeLedger(dataDir, "this project's own history");

    expect(adoptGlobalLedger({ legacyDir, dataDir })).toBeUndefined();
    expect(readFileSync(path.join(dataDir, LEDGER_FILE), "utf8")).toBe("this project's own history");
    // Left exactly where it was, so it is still there to be recovered by hand.
    expect(existsSync(path.join(legacyDir, LEDGER_FILE))).toBe(true);
  });

  it("runs once: the second project after the upgrade starts empty", async () => {
    const { legacyDir, dataDir } = await temp();
    writeLedger(legacyDir, "old history");
    expect(adoptGlobalLedger({ legacyDir, dataDir })).toBeDefined();

    const second = path.join(root, "second", ".wiley");
    expect(adoptGlobalLedger({ legacyDir, dataDir: second })).toBeUndefined();
    expect(existsSync(path.join(second, LEDGER_FILE))).toBe(false);
  });

  // A crash between the copy and the rename would otherwise hand the same
  // history to the next project opened as well.
  it("does not adopt again when a previous run left the backup behind", async () => {
    const { legacyDir, dataDir } = await temp();
    writeLedger(legacyDir, "old history");
    writeFileSync(`${path.join(legacyDir, LEDGER_FILE)}.bak`, "old history");

    expect(adoptGlobalLedger({ legacyDir, dataDir })).toBeUndefined();
    expect(existsSync(path.join(dataDir, LEDGER_FILE))).toBe(false);
  });

  it("does nothing when there was never a global ledger", async () => {
    const { legacyDir, dataDir } = await temp();
    expect(adoptGlobalLedger({ legacyDir, dataDir })).toBeUndefined();
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does nothing when the project's data directory is the global one", async () => {
    const { legacyDir } = await temp();
    writeLedger(legacyDir, "old history");
    expect(adoptGlobalLedger({ legacyDir, dataDir: legacyDir })).toBeUndefined();
    expect(readFileSync(path.join(legacyDir, LEDGER_FILE), "utf8")).toBe("old history");
  });
});
