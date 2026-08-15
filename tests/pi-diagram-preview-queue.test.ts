import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiagramPreviewQueue } from "../src/main/pi/diagram-preview-queue";

function target() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    previewDiagram(params: Record<string, unknown>) {
      calls.push(params);
      return true;
    },
  };
}

function diagram(...labels: string[]) {
  return { nodes: labels.map((label, index) => ({ id: `n${index}`, label })), edges: [] };
}

describe("DiagramPreviewQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits out the debounce before painting", () => {
    const canvas = target();
    new DiagramPreviewQueue(canvas).queue(diagram("A"), false);
    expect(canvas.calls).toHaveLength(0);
    vi.advanceTimersByTime(90);
    expect(canvas.calls).toHaveLength(1);
  });

  it("coalesces a burst of deltas into one paint carrying the newest value", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue(diagram("A"), false);
    vi.advanceTimersByTime(40);
    queue.queue(diagram("A", "B"), false);
    vi.advanceTimersByTime(40);
    queue.queue(diagram("A", "B", "C"), false);
    expect(canvas.calls).toHaveLength(0);
    vi.advanceTimersByTime(10);
    expect(canvas.calls).toHaveLength(1);
    expect(canvas.calls[0].nodes).toHaveLength(3);
  });

  it("honours a custom debounce window", () => {
    const canvas = target();
    new DiagramPreviewQueue(canvas, 500).queue(diagram("A"), false);
    vi.advanceTimersByTime(499);
    expect(canvas.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(canvas.calls).toHaveLength(1);
  });

  it("drops a delta that reduces to the same stable preview", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue(diagram("A"), false);
    vi.advanceTimersByTime(90);
    queue.queue(diagram("A"), false);
    vi.advanceTimersByTime(90);
    expect(canvas.calls).toHaveLength(1);
  });

  it("ignores arguments with no renderable prefix", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue({ nodes: [] }, false);
    queue.queue("still streaming", true);
    vi.advanceTimersByTime(90);
    expect(canvas.calls).toHaveLength(0);
  });

  it("flushes immediately and cancels the pending timer", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue(diagram("A"), false);
    queue.queue(diagram("A", "B"), true);
    expect(canvas.calls).toHaveLength(1);
    expect(canvas.calls[0].nodes).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(canvas.calls).toHaveLength(1);
  });

  it("cancels a pending paint on reset", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue(diagram("A"), false);
    queue.reset();
    vi.advanceTimersByTime(1_000);
    expect(canvas.calls).toHaveLength(0);
  });

  it("forgets the dedupe signature on reset so the next diagram repaints", () => {
    const canvas = target();
    const queue = new DiagramPreviewQueue(canvas);
    queue.queue(diagram("A"), true);
    queue.reset();
    queue.queue(diagram("A"), true);
    expect(canvas.calls).toHaveLength(2);
  });
});
