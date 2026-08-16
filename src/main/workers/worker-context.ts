/**
 * Each worker reads the voice conversation on a cursor of its own.
 *
 * The root session's delivery cursor is the one thing this must never move.
 * The root is a persistent session that sees each transcript entry exactly
 * once; a worker borrowing that cursor would make the root skip user turns it
 * has never been shown.
 */

import type { TranscriptEntry } from "../../shared/contracts";

export interface WorkerTranscriptSource {
  /** Entries after a sequence, never reaching past the session baseline. */
  after(sequence: number): TranscriptEntry[];
  /** The whole session so far, trimmed to fit one prompt. */
  contextForNewAgent(): TranscriptEntry[];
}

export class WorkerCursors {
  readonly #cursors = new Map<string, number>();

  /** A new worker gets the whole session and starts its cursor at the end. */
  open(workerId: string, transcript: WorkerTranscriptSource): TranscriptEntry[] {
    const entries = transcript.contextForNewAgent();
    this.#cursors.set(workerId, entries.at(-1)?.sequence ?? 0);
    return entries;
  }

  /** What this worker has not been shown yet, advancing only its own cursor. */
  delta(workerId: string, transcript: WorkerTranscriptSource): TranscriptEntry[] {
    const entries = transcript.after(this.#cursors.get(workerId) ?? 0);
    const last = entries.at(-1)?.sequence;
    if (last !== undefined) this.#cursors.set(workerId, last);
    return entries;
  }

  cursor(workerId: string): number | undefined {
    return this.#cursors.get(workerId);
  }

  close(workerId: string): void {
    this.#cursors.delete(workerId);
  }

  clear(): void {
    this.#cursors.clear();
  }
}
