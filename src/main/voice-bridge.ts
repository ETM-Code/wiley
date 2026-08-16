import type { VoiceInjection } from "../shared/contracts";

interface PendingAnswer {
  id: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
}

/** Below this a task is over before narrating it would be worth the interruption. */
const INSTANT_TASK_MS = 3_000;
/** How often narration may repeat once it has started. */
const PROGRESS_INTERVAL_MS = 10_000;

export class VoiceBridge {
  #pendingAnswers: PendingAnswer[] = [];
  #workStartedAt = 0;
  #lastProgressAt = 0;
  #boardUpdateTimer?: NodeJS.Timeout;
  #pendingBoardUpdate?: string;
  #progressTimer?: NodeJS.Timeout;

  constructor(private readonly send: (message: VoiceInjection) => void) {}

  /**
   * Keeps the realtime model passively aware of what the user draws.
   * Debounced and silent: the summary lands as conversation context without
   * triggering speech, so the model knows what "these two boxes" means.
   */
  pushBoardUpdate(summary: string, debounceMs = 4_000): void {
    this.#pendingBoardUpdate = summary;
    if (this.#boardUpdateTimer) return;
    this.#boardUpdateTimer = setTimeout(() => {
      this.#boardUpdateTimer = undefined;
      const text = this.#pendingBoardUpdate;
      this.#pendingBoardUpdate = undefined;
      if (!text) return;
      this.send({ id: crypto.randomUUID(), text: `[board update] ${text}`, interrupt: false, silent: true });
    }, debounceMs);
  }

  beginWork(): void {
    if (this.#workStartedAt === 0) this.#workStartedAt = Date.now();
  }

  endWork(): void {
    this.#workStartedAt = 0;
    this.#lastProgressAt = 0;
    // The task finished inside the instant window, so its opening line was
    // never worth speaking and is dropped here rather than trailing the work.
    this.#dropHeldProgress();
  }

  push(text: string, options: { interrupt?: boolean } = {}): void {
    const message: VoiceInjection = {
      id: crypto.randomUUID(),
      text,
      interrupt: options.interrupt ?? false,
    };
    if (text.startsWith("[agent progress]")) {
      // A coworker at a whiteboard narrates while working. Suppress only
      // instant tasks and rapid-fire repetition.
      const now = Date.now();
      if (this.#workStartedAt === 0) return;
      const elapsed = now - this.#workStartedAt;
      // The opening narration always lands inside the instant window, and it
      // is the line that tells the user work has begun. Hold it instead of
      // discarding it: an instant task ends first and stays silent, while a
      // long one still announces itself.
      if (elapsed < INSTANT_TASK_MS) {
        this.#holdProgress(message, INSTANT_TASK_MS - elapsed);
        return;
      }
      if (this.#lastProgressAt > 0 && now - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return;
      this.#lastProgressAt = now;
    }
    this.send(message);
  }

  /** Waits out the instant-task window, keeping only the latest line. */
  #holdProgress(message: VoiceInjection, delayMs: number): void {
    this.#dropHeldProgress();
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = undefined;
      if (this.#workStartedAt === 0) return;
      this.#lastProgressAt = Date.now();
      this.send(message);
    }, delayMs);
  }

  #dropHeldProgress(): void {
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
  }

  ask(question: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
    this.push(`[agent question] ${question}`, { interrupt: true });
    return new Promise((resolve) => {
      const finish = (answer: string) => {
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        const index = this.#pendingAnswers.indexOf(pending);
        if (index >= 0) this.#pendingAnswers.splice(index, 1);
        resolve(answer);
      };
      const onAbort = () => finish("Run aborted before the user answered.");
      const pending: PendingAnswer = {
        id: crypto.randomUUID(),
        resolve: finish,
        timer: setTimeout(() => finish("No answer after two minutes; use your best judgement."), timeoutMs),
        removeAbort: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pendingAnswers.push(pending);
    });
  }

  deliverAnswer(answer: string): boolean {
    const pending = this.#pendingAnswers[0];
    if (!pending) return false;
    pending.resolve(answer.trim() || "No answer was provided.");
    return true;
  }

  close(): void {
    if (this.#boardUpdateTimer) clearTimeout(this.#boardUpdateTimer);
    this.#boardUpdateTimer = undefined;
    this.#dropHeldProgress();
    while (this.#pendingAnswers.length) {
      this.#pendingAnswers[0]?.resolve("Application is closing.");
    }
  }
}
