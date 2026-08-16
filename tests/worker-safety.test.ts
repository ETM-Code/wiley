import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalJudge } from "../src/main/safety";
import {
  createWorkerCommandTripwire,
  createWorkerFloorReviewer,
  createWorkerToolReviewer,
  isJudgedWorkerTool,
  matchesDenyRule,
  toolTarget,
  type WorkerSafetyDeps,
} from "../src/main/workers/worker-safety";
import type { WorkerSpec } from "../src/main/workers/worker-types";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiley-worker-safety-"));
  cleanup.push(dir);
  return dir;
}

const spec: WorkerSpec = { id: "w-1", kind: "claude", parentJobId: "job-1", task: "do it" };

interface Bench {
  review: ReturnType<typeof createWorkerToolReviewer>;
  spoken: string[];
  projectDir: string;
  judged: Array<{ tool: string }>;
}

async function bench(overrides: Partial<WorkerSafetyDeps> = {}, verdict = "APPROVE"): Promise<Bench> {
  const projectDir = await project();
  const spoken: string[] = [];
  const judged: Array<{ tool: string }> = [];
  const deps: WorkerSafetyDeps = {
    projectDir,
    voice: { push: (message) => spoken.push(message) },
    denyRules: () => [],
    recentUserRequests: () => ["make the thing"],
    approvalJudge: () => new ApprovalJudge(async ({ userMessage }) => {
      judged.push({ tool: String(JSON.parse(userMessage).tool) });
      return verdict;
    }),
    ...overrides,
  };
  return { review: createWorkerToolReviewer(deps), spoken, projectDir, judged };
}

describe("deny rules", () => {
  it("matches a Claude Code style rule against a command", () => {
    expect(matchesDenyRule("Bash(sudo *)", "Bash", "sudo rm -rf /", "/proj")).toBe(true);
    expect(matchesDenyRule("Bash(sudo *)", "Bash", "npm test", "/proj")).toBe(false);
    expect(matchesDenyRule("Bash(sudo *)", "Write", "sudo anything", "/proj")).toBe(false);
  });

  it("catches a project-relative path rule against an absolute target", () => {
    expect(matchesDenyRule("Read(./.env)", "Read", "/proj/.env", "/proj")).toBe(true);
    expect(matchesDenyRule("Read(./.env.*)", "Read", "/proj/.env.local", "/proj")).toBe(true);
    expect(matchesDenyRule("Read(./.env)", "Read", "/proj/src/.envoy", "/proj")).toBe(false);
  });

  it("treats a bare tool name as the whole tool", () => {
    expect(matchesDenyRule("WebFetch", "WebFetch", "https://example.com", "/proj")).toBe(true);
    expect(matchesDenyRule("nonsense((", "Bash", "ls", "/proj")).toBe(false);
  });

  it("blocks the configured rule and says which one, out loud", async () => {
    const { review, spoken } = await bench({ denyRules: () => ["Read(./.env)"] });
    const decision = await review({
      spec,
      toolName: "Read",
      input: { file_path: ".env" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("Read(./.env)");
    expect(spoken[0]).toContain("[safety]");
    // The user hears Wiley, never a worker or a CLI.
    expect(spoken[0]).not.toMatch(/claude|codex|worker/i);
  });
});

describe("hard command floor", () => {
  it("blocks a catastrophic command before any model is consulted", async () => {
    const { review, spoken, judged } = await bench();
    const decision = await review({
      spec,
      toolName: "Bash",
      input: { command: "rm -rf /" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(false);
    expect(judged).toHaveLength(0);
    expect(spoken).toHaveLength(1);
  });

  it("lets an ordinary project command through", async () => {
    const { review, projectDir } = await bench();
    const decision = await review({
      spec,
      toolName: "Bash",
      input: { command: "npm test" },
      cwd: projectDir,
    });

    expect(decision.allow).toBe(true);
  });

  it("skips the judge for a cheap read-only command", async () => {
    const { review, judged, projectDir } = await bench();
    await review({ spec, toolName: "Bash", input: { command: "git status" }, cwd: projectDir });

    expect(judged).toHaveLength(0);
  });
});

describe("write scope", () => {
  it("refuses a write outside the workspace", async () => {
    const { review } = await bench();
    const decision = await review({
      spec,
      toolName: "Write",
      input: { file_path: "/etc/hosts" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("outside the workspace");
  });

  it("allows a write to a directory the settings opened up", async () => {
    const extra = await project();
    const { review } = await bench({ writableRoots: () => [extra] });
    const decision = await review({
      spec,
      toolName: "Write",
      input: { file_path: path.join(extra, "notes.md") },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(true);
  });

  it("allows a write inside the project itself", async () => {
    const { review, projectDir } = await bench();
    const decision = await review({
      spec,
      toolName: "Write",
      input: { file_path: path.join(projectDir, "src", "index.ts") },
      cwd: projectDir,
    });

    expect(decision.allow).toBe(true);
  });
});

describe("approval judge layer", () => {
  it("blocks when the judge says so, and repeats its reason", async () => {
    const { review, spoken } = await bench({}, "BLOCK force pushes rewrite shared history");
    const decision = await review({
      spec,
      toolName: "Bash",
      input: { command: "git push --force origin main" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("force pushes");
    expect(spoken[0]).toContain("force pushes");
  });

  it("fails open when the judge itself breaks", async () => {
    const { review } = await bench({
      approvalJudge: () => new ApprovalJudge(async () => {
        throw new Error("judge is down");
      }),
    });
    const decision = await review({
      spec,
      toolName: "Bash",
      input: { command: "git push origin main" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(true);
  });

  it("allows everything the hard floor passed when no judge is configured", async () => {
    const { review } = await bench({ approvalJudge: () => undefined });
    const decision = await review({
      spec,
      toolName: "Bash",
      input: { command: "git push origin main" },
      cwd: "/proj",
    });

    expect(decision.allow).toBe(true);
  });

  it("never asks about a read or a search", async () => {
    const { review, judged } = await bench();
    for (const toolName of ["Read", "Grep", "Glob"]) {
      expect((await review({ spec, toolName, input: { file_path: "src/x.ts" }, cwd: "/proj" })).allow).toBe(true);
    }
    expect(judged).toHaveLength(0);
    expect(isJudgedWorkerTool("Read")).toBe(false);
    expect(isJudgedWorkerTool("Bash")).toBe(true);
    expect(isJudgedWorkerTool("Write")).toBe(true);
  });
});

describe("tool targets", () => {
  it("finds the part of each tool call the rules care about", () => {
    expect(toolTarget("Bash", { command: "ls" })).toBe("ls");
    expect(toolTarget("Write", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolTarget("Edit", { path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolTarget("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(toolTarget("Bash", {})).toBeUndefined();
  });
});

describe("codex command tripwire", () => {
  it("reports a catastrophic command without consulting a judge", async () => {
    const projectDir = await project();
    let judged = 0;
    const tripwire = createWorkerCommandTripwire({
      projectDir,
      voice: { push: () => undefined },
      denyRules: () => ["Bash(sudo *)"],
      recentUserRequests: () => [],
      approvalJudge: () => new ApprovalJudge(async () => {
        judged += 1;
        return "APPROVE";
      }),
    });

    expect(await tripwire({ spec, command: "rm -rf /" })).toMatchObject({ allow: false });
    expect(await tripwire({ spec, command: "sudo shutdown" })).toMatchObject({ allow: false });
    expect(await tripwire({ spec, command: "npm test" })).toEqual({ allow: true });
    // Detection after the fact: an opinion from a model would arrive too late
    // to matter and would only slow the block down.
    expect(judged).toBe(0);
  });
});

describe("the hard floor on every call", () => {
  it("blocks a catastrophic command with no model round-trip at all", async () => {
    const projectDir = await project();
    let judged = 0;
    const floor = createWorkerFloorReviewer({
      projectDir,
      voice: { push: () => undefined },
      denyRules: () => ["Read(./.env)"],
      recentUserRequests: () => [],
      approvalJudge: () => new ApprovalJudge(async () => {
        judged += 1;
        return "BLOCK everything";
      }),
    });

    expect(await floor({ spec, toolName: "Bash", input: { command: "rm -rf /" }, cwd: projectDir }))
      .toMatchObject({ allow: false });
    expect(await floor({ spec, toolName: "Read", input: { file_path: ".env" }, cwd: projectDir }))
      .toMatchObject({ allow: false });
    // This is the path claude reaches for calls it would auto-approve, so it
    // has to answer instantly and let ordinary work straight through.
    expect(await floor({ spec, toolName: "Bash", input: { command: "npm test" }, cwd: projectDir }))
      .toEqual({ allow: true });
    expect(await floor({ spec, toolName: "Write", input: { file_path: `${projectDir}/x.ts` }, cwd: projectDir }))
      .toEqual({ allow: true });
    expect(judged).toBe(0);
  });
});
