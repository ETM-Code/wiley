/**
 * Codex's `exec --json` vocabulary, translated into our agent events.
 *
 * Same contract as the Claude parser: pure, tolerant, and testable against
 * committed transcripts. Codex adds item types across releases, so anything
 * unrecognized becomes a milestone rather than a thrown error or a dropped line.
 */

import type { WorkerEventDraft, WorkerUsage } from "./worker-types";
import { WORKER_MILESTONE } from "./worker-types";

export type CodexTerminalState = "completed" | "aborted" | "error";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function codexUsage(raw: unknown): WorkerUsage | undefined {
  const usage = record(raw);
  if (!usage) return undefined;
  const value: WorkerUsage = {};
  if (typeof usage.input_tokens === "number") value.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") value.outputTokens = usage.output_tokens;
  if (typeof usage.cached_input_tokens === "number") value.cachedInputTokens = usage.cached_input_tokens;
  return Object.keys(value).length ? value : undefined;
}

export class CodexStreamParser {
  #threadId?: string;
  #report?: string;
  #usage?: WorkerUsage;
  #terminal?: CodexTerminalState;
  #malformedLines = 0;

  /** The resumable thread id, announced only on line 1 of every run. */
  get threadId(): string | undefined {
    return this.#threadId;
  }

  get report(): string | undefined {
    return this.#report;
  }

  get usage(): WorkerUsage | undefined {
    return this.#usage;
  }

  get terminal(): CodexTerminalState | undefined {
    return this.#terminal;
  }

  get malformedLines(): number {
    return this.#malformedLines;
  }

  /** Codex runs one process per turn, so a resume starts a fresh verdict. */
  beginTurn(): void {
    this.#terminal = undefined;
    this.#report = undefined;
  }

  /**
   * A process that exits before turn.completed was interrupted: the stream
   * simply stops, with no terminal event of its own. The thread stays
   * resumable, so this is a pause, not a loss.
   */
  exitedWithoutCompletion(): boolean {
    return this.#terminal !== "completed" && this.#terminal !== "error";
  }

  markAborted(): void {
    this.#terminal = "aborted";
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

  handle(value: unknown): WorkerEventDraft[] {
    const message = record(value);
    if (!message) return [];
    const type = text(message.type);
    switch (type) {
      case undefined:
        return [];
      case "thread.started":
        this.#threadId = text(message.thread_id) ?? this.#threadId;
        return [{
          type: "milestone",
          payload: { kind: WORKER_MILESTONE.ready, externalSessionId: this.#threadId },
        }];
      case "turn.started":
        return [{ type: "milestone", payload: { kind: WORKER_MILESTONE.turnStarted } }];
      case "turn.completed": {
        this.#terminal = "completed";
        this.#usage = codexUsage(message.usage) ?? this.#usage;
        return [{
          type: "completed",
          payload: { report: this.#report ?? "", usage: this.#usage },
        }];
      }
      case "turn.failed":
      case "error":
        this.#terminal = "error";
        return [{
          type: "error",
          payload: {
            error: text(message.message) ?? text(message.error) ?? "Codex reported a failure",
            fatal: true,
          },
        }];
      case "item.started":
      case "item.completed":
        return this.#item(message, type === "item.completed");
      default:
        return [{
          type: "milestone",
          payload: { kind: WORKER_MILESTONE.unknownEvent, event: type },
        }];
    }
  }

  #item(message: Record<string, unknown>, completed: boolean): WorkerEventDraft[] {
    const item = record(message.item);
    if (!item) return [];
    const itemType = text(item.type) ?? "unknown";
    const id = text(item.id);
    switch (itemType) {
      case "agent_message": {
        if (!completed) return [];
        const value = text(item.text)?.trim();
        if (!value) return [];
        this.#report = value;
        return [{ type: "assistant_message", payload: { text: value } }];
      }
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (!completed) {
          return [{
            type: "tool_started",
            payload: { toolName: "file_change", input: { changes }, toolUseId: id },
          }];
        }
        return [{
          type: "file_diff",
          payload: { changes, status: text(item.status), toolUseId: id },
        }];
      }
      case "command_execution": {
        const command = text(item.command) ?? "";
        if (!completed) {
          // The manager's tripwire reads this payload, so the command has to
          // arrive the moment codex starts it rather than once it has run.
          return [{
            type: "tool_started",
            payload: { toolName: "bash", input: { command }, toolUseId: id },
          }];
        }
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        return [{
          type: "tool_completed",
          payload: {
            toolName: "bash",
            isError: exitCode !== undefined && exitCode !== 0,
            result: { command, exitCode, output: item.aggregated_output },
            toolUseId: id,
          },
        }];
      }
      default:
        return [{
          type: "milestone",
          payload: {
            kind: WORKER_MILESTONE.unknownEvent,
            event: `item/${itemType}`,
            status: text(item.status),
          },
        }];
    }
  }
}
