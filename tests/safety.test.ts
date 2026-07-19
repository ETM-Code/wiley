import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_PROMPT,
  ApprovalJudge,
  CatastrophicCommandGuard,
  ReadBeforeEditGuard,
  isReadOnlyCommand,
} from "../src/main/safety";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("catastrophic command guard", () => {
  it("hard-blocks home, root, disk, credential, and fork-bomb destruction", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "board-ai-project-"));
    cleanup.push(project);
    const guard = new CatastrophicCommandGuard(project);

    expect(guard.inspect("rm -rf /").allow).toBe(false);
    expect(guard.inspect("rm -rf $HOME").allow).toBe(false);
    expect(guard.inspect("diskutil eraseDisk APFS Empty /dev/disk4").allow).toBe(false);
    expect(guard.inspect("security delete-keychain login.keychain-db").allow).toBe(false);
    expect(guard.inspect(":(){ :|:& };:").allow).toBe(false);
    expect(guard.inspect("rm -rf ./dist", project).allow).toBe(true);
  });
});

describe("read-before-edit guard", () => {
  it("allows new files and requires a successful read before existing-file edits", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "board-ai-read-"));
    cleanup.push(project);
    const existing = path.join(project, "existing.ts");
    const fresh = path.join(project, "new.ts");
    await writeFile(existing, "export const value = 1;\n");
    const guard = new ReadBeforeEditGuard();

    expect(guard.inspect(existing).allow).toBe(false);
    expect(guard.inspect(fresh).allow).toBe(true);
    guard.markRead(existing);
    expect(guard.inspect(existing).allow).toBe(true);
  });
});

describe("approval judge", () => {
  const call = {
    tool: "bash",
    input: { command: "git push --force origin main" },
    cwd: "/tmp/project",
    recentUserRequests: ["deploy the site"],
  };

  it("passes the full call context to the completion", async () => {
    let received = "";
    const judge = new ApprovalJudge(async ({ systemPrompt, userMessage }) => {
      expect(systemPrompt).toBe(APPROVAL_PROMPT);
      received = userMessage;
      return "APPROVE";
    });
    await judge.review(call);
    const parsed = JSON.parse(received) as typeof call;
    expect(parsed.tool).toBe("bash");
    expect(parsed.input.command).toContain("--force");
    expect(parsed.cwd).toBe("/tmp/project");
    expect(parsed.recentUserRequests).toEqual(["deploy the site"]);
  });

  it("allows on APPROVE and blocks with the reason on BLOCK", async () => {
    const approve = new ApprovalJudge(async () => "APPROVE");
    expect((await approve.review(call)).allow).toBe(true);

    const block = new ApprovalJudge(async () => "BLOCK force-push would rewrite shared history");
    const decision = await block.review(call);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("force-push would rewrite shared history");
  });

  it("fails open on malformed output and on judge errors", async () => {
    const malformed = new ApprovalJudge(async () => "hmm, unsure about this one");
    expect((await malformed.review(call)).allow).toBe(true);

    const broken = new ApprovalJudge(async () => {
      throw new Error("judge model unavailable");
    });
    expect((await broken.review(call)).allow).toBe(true);
  });

  it("supplies a fallback reason when BLOCK carries none", async () => {
    const judge = new ApprovalJudge(async () => "BLOCK");
    const decision = await judge.review(call);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("The safety reviewer blocked this action.");
  });
});

describe("read-only command prefilter", () => {
  it("skips the judge for plain reads and read-only pipelines", () => {
    expect(isReadOnlyCommand("ls -la src")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
    expect(isReadOnlyCommand("git log --oneline -5")).toBe(true);
    expect(isReadOnlyCommand("rg -n 'draw_diagram' src | head -20")).toBe(true);
    expect(isReadOnlyCommand("")).toBe(true);
  });

  it("keeps anything that can write, chain, or substitute under review", () => {
    expect(isReadOnlyCommand("rm -rf dist")).toBe(false);
    expect(isReadOnlyCommand("git push origin main")).toBe(false);
    expect(isReadOnlyCommand("cat a.txt > b.txt")).toBe(false);
    expect(isReadOnlyCommand("ls && rm x")).toBe(false);
    expect(isReadOnlyCommand("echo $(rm x)")).toBe(false);
    expect(isReadOnlyCommand("npm install left-pad")).toBe(false);
  });
});
