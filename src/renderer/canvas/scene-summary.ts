import { readDiagramStamp, type DiagramThemeName } from "../../shared/diagram-stamp";
import {
  humanGraphPayload,
  inferHumanGraph,
  type SketchElement,
} from "./human-graph";
import type { SceneElement } from "./types";

/**
 * The person's own sketch, read as a graph. Handing this back with every
 * scene read is what lets the agent connect to a hand-drawn box by id without
 * first working out from raw geometry which text belongs to which rectangle.
 */
export function humanGraphOf(elements: readonly SceneElement[]) {
  return humanGraphPayload(inferHumanGraph(elements as unknown as SketchElement[]));
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export type DiagramSummary = {
  id: string;
  title?: string;
  /** So a follow-up call can extend a diagram in the palette it already uses. */
  theme?: DiagramThemeName;
  nodeKeys: string[];
  bounds: { x: number; y: number; w: number; h: number };
  elementCount: number;
};

/**
 * One entry per agent-drawn diagram still on the board, so a later request
 * can name an existing diagram instead of re-deriving it from raw geometry.
 */
export function diagramIndex(elements: readonly SceneElement[]): DiagramSummary[] {
  const accumulators = new Map<string, {
    title?: string;
    theme?: DiagramThemeName;
    nodeKeys: string[];
    elementCount: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>();
  for (const element of elements) {
    const stamp = readDiagramStamp(element);
    if (!stamp) continue;
    const entry = accumulators.get(stamp.diagram) ?? {
      nodeKeys: [],
      elementCount: 0,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    entry.elementCount += 1;
    if (stamp.theme) entry.theme = stamp.theme;
    if (stamp.role === "node" && stamp.key) entry.nodeKeys.push(stamp.key);
    if (stamp.role === "title") {
      const text = (element as SceneElement & { text?: string }).text;
      if (text) entry.title = text;
    }
    if (Number.isFinite(element.x) && Number.isFinite(element.y)) {
      entry.minX = Math.min(entry.minX, element.x);
      entry.minY = Math.min(entry.minY, element.y);
      entry.maxX = Math.max(entry.maxX, element.x + (Number.isFinite(element.width) ? element.width : 0));
      entry.maxY = Math.max(entry.maxY, element.y + (Number.isFinite(element.height) ? element.height : 0));
    }
    accumulators.set(stamp.diagram, entry);
  }
  return [...accumulators].map(([id, entry]) => ({
    id,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.theme ? { theme: entry.theme } : {}),
    nodeKeys: entry.nodeKeys,
    bounds: Number.isFinite(entry.minX)
      ? {
          x: Math.round(entry.minX),
          y: Math.round(entry.minY),
          w: Math.round(entry.maxX - entry.minX),
          h: Math.round(entry.maxY - entry.minY),
        }
      : { x: 0, y: 0, w: 0, h: 0 },
    elementCount: entry.elementCount,
  }));
}

export function sceneSummary(elements: readonly SceneElement[]) {
  const textByContainer = new Map<string, string>();
  for (const element of elements) {
    const candidate = element as SceneElement & { text?: string; containerId?: string | null };
    if (candidate.type === "text" && candidate.containerId && candidate.text) {
      textByContainer.set(candidate.containerId, candidate.text);
    }
  }

  return {
    elements: elements.map((element) => {
      const candidate = element as SceneElement & {
        text?: string;
        startBinding?: { elementId?: string } | null;
        endBinding?: { elementId?: string } | null;
      };
      const connects =
        candidate.type === "arrow"
          ? {
              start: candidate.startBinding?.elementId ?? null,
              end: candidate.endBinding?.elementId ?? null,
            }
          : undefined;
      const stamp = readDiagramStamp(element);

      return {
        id: element.id,
        type: element.type,
        bbox: {
          x: Math.round(element.x),
          y: Math.round(element.y),
          w: Math.round(element.width),
          h: Math.round(element.height),
        },
        text: candidate.text ?? textByContainer.get(element.id),
        connects,
        diagram: stamp
          ? { id: stamp.diagram, key: stamp.key, role: stamp.role }
          : undefined,
      };
    }),
    diagrams: diagramIndex(elements),
    humanGraph: humanGraphOf(elements),
  };
}
