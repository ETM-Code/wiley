import type { RuntimeLedger } from "./ledger";
import type { TranscriptEntry, TranscriptRole } from "./contracts";

export const MAX_TRANSCRIPT_CHARS = 750_000;

export class TranscriptStore {
  #deliveryCursor = 0;
  #sessionBaseline = 0;

  constructor(private readonly ledger: RuntimeLedger) {}

  append(role: TranscriptRole, text: string): Promise<TranscriptEntry> {
    const normalized = text.trim();
    if (!normalized) return Promise.reject(new Error("Transcript text cannot be empty"));
    return this.ledger.appendTranscript({ role, text: normalized });
  }

  /**
   * Starts a fresh session: everything before the baseline stays in the
   * durable ledger but is never delivered to agents again.
   */
  beginSession(): void {
    const last = this.ledger.getTranscript().at(-1)?.sequence ?? 0;
    this.#sessionBaseline = last;
    this.#deliveryCursor = Math.max(this.#deliveryCursor, last);
  }

  all(): TranscriptEntry[] {
    return this.ledger.getTranscript(this.#sessionBaseline);
  }

  /** Cursor read that can never reach back past the session baseline. */
  after(sequence: number): TranscriptEntry[] {
    return this.ledger.getTranscript(Math.max(sequence, this.#sessionBaseline));
  }

  /** Returns each entry at most once to the persistent main Pi session. */
  takeDelta(maxChars = MAX_TRANSCRIPT_CHARS): TranscriptEntry[] {
    const prepared = this.prepareDelta(maxChars);
    this.commitDelivered(prepared.cursor);
    return prepared.entries;
  }

  prepareDelta(maxChars = MAX_TRANSCRIPT_CHARS): { entries: TranscriptEntry[]; cursor: number } {
    let entries = this.ledger.getTranscript(this.#deliveryCursor);
    const cursor = entries.at(-1)?.sequence ?? this.#deliveryCursor;
    while (entries.length > 1 && JSON.stringify(entries).length > maxChars) {
      entries = entries.slice(Math.ceil(entries.length / 10));
    }
    return { entries, cursor };
  }

  commitDelivered(cursor: number): void {
    this.#deliveryCursor = Math.max(this.#deliveryCursor, cursor);
  }

  /** New subagents receive the entire ledger, trimmed only to fit one prompt. */
  contextForNewAgent(maxChars = MAX_TRANSCRIPT_CHARS): TranscriptEntry[] {
    let entries = this.all();
    while (entries.length > 1 && JSON.stringify(entries).length > maxChars) {
      entries = entries.slice(Math.ceil(entries.length / 10));
    }
    return entries;
  }
}
