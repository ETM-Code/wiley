import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ClaudeStreamParser, claudeUsage } from "../src/main/workers/claude-protocol";
import { CodexStreamParser, codexUsage } from "../src/main/workers/codex-protocol";
import { WORKER_MILESTONE, type WorkerEventDraft } from "../src/main/workers/worker-types";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "worker-streams",
);

function lines(name: string): string[] {
  return readFileSync(path.join(fixtureDir, name), "utf8").split("\n").filter((line) => line.trim());
}

function runClaude(name: string): { parser: ClaudeStreamParser; events: WorkerEventDraft[] } {
  const parser = new ClaudeStreamParser();
  const events = lines(name).flatMap((line) => parser.parse(line));
  return { parser, events };
}

function runCodex(name: string): { parser: CodexStreamParser; events: WorkerEventDraft[] } {
  const parser = new CodexStreamParser();
  const events = lines(name).flatMap((line) => parser.parse(line));
  return { parser, events };
}

function types(events: WorkerEventDraft[]): string[] {
  return events.map((event) => event.type);
}

function payloads<T>(events: WorkerEventDraft[], type: string): T[] {
  return events.filter((event) => event.type === type).map((event) => event.payload as T);
}

describe("claude stream parser", () => {
  it("turns a one-turn run into ready, message, and completed with usage", () => {
    const { parser, events } = runClaude("claude-basic.jsonl");

    expect(types(events)).toEqual(["milestone", "assistant_message", "completed"]);
    expect(parser.sessionId).toBe("96c2ec87-de29-4562-8e8c-42bfe67a1850");
    expect(parser.terminal).toBe("success");
    expect(parser.report).toBe("ok");
    expect(parser.usage).toMatchObject({ costUsd: 0.76978, turns: 1 });

    const ready = payloads<{ kind: string; externalSessionId?: string }>(events, "milestone")[0];
    expect(ready.kind).toBe(WORKER_MILESTONE.ready);
    expect(ready.externalSessionId).toBe("96c2ec87-de29-4562-8e8c-42bfe67a1850");
  });

  it("ignores thinking-token, hook, and rate-limit noise entirely", () => {
    const raw = lines("claude-permission.jsonl");
    const noisy = raw.filter((line) => {
      const value = JSON.parse(line) as { type?: string; subtype?: string };
      return value.type === "rate_limit_event"
        || (value.type === "system" && value.subtype !== "init" && value.subtype !== "permission_denied");
    });
    expect(noisy.length).toBeGreaterThan(15);

    const parser = new ClaudeStreamParser();
    expect(noisy.flatMap((line) => parser.parse(line))).toEqual([]);
  });

  it("names a tool result from the tool_use that opened it", () => {
    const { events } = runClaude("claude-tools.jsonl");
    const started = payloads<{ toolName: string; toolUseId?: string }>(events, "tool_started");
    const completed = payloads<{ toolName: string; toolUseId?: string }>(events, "tool_completed");

    expect(started.map((entry) => entry.toolName)).toContain("Write");
    expect(completed).not.toHaveLength(0);
    for (const entry of completed) {
      expect(entry.toolName).not.toBe("tool");
      expect(started.some((open) => open.toolUseId === entry.toolUseId)).toBe(true);
    }
  });

  it("carries a multi-turn process through two completions on one parser", () => {
    const { parser, events } = runClaude("claude-tools.jsonl");
    expect(payloads(events, "completed")).toHaveLength(2);
    expect(parser.report).toBe("Done. `proof.txt` now contains `OK` followed by `DONE`.");
  });

  it("reads the interrupt signature as interrupted, not as a crash", () => {
    const { parser, events } = runClaude("claude-interrupt.jsonl");
    const interrupted = payloads<{ reason: string; subtype: string }>(events, "interrupted");

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      reason: "aborted_streaming",
      subtype: "error_during_execution",
    });
    expect(types(events)).not.toContain("error");
    // The same process took another turn afterwards and finished it.
    expect(parser.terminal).toBe("success");
    expect(parser.report).toBe("recovered");
  });

  it("surfaces permission denials as an error even though the turn succeeded", () => {
    const { parser, events } = runClaude("claude-permission.jsonl");
    const errors = payloads<{
      error: string;
      denied?: boolean;
      toolName?: string;
      deniedTools?: string[];
    }>(events, "error");

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ denied: true, toolName: "Write" });
    expect(errors[1].deniedTools).toEqual(["Write"]);
    expect(parser.terminal).toBe("success");

    const completed = payloads<{ deniedCount: number }>(events, "completed")[0];
    expect(completed.deniedCount).toBe(1);
  });

  it("counts a malformed line instead of throwing", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parse("{not json");

    expect(parser.malformedLines).toBe(1);
    expect(events[0]).toMatchObject({
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.parseErrors, count: 1 },
    });
    expect(parser.parse("")).toEqual([]);
  });

  it("labels an unrecognized top-level event without dropping it", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parse(JSON.stringify({ type: "something_new_in_2_2" }));
    expect(events).toEqual([
      { type: "milestone", payload: { kind: WORKER_MILESTONE.unknownEvent, event: "something_new_in_2_2" } },
    ]);
  });

  it("extracts usage from a result even with no cost or turn counts", () => {
    expect(claudeUsage({ usage: { input_tokens: 5, output_tokens: 7 } })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(claudeUsage({})).toBeUndefined();
  });
});

describe("codex stream parser", () => {
  it("captures the thread id from line one and completes with usage", () => {
    const { parser, events } = runCodex("codex-basic.jsonl");

    expect(parser.threadId).toBe("01a00718-e2ce-7b22-8135-6148faf87587");
    expect(types(events)).toEqual(["milestone", "milestone", "assistant_message", "completed"]);
    expect(parser.terminal).toBe("completed");
    expect(parser.usage?.inputTokens).toBeGreaterThan(0);
  });

  it("maps file changes and commands onto tool and diff events", () => {
    const { parser, events } = runCodex("codex-tools.jsonl");

    const started = payloads<{ toolName: string; input: { command?: string } }>(events, "tool_started");
    expect(started.map((entry) => entry.toolName)).toEqual(["file_change", "bash"]);
    expect(started[1].input.command).toContain("od -An");

    const diffs = payloads<{ changes: Array<{ path: string; kind: string }>; status: string }>(events, "file_diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].status).toBe("completed");
    expect(diffs[0].changes[0].kind).toBe("add");

    const done = payloads<{ isError: boolean; result: { exitCode: number } }>(events, "tool_completed");
    expect(done[0].isError).toBe(false);
    expect(done[0].result.exitCode).toBe(0);
    expect(parser.report).toContain("Created");
  });

  it("treats a stream that stops before turn.completed as aborted", () => {
    const { parser, events } = runCodex("codex-sigint.jsonl");

    expect(types(events)).not.toContain("completed");
    expect(parser.exitedWithoutCompletion()).toBe(true);
    parser.markAborted();
    expect(parser.terminal).toBe("aborted");
  });

  it("resumes the same thread id after an abort", () => {
    const aborted = runCodex("codex-sigint.jsonl");
    const resumed = runCodex("codex-sigint-resume.jsonl");

    expect(resumed.parser.threadId).toBe(aborted.parser.threadId);
    expect(resumed.parser.terminal).toBe("completed");
    expect(resumed.parser.report).toBe("resumed");
  });

  it("keeps a completed turn from an earlier run from leaking into the next", () => {
    const parser = new CodexStreamParser();
    parser.parse(JSON.stringify({ type: "turn.completed", usage: {} }));
    expect(parser.exitedWithoutCompletion()).toBe(false);

    parser.beginTurn();
    expect(parser.exitedWithoutCompletion()).toBe(true);
    expect(parser.report).toBeUndefined();
  });

  it("labels an item type a future codex release might add", () => {
    const parser = new CodexStreamParser();
    const events = parser.parse(JSON.stringify({
      type: "item.completed",
      item: { id: "item_9", type: "web_search", status: "completed" },
    }));

    expect(events).toEqual([{
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.unknownEvent, event: "item/web_search", status: "completed" },
    }]);
  });

  it("counts a malformed line instead of throwing", () => {
    const parser = new CodexStreamParser();
    expect(parser.parse("Reading additional input from stdin...")[0]).toMatchObject({
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.parseErrors },
    });
    expect(parser.malformedLines).toBe(1);
  });

  it("reads usage only when the shape actually carries numbers", () => {
    expect(codexUsage({ input_tokens: 3, cached_input_tokens: 1 })).toEqual({
      inputTokens: 3,
      cachedInputTokens: 1,
    });
    expect(codexUsage(undefined)).toBeUndefined();
    expect(codexUsage({})).toBeUndefined();
  });
});
