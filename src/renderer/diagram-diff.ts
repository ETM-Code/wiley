/**
 * What changes when a diagram is drawn again.
 *
 * Element ids are derived from the graph, so the same node keeps the same id
 * across a redraw and the diff falls out of set arithmetic rather than any
 * geometric guesswork. Renaming a node changes its key, which changes its id,
 * which reads as one element leaving and another arriving: exactly right, since
 * the old element genuinely is not the new one.
 *
 * Pure, and deliberately ignorant of Excalidraw: it takes plain records in and
 * returns plain records out, so the animation can be tested without a canvas.
 */

import { readDiagramStamp } from "../shared/diagram-stamp";
import { finiteNumber, type DiagramPlan } from "./diagram-layout";

export type DiffGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Present for arrows only, relative to x and y. */
  points?: Array<[number, number]>;
};

export type DiffElement = {
  id: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: ReadonlyArray<readonly number[]>;
  text?: string;
  name?: string;
  containerId?: string | null;
  customData?: unknown;
};

export type DiagramDiff = {
  /** Elements present before and after, with where they have to travel. */
  survivors: Array<{ id: string; from: DiffGeometry; to: DiffGeometry }>;
  /** Survivors whose caption changed, with the text element carrying it. */
  relabels: Array<{ id: string; labelId?: string; from: string; to: string }>;
  additions: string[];
  /** Element ids to take off the board, bound labels of the departed included. */
  removals: string[];
};

function geometryOf(element: DiffElement): DiffGeometry {
  const points = Array.isArray(element.points)
    ? element.points.map((point) => [finiteNumber(point[0]), finiteNumber(point[1])] as [number, number])
    : undefined;
  return {
    x: finiteNumber(element.x),
    y: finiteNumber(element.y),
    width: finiteNumber(element.width),
    height: finiteNumber(element.height),
    ...(points ? { points } : {}),
  };
}

/**
 * A caption wherever it happens to live: bound to a shape, written on a frame,
 * or the element's own text.
 */
function captionOf(element: DiffElement, boundText: ReadonlyMap<string, string>): string {
  return boundText.get(element.id)
    ?? (typeof element.name === "string" ? element.name : undefined)
    ?? (typeof element.text === "string" ? element.text : "");
}

function planCaption(skeleton: Record<string, unknown>): string {
  const label = (skeleton.label as { text?: unknown } | undefined)?.text;
  if (typeof label === "string") return label;
  if (typeof skeleton.name === "string") return skeleton.name;
  return typeof skeleton.text === "string" ? skeleton.text : "";
}

export function planDiff(existingElements: readonly DiffElement[], plan: DiagramPlan): DiagramDiff {
  const boundText = new Map<string, string>();
  const boundLabelId = new Map<string, string>();
  for (const element of existingElements) {
    if (element.type !== "text" || !element.containerId) continue;
    boundText.set(element.containerId, element.text ?? "");
    boundLabelId.set(element.containerId, element.id);
  }
  const mine = existingElements.filter(
    (element) => readDiagramStamp(element)?.diagram === plan.diagramId,
  );
  const before = new Map(mine.map((element) => [element.id, element]));
  const after = new Map(
    plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]),
  );

  const survivors: DiagramDiff["survivors"] = [];
  const relabels: DiagramDiff["relabels"] = [];
  for (const [id, skeleton] of after) {
    const previous = before.get(id);
    if (!previous) continue;
    survivors.push({ id, from: geometryOf(previous), to: geometryOf(skeleton as DiffElement) });
    const from = captionOf(previous, boundText);
    const to = planCaption(skeleton);
    if (from !== to) {
      const labelId = boundLabelId.get(id);
      relabels.push({ id, ...(labelId ? { labelId } : {}), from, to });
    }
  }

  const additions = [...after.keys()].filter((id) => !before.has(id));
  const departed = [...before.keys()].filter((id) => !after.has(id));
  // A bound label is not addressed by id anywhere, so it leaves with whatever
  // it was attached to rather than being stranded on the board.
  const orphanedLabels = departed
    .map((id) => boundLabelId.get(id))
    .filter((id): id is string => Boolean(id));
  return { survivors, relabels, additions, removals: [...departed, ...orphanedLabels] };
}
