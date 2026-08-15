import { stableDiagramPreview } from "../diagram-preview";

/** The slice of the canvas bridge a preview queue is allowed to touch. */
export interface DiagramPreviewTarget {
  previewDiagram(params: Record<string, unknown>): boolean;
}

/**
 * Debounces the diagram previews reconstructed from streaming tool-call
 * deltas. Identical successive previews are dropped so a delta that only
 * changed unparsed trailing text never repaints the board, and the final
 * toolcall_end flushes immediately rather than waiting out the timer.
 */
export class DiagramPreviewQueue {
  #timer?: NodeJS.Timeout;
  #pending?: Record<string, unknown>;
  #lastSignature = "";

  constructor(
    private readonly canvas: DiagramPreviewTarget,
    private readonly debounceMs = 90,
  ) {}

  queue(value: unknown, immediate: boolean): void {
    const preview = stableDiagramPreview(value);
    if (!preview) return;
    const signature = JSON.stringify(preview);
    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;
    this.#pending = preview;
    if (immediate) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#flush();
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, this.debounceMs);
  }

  reset(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
    this.#lastSignature = "";
  }

  #flush(): void {
    const preview = this.#pending;
    this.#pending = undefined;
    if (preview) this.canvas.previewDiagram(preview);
  }
}
