import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXTERNAL_WORKER_BRIEF, WORKER_DELEGATION_RULES, BOARD_AGENT_SYSTEM_PROMPT } from "../src/main/agent-prompt";
import { SqliteRuntimeLedger } from "../src/main/ledger";
import { buildWorkerMessage } from "../src/main/pi/prompt-context";
import { DEFAULT_SETTINGS, type WileySettings } from "../src/main/settings/settings-schema";
import { TranscriptStore } from "../src/main/transcript";
import { WorkerCursors } from "../src/main/workers/worker-context";
import { assertWorkerSpawnAllowed, resolveWorkerModel } from "../src/main/workers/worker-spawn";
import type { WorkerProbes } from "../src/shared/contracts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(): Promise<TranscriptStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiley-worker-cursor-"));
  cleanup.push(directory);
  const ledger = new SqliteRuntimeLedger(path.join(directory, "runtime.sqlite"));
  await ledger.initialize();
  return new TranscriptStore(ledger);
}

function settingsWith(overrides: Partial<WileySettings["workers"]["claude"]>, kind: "claude" | "codex" = "claude"): WileySettings {
  return {
    ...DEFAULT_SETTINGS,
    agent: { ...DEFAULT_SETTINGS.agent, allowedModels: [...DEFAULT_SETTINGS.agent.allowedModels, "haiku"] },
    workers: {
      ...DEFAULT_SETTINGS.workers,
      [kind]: { ...DEFAULT_SETTINGS.workers[kind], ...overrides },
    },
  };
}

const AVAILABLE: WorkerProbes = {
  claude: { available: true, version: "2.1.233" },
  codex: { available: true, version: "0.147.0" },
};

describe("spawn gating", () => {
  it("refuses a kind the user has not switched on, and says where to switch it on", () => {
    expect(() => assertWorkerSpawnAllowed({ kind: "claude", settings: DEFAULT_SETTINGS, probes: AVAILABLE }))
      .toThrow(/switched off in Settings/);
  });

  it("refuses a kind this machine cannot run, quoting the probe's reason", () => {
    expect(() => assertWorkerSpawnAllowed({
      kind: "codex",
      settings: settingsWith({ enabled: true }, "codex"),
      probes: { ...AVAILABLE, codex: { available: false, reason: "codex is installed but not signed in." } },
    })).toThrow(/not signed in/);
  });

  it("takes an engine's own model name without consulting the agent allowlist", () => {
    expect(() => assertWorkerSpawnAllowed({
      kind: "claude",
      settings: settingsWith({ enabled: true }),
      probes: AVAILABLE,
      model: "opus",
    })).not.toThrow();
  });

  it("allows an enabled, available spawn", () => {
    expect(() => assertWorkerSpawnAllowed({
      kind: "claude",
      settings: settingsWith({ enabled: true }),
      probes: AVAILABLE,
    })).not.toThrow();
  });

  it("rejects a kind that is not an external engine at all", () => {
    expect(() => assertWorkerSpawnAllowed({ kind: "pi", settings: DEFAULT_SETTINGS })).toThrow(/Unknown worker kind/);
  });

  it("leaves both engines on the device's own default until a model is pinned", () => {
    expect(resolveWorkerModel("claude", DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveWorkerModel("codex", DEFAULT_SETTINGS)).toBeUndefined();
    expect(resolveWorkerModel("claude", settingsWith({ model: "sonnet" }))).toBe("sonnet");
    expect(resolveWorkerModel("claude", DEFAULT_SETTINGS, "opus")).toBe("opus");
  });
});

describe("per-worker transcript cursors", () => {
  it("never moves the root session's delivery cursor", async () => {
    const transcript = await store();
    await transcript.append("user", "draw the pipeline");
    await transcript.append("assistant", "on it");

    const cursors = new WorkerCursors();
    const opened = cursors.open("claude-1", transcript);
    expect(opened.map((entry) => entry.text)).toEqual(["draw the pipeline", "on it"]);

    // The root has still been delivered nothing, which is the whole point.
    const rootDelta = transcript.prepareDelta();
    expect(rootDelta.entries.map((entry) => entry.text)).toEqual(["draw the pipeline", "on it"]);
  });

  it("gives a worker only what it has not been shown, advancing its own cursor", async () => {
    const transcript = await store();
    await transcript.append("user", "draw the pipeline");
    const cursors = new WorkerCursors();
    cursors.open("claude-1", transcript);

    expect(cursors.delta("claude-1", transcript)).toEqual([]);

    await transcript.append("user", "actually make it vertical");
    expect(cursors.delta("claude-1", transcript).map((entry) => entry.text))
      .toEqual(["actually make it vertical"]);
    expect(cursors.delta("claude-1", transcript)).toEqual([]);
  });

  it("keeps two workers on independent cursors", async () => {
    const transcript = await store();
    await transcript.append("user", "first request");
    const cursors = new WorkerCursors();
    cursors.open("claude-1", transcript);
    await transcript.append("user", "second request");
    cursors.open("codex-1", transcript);
    await transcript.append("user", "third request");

    expect(cursors.delta("claude-1", transcript).map((entry) => entry.text))
      .toEqual(["second request", "third request"]);
    expect(cursors.delta("codex-1", transcript).map((entry) => entry.text)).toEqual(["third request"]);
  });

  it("forgets a worker's cursor when it is closed", async () => {
    const transcript = await store();
    await transcript.append("user", "hello");
    const cursors = new WorkerCursors();
    cursors.open("claude-1", transcript);

    expect(cursors.cursor("claude-1")).toBeGreaterThan(0);
    cursors.close("claude-1");
    expect(cursors.cursor("claude-1")).toBeUndefined();
    // A reopened id starts from the whole session again, not from nothing.
    expect(cursors.delta("claude-1", transcript).map((entry) => entry.text)).toEqual(["hello"]);
  });
});

describe("worker envelope", () => {
  it("carries the brief, the task, the conversation, and the peer events", () => {
    const message = buildWorkerMessage({
      brief: EXTERNAL_WORKER_BRIEF,
      task: "refactor the ledger",
      transcriptContext: [{ role: "user", text: "clean up the ledger" }],
      peerEvents: [{ type: "completed" }],
    });

    expect(message.startsWith(EXTERNAL_WORKER_BRIEF)).toBe(true);
    expect(message).toContain("<task>\nrefactor the ledger\n</task>");
    expect(message).toContain("clean up the ledger");
    expect(message).toContain("<peer_agent_events>");
  });

  it("tells an external worker it cannot draw and must report instead", () => {
    expect(EXTERNAL_WORKER_BRIEF).toContain("no access to the shared whiteboard");
    expect(EXTERNAL_WORKER_BRIEF).toContain("final\nmessage as your entire report");
    expect(EXTERNAL_WORKER_BRIEF).toContain("wind down");
  });
});

describe("delegation rules in the root prompt", () => {
  it("teaches the root when to delegate and who draws afterwards", () => {
    expect(BOARD_AGENT_SYSTEM_PROMPT).toContain(WORKER_DELEGATION_RULES.trim());
    expect(WORKER_DELEGATION_RULES).toContain("spawn_agent takes kind");
    expect(WORKER_DELEGATION_RULES).toContain("you\n  draw yourself from its report");
    expect(WORKER_DELEGATION_RULES).toContain("send_agent_message");
  });

  it("forbids naming the engines to the user", () => {
    expect(WORKER_DELEGATION_RULES).toContain("Never name the engines to the user");
    expect(WORKER_DELEGATION_RULES).toContain("They are your hands");
  });
});
