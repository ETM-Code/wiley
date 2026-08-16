/**
 * The Claude Code worker, driven through @anthropic-ai/claude-agent-sdk.
 *
 * The SDK drives the same installed CLI as a headless `claude -p`, but plain
 * headless mode never originates a permission request, so canUseTool is
 * unreachable there. Going through the SDK is what gives Wiley a real
 * before-the-fact say over every tool call the worker makes.
 *
 * One long-lived query per worker: steering is another user message on the
 * same stream, and an interrupt aborts the turn without ending the session.
 */

import {
  query,
  type HookJSONOutput,
  type Options,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { WileySettings, WorkerSettings } from "../settings/settings-schema";
import { ClaudeStreamParser } from "./claude-protocol";
import { workerEnv } from "./cli-detect";
import type { WorkerEventDraft, WorkerExit, WorkerSpec, WorkerTransport } from "./worker-types";

/**
 * An unpinned run inherits whatever model the installed CLI defaults to,
 * which measured 7 to 17 times the cost of a pinned cheap one. Workers do
 * delegated legwork, so the floor is deliberately the cheap fast model.
 */
export const DEFAULT_CLAUDE_WORKER_MODEL = "haiku";

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

/**
 * bypassPermissions would take our canUseTool out of the loop, which is the
 * one thing a worker must never do, so it is refused even if configured.
 */
export function claudePermissionMode(value: string | undefined): PermissionMode {
  if (value === "bypassPermissions") return "default";
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : "default";
}

const THINKING_TOKENS: Record<string, number> = { low: 4_000, medium: 10_000, high: 32_000 };

export function claudeThinkingTokens(effort: string | undefined): number | undefined {
  return effort ? THINKING_TOKENS[effort] : undefined;
}

export interface ClaudeOptionsInput {
  spec: WorkerSpec;
  worker: WorkerSettings;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The resolved binary from the probe, so the SDK drives the same one. */
  executable?: string;
}

/**
 * Everything about a query that is decided rather than executed, so the
 * assembly can be tested without an SDK, a process, or a network.
 */
export function claudeQueryOptions(input: ClaudeOptionsInput): Options {
  const { spec, worker, cwd, env, home } = input;
  const options: Options = {
    cwd,
    model: spec.model ?? worker.model ?? DEFAULT_CLAUDE_WORKER_MODEL,
    permissionMode: claudePermissionMode(worker.permissionMode),
    // The env REPLACES the child's environment wholesale, so the augmented
    // PATH has to be built on top of ours rather than instead of it.
    env: workerEnv(env, home) as Record<string, string>,
    includePartialMessages: false,
    // The user's own SessionStart hooks cost about two seconds per turn and
    // belong to their interactive sessions, not to Wiley's background work.
    settingSources: [],
  };
  if (input.executable) options.pathToClaudeCodeExecutable = input.executable;
  if (worker.allowedTools?.length) options.allowedTools = worker.allowedTools;
  if (worker.disallowedTools?.length) options.disallowedTools = worker.disallowedTools;
  if (worker.extraDirs.length) options.additionalDirectories = worker.extraDirs;
  const thinking = claudeThinkingTokens(spec.effort ?? worker.effort);
  if (thinking) options.maxThinkingTokens = thinking;
  return options;
}

export function claudeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

export interface ToolReview {
  allow: boolean;
  reason?: string;
}

export interface ToolReviewInput {
  spec: WorkerSpec;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  signal: AbortSignal;
}

export interface ClaudeWorkerDeps {
  projectDir: string;
  settings: () => WileySettings;
  /** The full review, wired into the SDK's canUseTool. */
  reviewTool: (input: ToolReviewInput) => Promise<ToolReview>;
  /**
   * The hard floor, wired into the PreToolUse hook. canUseTool is only
   * reached for calls the CLI would have prompted about, so this is the only
   * path that sees a command the engine considers safe on its own.
   */
  reviewFloor?: (input: ToolReviewInput) => Promise<ToolReview>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  executable?: string;
}

/** A queue that reads as an async iterable, which is the SDK's stream input. */
class MessageStream implements AsyncIterable<SDKUserMessage> {
  #queued: SDKUserMessage[] = [];
  #waiting?: (result: IteratorResult<SDKUserMessage>) => void;
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value: message, done: false });
      return;
    }
    this.#queued.push(message);
  }

  close(): void {
    this.#closed = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.#queued.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

class ClaudeWorker implements WorkerTransport {
  readonly #parser = new ClaudeStreamParser();
  readonly #stream = new MessageStream();
  #query?: Query;
  #events?: (event: WorkerEventDraft) => void;
  #exit?: (exit: WorkerExit) => void;
  #raw?: (line: string) => void;
  #finished = false;

  constructor(private readonly spec: WorkerSpec, private readonly deps: ClaudeWorkerDeps) {}

  /** The SDK owns the child process, so there is no pid of ours to record. */
  get pid(): number | undefined {
    return undefined;
  }

  get externalSessionId(): string | undefined {
    return this.#parser.sessionId;
  }

  onEvent(handler: (event: WorkerEventDraft) => void): void {
    this.#events = handler;
  }

  onExit(handler: (exit: WorkerExit) => void): void {
    this.#exit = handler;
  }

  onRaw(handler: (line: string) => void): void {
    this.#raw = handler;
  }

  async start(spec: WorkerSpec): Promise<void> {
    const settings = this.deps.settings();
    const options = claudeQueryOptions({
      spec,
      worker: settings.workers.claude,
      cwd: this.deps.projectDir,
      env: this.deps.env ?? process.env,
      home: this.deps.home ?? (this.deps.env ?? process.env).HOME ?? "",
      executable: this.deps.executable,
    });
    const bridge = settings.workers.claude.approvalBridge;
    this.#query = query({
      prompt: this.#stream,
      options: {
        ...options,
        // The floor is installed whatever the configured bridge is: it is the
        // guard against destroying things, not a review preference.
        hooks: { PreToolUse: [{ hooks: [(input, _toolUseId, { signal }) => this.#floor(input, signal)] }] },
        // "hook" and "none" both mean no model round-trip per tool call.
        canUseTool: bridge === "canUseTool" ? async (toolName, input, { signal }) => {
          const verdict = await this.deps.reviewTool({
            spec: this.spec,
            toolName,
            input,
            cwd: this.deps.projectDir,
            signal,
          });
          if (verdict.allow) return { behavior: "allow", updatedInput: input };
          return {
            behavior: "deny",
            message: `${verdict.reason ?? "Blocked by Wiley's safety reviewer."} `
              + "Do not retry this or work around the block.",
          };
        } : undefined,
        stderr: (data) => this.#raw?.(`[stderr] ${data.trimEnd()}`),
      },
    });
    this.#stream.push(claudeUserMessage(spec.prompt ?? spec.task));
    void this.#pump();
  }

  async #floor(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }, signal: AbortSignal): Promise<HookJSONOutput> {
    const review = this.deps.reviewFloor;
    if (!review || input.hook_event_name !== "PreToolUse" || !input.tool_name) return {};
    const verdict = await review({
      spec: this.spec,
      toolName: input.tool_name,
      input: (input.tool_input ?? {}) as Record<string, unknown>,
      cwd: this.deps.projectDir,
      signal,
    });
    if (verdict.allow) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${verdict.reason ?? "Blocked by Wiley."} Do not retry or work around this.`,
      },
    };
  }

  async #pump(): Promise<void> {
    const active = this.#query;
    if (!active) return;
    try {
      for await (const message of active) {
        this.#raw?.(JSON.stringify(message));
        for (const draft of this.#parser.handle(message)) this.#events?.(draft);
      }
      this.#report({ code: 0, signal: null });
    } catch (error) {
      this.#report({ code: null, signal: null, error: String(error) });
    }
  }

  #report(exit: WorkerExit): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#exit?.(exit);
  }

  async send(text: string): Promise<void> {
    // Same process, same session: a steer is simply the next user message.
    this.#parser.beginTurn();
    this.#stream.push(claudeUserMessage(text));
  }

  async interrupt(): Promise<void> {
    // The turn aborts in a couple of seconds and the process stays alive for
    // the next message, so this is never followed by a teardown.
    await this.#query?.interrupt();
  }

  signal(): void {
    // The SDK owns the child, so closing the query is the only way to end it.
    this.#query?.close();
    this.#report({ code: null, signal: "SIGTERM" });
  }

  dispose(): void {
    this.#stream.close();
    this.#query?.close();
    this.#query = undefined;
  }
}

export function createClaudeWorkerFactory(deps: ClaudeWorkerDeps): (spec: WorkerSpec) => WorkerTransport {
  return (spec) => new ClaudeWorker(spec, deps);
}
