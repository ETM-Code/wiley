import type { VoiceInjection } from "./contracts";

interface PendingAnswer {
  id: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
}

export class VoiceBridge {
  #pendingAnswers: PendingAnswer[] = [];
  #workStartedAt = 0;
  #lastProgressAt = 0;
  #boardUpdateTimer?: NodeJS.Timeout;
  #pendingBoardUpdate?: string;

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
  }

  push(text: string, options: { interrupt?: boolean } = {}): void {
    if (text.startsWith("[agent progress]")) {
      const now = Date.now();
      if (this.#workStartedAt === 0 || now - this.#workStartedAt < 8_000) return;
      if (this.#lastProgressAt > 0 && now - this.#lastProgressAt < 15_000) return;
      this.#lastProgressAt = now;
    }
    const message: VoiceInjection = {
      id: crypto.randomUUID(),
      text,
      interrupt: options.interrupt ?? false,
    };
    this.send(message);
  }

  ask(question: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
    this.push(`[agent question] ${question}`, { interrupt: true });
    return new Promise((resolve) => {
      const pending: PendingAnswer = {
        id: crypto.randomUUID(),
        resolve: () => undefined,
        timer: setTimeout(() => undefined, timeoutMs),
      };
      const finish = (answer: string) => {
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        const index = this.#pendingAnswers.indexOf(pending);
        if (index >= 0) this.#pendingAnswers.splice(index, 1);
        resolve(answer);
      };
      pending.resolve = finish;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(
        () => finish("No answer after two minutes; use your best judgement."),
        timeoutMs,
      );
      const onAbort = () => finish("Run aborted before the user answered.");
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.removeAbort = () => signal?.removeEventListener("abort", onAbort);
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
    while (this.#pendingAnswers.length) {
      this.#pendingAnswers[0]?.resolve("Application is closing.");
    }
  }
}
