import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { finiteNumber as finite } from "../diagram-layout";
import { asRecord } from "./geometry";

export const diagramPreviewElementIds = new Set<string>();

/**
 * Preview arbitration counters. Shared mutable state, because the renderer
 * that paints a preview and the handler that clears one live in separate
 * modules but must agree on which preview version is newest.
 */
export const diagramPreviewVersions = { latest: 0, lastNodeCount: 0 };

/**
 * The diagram id claimed by the preview currently streaming. Every
 * provisional frame and the final commit address the same elements, so the
 * board morphs in place instead of accumulating one throwaway copy per
 * JSON delta.
 */
export const diagramPreviewStream: { diagramId: string | null } = { diagramId: null };

export function isDiagramPreviewActive(): boolean {
  return diagramPreviewElementIds.size > 0;
}

export function withoutDiagramPreviewElements<T extends { id?: unknown }>(elements: readonly T[]): T[] {
  return elements.filter((element) => typeof element.id !== "string" || !diagramPreviewElementIds.has(element.id));
}

export function reportDiagramPreviewProgress(nodes: number, edges: number, version: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.wileyDiagramPreview = `${nodes}/${edges}`;
  const entry = `${Math.round(performance.now())}:${nodes}/${edges}:${version}`;
  const previous = (document.documentElement.dataset.wileyDiagramPreviewTrace ?? "").split("|").filter(Boolean);
  document.documentElement.dataset.wileyDiagramPreviewTrace = [...previous, entry].slice(-128).join("|");
  document.dispatchEvent(new CustomEvent("wiley:diagram-preview-progress", {
    detail: { nodes, edges, version },
  }));
}

export function clearDiagramPreview(api: ExcalidrawImperativeAPI, value: unknown) {
  const version = finite(asRecord(value).__previewVersion, 0);
  if (version < diagramPreviewVersions.latest) return { stale: true };
  diagramPreviewVersions.latest = version;
  const cleared = diagramPreviewElementIds.size;
  const elements = withoutDiagramPreviewElements([...api.getSceneElements()]);
  diagramPreviewElementIds.clear();
  diagramPreviewVersions.lastNodeCount = 0;
  diagramPreviewStream.diagramId = null;
  if (cleared > 0) {
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }
  reportDiagramPreviewProgress(0, 0, version);
  return { cleared };
}
