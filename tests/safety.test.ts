import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatastrophicCommandGuard, ReadBeforeEditGuard } from "../src/main/safety";

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
