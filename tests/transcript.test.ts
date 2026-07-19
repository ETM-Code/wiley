import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlRuntimeLedger } from "../src/main/ledger";
import { TranscriptStore } from "../src/main/transcript";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<TranscriptStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "board-ai-transcript-"));
  cleanup.push(directory);
  const ledger = new JsonlRuntimeLedger(path.join(directory, "ledger.jsonl"));
  await ledger.initialize();
  return new TranscriptStore(ledger);
}

describe("transcript session baseline", () => {
  it("hides everything before beginSession from agents while keeping the ledger durable", async () => {
    const store = await makeStore();
    await store.append("user", "old request from the previous session");
    await store.append("assistant", "old answer");
    expect(store.takeDelta().length).toBe(2);

    store.beginSession();
    expect(store.all()).toEqual([]);
    expect(store.contextForNewAgent()).toEqual([]);
    expect(store.prepareDelta().entries).toEqual([]);
    expect(store.after(0)).toEqual([]);

    const fresh = await store.append("user", "brand new request");
    expect(store.all().map((entry) => entry.text)).toEqual(["brand new request"]);
    expect(store.takeDelta().map((entry) => entry.text)).toEqual(["brand new request"]);
    expect(store.after(0)).toHaveLength(1);
    expect(store.after(fresh.sequence)).toEqual([]);
  });
});
