/**
 * Claude Code's stream-json vocabulary, translated into our agent events.
 *
 * Pure by design: no spawning, no redaction, no clocks. It takes whatever the
 * CLI (or the agent SDK, which emits the same objects) hands over and returns
 * event drafts plus the few facts the manager needs to carry, so it can be
 * tested against committed transcripts of real runs.
 */

import type { WorkerEventDraft, WorkerUsage } from "./worker-types";
import { WORKER_MILESTONE } from "./worker-types";

/** How a turn ended, as far as the stream is concerned. */
export type ClaudeTerminalState = "success" | "aborted" | "error";

/** Terminal reasons the CLI reports when our own interrupt landed. */
const ABORT_REASONS = new Set(["aborted_streaming", "aborted", "interrupted"]);

/** High-frequency or purely internal traffic that would only spam the ledger. */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  "thinking_tokens",
  "hook_started",
  "hook_progress",
  "hook_response",
]);

const IGNORED_TYPES = new Set([
  "rate_limit_event",
  "control_request",
  "control_response",
  "stream_event",
]);

interface ResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function claudeUsage(result: Record<string, unknown>): WorkerUsage | undefined {
  const usage = record(result.usage) as ResultUsage | undefined;
  const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
  const turns = typeof result.num_turns === "number" ? result.num_turns : undefined;
  if (!usage && cost === undefined && turns === undefined) return undefined;
  const value: WorkerUsage = {};
  if (usage?.input_tokens !== undefined) value.inputTokens = usage.input_tokens;
  if (usage?.output_tokens !== undefined) value.outputTokens = usage.output_tokens;
  if (usage?.cache_read_input_tokens !== undefined) value.cachedInputTokens = usage.cache_read_input_tokens;
  if (cost !== undefined) value.costUsd = cost;
  if (turns !== undefined) value.turns = turns;
  return value;
}

export class ClaudeStreamParser {
  /** tool_use id to tool name, so a later tool_result can name its tool. */
  readonly #toolNames = new Map<string, string>();
  #sessionId?: string;
  #model?: string;
  #report?: string;
  #usage?: WorkerUsage;
  #terminal?: ClaudeTerminalState;
  #malformedLines = 0;

  /** The CLI session id, available from the first system/init of every turn. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get model(): string | undefined {
    return this.#model;
  }

  /** The last turn's final text, which is the worker's report. */
  get report(): string | undefined {
    return this.#report;
  }

  get usage(): WorkerUsage | undefined {
    return this.#usage;
  }

  get terminal(): ClaudeTerminalState | undefined {
    return this.#terminal;
  }

  get malformedLines(): number {
    return this.#malformedLines;
  }

  /** A new turn on the same process: the previous turn's verdict is stale. */
  beginTurn(): void {
    this.#terminal = undefined;
  }

  parse(line: string): WorkerEventDraft[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.#malformedLines += 1;
      return [{
        type: "milestone",
        payload: { kind: WORKER_MILESTONE.parseErrors, count: this.#malformedLines },
      }];
    }
    return this.handle(value);
  }

  /** The SDK hands over parsed messages, so the object path is the real one. */
  handle(value: unknown): WorkerEventDraft[] {
    const message = record(value);
    if (!message) return [];
    const type = text(message.type);
    if (!type || IGNORED_TYPES.has(type)) return [];
    switch (type) {
      case "system":
        return this.#system(message);
      case "assistant":
        return this.#assistant(message);
      case "user":
        return this.#user(message);
      case "result":
        return this.#result(message);
      default:
        return [{
          type: "milestone",
          payload: { kind: WORKER_MILESTONE.unknownEvent, event: type },
        }];
    }
  }

  #system(message: Record<string, unknown>): WorkerEventDraft[] {
    const subtype = text(message.subtype);
    if (!subtype || IGNORED_SYSTEM_SUBTYPES.has(subtype)) return [];
    if (subtype === "init") {
      this.#sessionId = text(message.session_id) ?? this.#sessionId;
      this.#model = text(message.model) ?? this.#model;
      return [{
        type: "milestone",
        payload: {
          kind: WORKER_MILESTONE.ready,
          externalSessionId: this.#sessionId,
          model: this.#model,
          toolCount: Array.isArray(message.tools) ? message.tools.length : undefined,
        },
      }];
    }
    if (subtype === "permission_denied") {
      return [{
        type: "error",
        payload: {
          error: text(message.message) ?? "A tool call was denied.",
          toolName: text(message.tool_name),
          toolUseId: text(message.tool_use_id),
          denied: true,
        },
      }];
    }
    return [{
      type: "milestone",
      payload: { kind: WORKER_MILESTONE.unknownEvent, event: `system/${subtype}` },
    }];
  }

  #assistant(message: Record<string, unknown>): WorkerEventDraft[] {
    const inner = record(message.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    const drafts: WorkerEventDraft[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (!block) continue;
      const kind = text(block.type);
      if (kind === "text") {
        const value = text(block.text)?.trim();
        // A thinking block is the model talking to itself; the ledger only
        // carries what the worker actually said.
        if (value) drafts.push({ type: "assistant_message", payload: { text: value } });
      } else if (kind === "tool_use") {
        const id = text(block.id);
        const name = text(block.name) ?? "tool";
        if (id) this.#toolNames.set(id, name);
        drafts.push({
          type: "tool_started",
          payload: { toolName: name, input: block.input, toolUseId: id },
        });
      }
    }
    return drafts;
  }

  #user(message: Record<string, unknown>): WorkerEventDraft[] {
    const inner = record(message.message);
    const content = Array.isArray(inner?.content) ? inner.content : [];
    const drafts: WorkerEventDraft[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (block && text(block.type) === "tool_result") {
        const id = text(block.tool_use_id);
        drafts.push({
          type: "tool_completed",
          payload: {
            toolName: (id && this.#toolNames.get(id)) ?? "tool",
            isError: block.is_error === true,
            result: block.content ?? message.tool_use_result,
            toolUseId: id,
          },
        });
      }
    }
    // A user message with only text is our own steering turn echoed back.
    return drafts;
  }

  #result(message: Record<string, unknown>): WorkerEventDraft[] {
    const subtype = text(message.subtype) ?? "unknown";
    const usage = claudeUsage(message);
    if (usage) this.#usage = usage;
    const terminalReason = text(message.terminal_reason);
    const drafts: WorkerEventDraft[] = [];
    const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
    if (denials.length > 0) {
      // A success subtype does not mean the work happened: a denied write
      // still ends the turn "successfully" with nothing written.
      drafts.push({
        type: "error",
        payload: {
          error: `${denials.length} tool call(s) were denied, so this work may be incomplete.`,
          deniedTools: denials.map((entry) => text(record(entry)?.tool_name) ?? "tool"),
          denied: true,
        },
      });
    }
    if (subtype === "success") {
      this.#terminal = "success";
      this.#report = text(message.result) ?? this.#report;
      drafts.push({
        type: "completed",
        payload: {
          report: this.#report ?? "",
          usage,
          costUsd: usage?.costUsd,
          numTurns: usage?.turns,
          deniedCount: denials.length,
        },
      });
      return drafts;
    }
    if (terminalReason && ABORT_REASONS.has(terminalReason)) {
      // The process survives this: it is the interrupt landing, not a crash.
      this.#terminal = "aborted";
      drafts.push({
        type: "interrupted",
        payload: { reason: terminalReason, subtype, numTurns: usage?.turns },
      });
      return drafts;
    }
    this.#terminal = "error";
    drafts.push({
      type: "error",
      payload: {
        error: text(message.result) ?? text(message.error) ?? `Worker turn ended: ${subtype}`,
        subtype,
        terminalReason,
      },
    });
    return drafts;
  }
}
