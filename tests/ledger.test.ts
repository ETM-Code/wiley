import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlRuntimeLedger, SqliteRuntimeLedger } from "../src/main/ledger";
import { TranscriptStore } from "../src/main/transcript";

const cleanup: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "board-ai-test-"));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable ledgers", () => {
  it("serializes concurrent JSONL transcript and event appends", async () => {
    const directory = await tempDir();
    const ledger = new JsonlRuntimeLedger(path.join(directory, "ledger.jsonl"));
    await ledger.initialize();

    await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.appendTranscript({
      role: "user",
      text: `message-${index}`,
    })));
    await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.appendAgentEvent({
      jobId: "job-1",
      agentId: `sub-${index % 4}`,
      type: "milestone",
      payload: { index },
    })));

    expect(ledger.getTranscript().map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(ledger.getAgentEvents().map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it("persists SQLite conversations, jobs, events, and idempotency keys", async () => {
    const directory = await tempDir();
    const file = path.join(directory, "runtime.sqlite");
    const ledger = new SqliteRuntimeLedger(file);
    await ledger.initialize();
    const transcript = await ledger.appendTranscript({ role: "user", text: "draw the login flow" });
    await ledger.appendAgentEvent({
      jobId: "job-1",
      agentId: "root",
      type: "milestone",
      payload: { text: "Inspecting the canvas" },
    });
    await ledger.putJob({
      id: "job-1",
      task: "Draw login flow",
      userWords: "draw the login flow",
      status: "running",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    await ledger.appendBoardTransaction({
      id: "tx-1",
      idempotencyKey: "same-change-once",
      agentId: "root",
      jobId: "job-1",
      baseRevision: 0,
      summary: "draw",
      operation: "add-elements",
      params: { elements: [] },
    });
    ledger.close();

    const reopened = new SqliteRuntimeLedger(file);
    await reopened.initialize();
    expect(reopened.getTranscript()).toEqual([transcript]);
    expect(reopened.getAgentEvents()).toHaveLength(1);
    expect(reopened.getJob("job-1")?.status).toBe("running");
    expect(reopened.hasBoardTransaction("same-change-once")).toBe(true);
    reopened.close();
  });
});

describe("conversation delivery", () => {
  it("does not lose a delta until prompt acceptance is committed", async () => {
    const directory = await tempDir();
    const ledger = new JsonlRuntimeLedger(path.join(directory, "ledger.jsonl"));
    await ledger.initialize();
    const store = new TranscriptStore(ledger);
    await store.append("user", "first");

    const firstAttempt = store.prepareDelta();
    expect(firstAttempt.entries.map((entry) => entry.text)).toEqual(["first"]);
    expect(store.prepareDelta().entries.map((entry) => entry.text)).toEqual(["first"]);

    store.commitDelivered(firstAttempt.cursor);
    expect(store.prepareDelta().entries).toEqual([]);
    await store.append("assistant", "working on it");
    expect(store.prepareDelta().entries.map((entry) => entry.text)).toEqual(["working on it"]);
    expect(store.contextForNewAgent().map((entry) => entry.text)).toEqual(["first", "working on it"]);
  });
});
