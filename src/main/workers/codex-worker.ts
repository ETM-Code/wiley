/**
 * The Codex worker: one process per turn, resumed by thread id.
 *
 * Codex has no permission callback and no way to feed a second turn into a
 * running process, so a steer means interrupting the current process and
 * resuming the same thread with the correction. The thread survives an
 * interrupt, which is what makes that safe.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { WileySettings, WorkerSettings } from "../settings/settings-schema";
import { resolveWorkerCommand, workerEnv } from "./cli-detect";
import { CodexStreamParser } from "./codex-protocol";
import type { WorkerEventDraft, WorkerExit, WorkerSpec, WorkerTransport } from "./worker-types";

export interface CodexArgsInput {
  spec: WorkerSpec;
  worker: WorkerSettings;
  /** Set once the first turn announced one; its presence selects resume. */
  threadId?: string;
}

/**
 * `codex exec resume` rejects -C and -s outright, so the working directory
 * moves to the spawn call and the sandbox comes back as a config override.
 * The prompt always arrives on stdin: it carries the whole transcript, which
 * would be a gamble against the argument-length limit.
 */
export function codexArgs(input: CodexArgsInput): string[] {
  const { spec, worker, threadId } = input;
  const sandbox = worker.sandbox ?? "workspace-write";
  const model = spec.model ?? worker.model;
  const effort = spec.effort ?? worker.effort;
  const args = threadId
    ? ["exec", "resume", threadId, "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`]
    : ["exec", "--json", "--skip-git-repo-check", "-s", sandbox];
  if (threadId) {
    // --add-dir does not exist on resume. Codex ignores an override it does
    // not recognize, so this mirrors the first turn's extra directories where
    // it lands and costs nothing where it does not.
    if (worker.extraDirs.length) {
      args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(worker.extraDirs)}`);
    }
  } else {
    for (const dir of worker.extraDirs) args.push("--add-dir", dir);
  }
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push("-");
  return args;
}

export interface CodexWorkerDeps {
  projectDir: string;
  settings: () => WileySettings;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected so tests can assemble a command without ever running one. */
  spawnProcess?: typeof spawn;
}

/** Splits a stream into whole lines, holding a partial tail across chunks. */
class LineSplitter {
  #buffer = "";

  push(chunk: string, onLine: (line: string) => void): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  flush(onLine: (line: string) => void): void {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    if (rest) onLine(rest);
  }
}

class CodexWorker implements WorkerTransport {
  readonly #parser = new CodexStreamParser();
  #child?: ChildProcessWithoutNullStreams;
  #events?: (event: WorkerEventDraft) => void;
  #exit?: (exit: WorkerExit) => void;
  #raw?: (line: string) => void;
  #disposed = false;
  #turnRunning = false;
  /** SIGINT means "end this turn"; SIGTERM and SIGKILL mean "end the worker". */
  #terminating = false;

  constructor(private readonly spec: WorkerSpec, private readonly deps: CodexWorkerDeps) {}

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get externalSessionId(): string | undefined {
    return this.#parser.threadId;
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
    this.#runTurn(spec.prompt ?? spec.task);
  }

  async send(text: string): Promise<void> {
    if (this.#turnRunning) {
      // Codex cannot take a second prompt mid-turn. Interrupting keeps the
      // thread, so the correction lands as the next turn on the same work.
      await this.interrupt();
    }
    this.#runTurn(text);
  }

  #runTurn(prompt: string): void {
    if (this.#disposed) return;
    const settings = this.deps.settings();
    const worker = settings.workers.codex;
    const env = this.deps.env ?? process.env;
    const home = this.deps.home ?? env.HOME ?? "";
    const command = resolveWorkerCommand("codex", worker);
    const args = codexArgs({ spec: this.spec, worker, threadId: this.#parser.threadId });
    const child = (this.deps.spawnProcess ?? spawn)(command, args, {
      cwd: this.deps.projectDir,
      env: workerEnv(env, home),
      // Detached so a signal to the negated pid reaches every command the
      // worker itself started, rather than orphaning its subprocesses.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    this.#turnRunning = true;
    this.#parser.beginTurn();

    const stdout = new LineSplitter();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk, (line) => this.#line(line));
    });
    // Codex logs startup noise and any broken user skill to stderr on every
    // single run, so stderr is recorded and never treated as a health signal.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.#raw?.(`[stderr] ${String(chunk).trimEnd()}`));
    child.on("error", (error) => {
      this.#turnRunning = false;
      this.#exit?.({ code: null, signal: null, error: String(error) });
    });
    child.on("close", (code, signal) => {
      stdout.flush((line) => this.#line(line));
      this.#turnRunning = false;
      this.#onTurnEnd(code, signal);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  }

  #line(line: string): void {
    this.#raw?.(line);
    for (const draft of this.#parser.parse(line)) this.#events?.(draft);
  }

  /**
   * A turn ending is not the worker ending: the thread is still resumable, so
   * the transport stays usable and only reports an exit when the process died
   * for a reason a resume cannot fix.
   */
  #onTurnEnd(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#disposed) return;
    if (this.#terminating) {
      // Shutdown, not a turn boundary: report at once so nothing waits out a
      // kill grace period for a process that has already gone.
      this.#exit?.({ code, signal });
      return;
    }
    if (this.#parser.exitedWithoutCompletion()) {
      this.#parser.markAborted();
      this.#events?.({
        type: "interrupted",
        payload: { reason: "codex exited before finishing the turn", code, signal, resumable: true },
      });
      return;
    }
    if (code !== 0 && this.#parser.terminal !== "completed") {
      this.#exit?.({ code, signal, error: `codex exited with code ${String(code)}` });
    }
  }

  async interrupt(): Promise<void> {
    // SIGINT is what codex treats as "stop this turn"; the stream simply ends
    // and the thread stays resumable.
    this.signal("SIGINT");
    await new Promise<void>((resolve) => {
      if (!this.#turnRunning) {
        resolve();
        return;
      }
      const child = this.#child;
      const done = () => resolve();
      child?.once("close", done);
      setTimeout(done, 3_000).unref?.();
    });
  }

  signal(signal: NodeJS.Signals): void {
    if (signal !== "SIGINT") this.#terminating = true;
    const pid = this.#child?.pid;
    if (!pid) {
      if (this.#terminating) this.#exit?.({ code: null, signal });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone, which is the outcome the caller wanted.
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.signal("SIGKILL");
    this.#child = undefined;
  }
}

export function createCodexWorkerFactory(deps: CodexWorkerDeps): (spec: WorkerSpec) => WorkerTransport {
  return (spec) => new CodexWorker(spec, deps);
}
