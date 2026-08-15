export function shouldStreamCanvas(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

export function pauseForStreaming(milliseconds: number): Promise<void> {
  if (!shouldStreamCanvas()) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(() => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    resolve();
  }, milliseconds));
}

export function reportCanvasStreamProgress(visibleElements: number, totalElements: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.wileyCanvasStream = `${visibleElements}/${totalElements}`;
  const entry = `${Math.round(performance.now())}:${visibleElements}/${totalElements}`;
  const previous = visibleElements === 0
    ? []
    : (document.documentElement.dataset.wileyCanvasStreamTrace ?? "").split("|").filter(Boolean);
  document.documentElement.dataset.wileyCanvasStreamTrace = [...previous, entry].slice(-128).join("|");
  document.dispatchEvent(new CustomEvent("wiley:canvas-stream-progress", {
    detail: { visibleElements, totalElements },
  }));
}
