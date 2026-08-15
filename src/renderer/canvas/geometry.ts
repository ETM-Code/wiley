import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  MODEL_GRID_SIZE,
  finiteNumber as finite,
  snapModelCoordinate,
  snapModelSize,
  type PlanBounds,
} from "../diagram-layout";
import type { JsonObject, SceneElement } from "./types";

export function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

export function snapModelGeometry(props: JsonObject): JsonObject {
  const snapped = { ...props };
  if ("x" in snapped) snapped.x = snapModelCoordinate(snapped.x);
  if ("y" in snapped) snapped.y = snapModelCoordinate(snapped.y);
  if ("width" in snapped) snapped.width = snapModelSize(snapped.width, MODEL_GRID_SIZE);
  if ("height" in snapped) snapped.height = snapModelSize(snapped.height, MODEL_GRID_SIZE);
  if (Array.isArray(snapped.points)) {
    snapped.points = snapped.points.map((point) => Array.isArray(point)
      ? [snapModelCoordinate(point[0]), snapModelCoordinate(point[1])]
      : point);
  }
  return snapped;
}

export function gridResult() {
  return { gridSize: MODEL_GRID_SIZE, snapped: true };
}

export type PlaceDirection = "right" | "left" | "above" | "below";
export const PLACE_GAP = 120;

export function finiteGeometry(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter(
    (element) => Number.isFinite(element.x) && Number.isFinite(element.y)
      && Number.isFinite(element.width) && Number.isFinite(element.height),
  );
}

export function elementsBounds(elements: readonly SceneElement[]): PlanBounds | null {
  if (elements.length === 0) return null;
  return {
    minX: Math.min(...elements.map((element) => element.x)),
    minY: Math.min(...elements.map((element) => element.y)),
    maxX: Math.max(...elements.map((element) => element.x + element.width)),
    maxY: Math.max(...elements.map((element) => element.y + element.height)),
  };
}

/**
 * Places new content beside the anchor element (or the whole existing scene)
 * in the requested direction, offset so its own bounds clear the reference.
 */
export function directionalOrigin(
  reference: PlanBounds,
  content: PlanBounds,
  direction: PlaceDirection,
  gap = PLACE_GAP,
): { x: number; y: number } {
  switch (direction) {
    case "left":
      return {
        x: snapModelCoordinate(reference.minX - gap - content.maxX),
        y: snapModelCoordinate(reference.minY - content.minY),
      };
    case "above":
      return {
        x: snapModelCoordinate(reference.minX - content.minX),
        y: snapModelCoordinate(reference.minY - gap - content.maxY),
      };
    case "below":
      return {
        x: snapModelCoordinate(reference.minX - content.minX),
        y: snapModelCoordinate(reference.maxY + gap - content.minY),
      };
    default:
      return {
        x: snapModelCoordinate(reference.maxX + gap - content.minX),
        y: snapModelCoordinate(reference.minY - content.minY),
      };
  }
}

export function resolveDiagramOrigin(
  api: ExcalidrawImperativeAPI,
  anchor: string | undefined,
  direction: PlaceDirection,
  content: PlanBounds,
  sourceElements: readonly SceneElement[],
): { x: number; y: number } {
  const elements = finiteGeometry(sourceElements);
  const anchored = anchor ? elements.find((element) => element.id === anchor) : undefined;
  const reference = anchored
    ? elementsBounds([anchored])
    : elementsBounds(elements);
  if (!reference) {
    const state = api.getAppState();
    return {
      x: snapModelCoordinate(Math.max(80, -finite(state.scrollX) + 120)),
      y: snapModelCoordinate(Math.max(80, -finite(state.scrollY) + 120)),
    };
  }
  return directionalOrigin(reference, content, direction);
}

export function perimeterPoint(
  box: { x: number; y: number; width: number; height: number },
  towards: { x: number; y: number },
): { x: number; y: number } {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const dx = towards.x - centerX;
  const dy = towards.y - centerY;
  if (dx === 0 && dy === 0) return { x: centerX, y: centerY };
  const scaleX = dx !== 0 ? box.width / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? box.height / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}
