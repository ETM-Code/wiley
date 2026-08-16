/**
 * Reading a graph out of the human's own sketch.
 *
 * Everything the agent draws carries a stamp, so the agent's diagrams rebuild
 * themselves from the board exactly (see diagram-reconstruct). A person's
 * drawing carries nothing: boxes that nearly line up, arrows whose ends stop
 * short of the shape they mean, captions floating beside the thing they name.
 * This module turns that into nodes and edges so the agent can connect to,
 * extend, and tidy a sketch instead of drawing its own copy beside it.
 *
 * Two rules govern the whole file. Every ambiguity resolves deterministically
 * (nearest wins, ties break on element id), and anything that cannot be read
 * with confidence lands in `unattached` rather than being guessed at. A wrong
 * reading of someone's drawing is worse than an incomplete one.
 *
 * Pure and free of both Node and Excalidraw: the main process reads it to
 * describe the board in the agent's context, and the renderer reads it to
 * plan work against the sketch.
 */

import { readDiagramStamp } from "../../shared/diagram-stamp";

/** The element fields the reading actually touches. */
export type SketchElement = {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  text?: string;
  containerId?: string | null;
  points?: ReadonlyArray<readonly number[]>;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  customData?: unknown;
};

export type HumanBounds = { x: number; y: number; width: number; height: number };

export type HumanNode = {
  elementId: string;
  /** The Excalidraw type the person drew: rectangle, diamond, ellipse, image. */
  shape: string;
  bounds: HumanBounds;
  label?: string;
  /** Set when the caption is a free text element rather than a bound label. */
  labelElementId?: string;
};

export type HumanEdge = {
  elementId: string;
  fromElementId?: string;
  toElementId?: string;
  label?: string;
  labelElementId?: string;
  /** Which ends came from a real binding rather than from proximity. */
  bound: { start: boolean; end: boolean };
};

export type HumanGraph = {
  nodes: HumanNode[];
  edges: HumanEdge[];
  /** Human elements with no readable role: scribbles, stray captions, notes. */
  unattached: string[];
};

/** How far outside a shape a free text may sit and still be read as its label. */
export const HUMAN_LABEL_TOLERANCE = 12;
/** Floor on how near an arrow end has to come to a shape to count as attached. */
export const HUMAN_ENDPOINT_TOLERANCE = 16;
/** A big shape earns a proportionally bigger catch radius than the floor. */
export const HUMAN_ENDPOINT_SHAPE_FRACTION = 0.1;
/** How near an arrow's midpoint a floating text has to sit to be its label. */
export const HUMAN_EDGE_LABEL_TOLERANCE = 24;

export type HumanGraphOptions = {
  /**
   * Restrict the reading to these elements. A bound label is pulled in with
   * the shape that owns it, so a caller naming shapes need not name captions.
   */
  elementIds?: readonly string[];
  labelTolerance?: number;
  endpointTolerance?: number;
  endpointShapeFraction?: number;
  edgeLabelTolerance?: number;
};

/** Shapes a person draws to mean "a thing". Freedraw is never one of them. */
const NODE_TYPES = new Set(["rectangle", "diamond", "ellipse", "image", "embeddable", "iframe"]);
const EDGE_TYPES = new Set(["arrow", "line"]);

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundsOf(element: SketchElement): HumanBounds {
  return {
    x: finite(element.x),
    y: finite(element.y),
    width: finite(element.width),
    height: finite(element.height),
  };
}

function centerOf(bounds: HumanBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Zero inside the box, otherwise the straight-line gap to its perimeter. */
export function distanceToBounds(point: { x: number; y: number }, bounds: HumanBounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

/**
 * Everything the person drew: on the board, not deleted, and unstamped. A
 * label bound into a stamped shape carries no stamp of its own, so it has to
 * be excluded by its owner rather than by its own customData.
 */
export function humanElements(elements: readonly SketchElement[]): SketchElement[] {
  const stamped = new Set<string>();
  for (const element of elements) {
    if (readDiagramStamp(element) !== undefined) stamped.add(element.id);
  }
  return elements.filter((element) => !element.isDeleted
    && !stamped.has(element.id)
    && !(typeof element.containerId === "string" && stamped.has(element.containerId)));
}

/** Absolute polyline of an arrow or line, from its origin and its points. */
export function connectorPoints(element: SketchElement): Array<{ x: number; y: number }> {
  const originX = finite(element.x);
  const originY = finite(element.y);
  const points = Array.isArray(element.points) ? element.points : [];
  const absolute = points
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => ({ x: originX + finite(point[0]), y: originY + finite(point[1]) }));
  if (absolute.length >= 2) return absolute;
  // A connector with no usable points still spans its own bounding box.
  return [
    { x: originX, y: originY },
    { x: originX + finite(element.width), y: originY + finite(element.height) },
  ];
}

/** The point halfway along a polyline by length, which is where a caption sits. */
export function polylineMidpoint(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const spans: number[] = [0];
  for (let index = 1; index < points.length; index++) {
    spans.push(spans[index - 1] + Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    ));
  }
  const total = spans[spans.length - 1];
  if (total <= 1e-9) return points[0];
  const target = total / 2;
  let segment = 1;
  while (segment < spans.length - 1 && spans[segment] < target) segment += 1;
  const span = spans[segment] - spans[segment - 1];
  const ratio = span <= 1e-9 ? 0 : (target - spans[segment - 1]) / span;
  return {
    x: points[segment - 1].x + (points[segment].x - points[segment - 1].x) * ratio,
    y: points[segment - 1].y + (points[segment].y - points[segment - 1].y) * ratio,
  };
}

/**
 * Assigns each text to at most one owner, nearest pair first. Iterating owners
 * instead would let the order elements happen to sit in the scene decide which
 * of two shapes gets a caption sitting between them.
 */
function claimNearest(
  pairs: Array<{ textId: string; ownerId: string; distance: number }>,
): Map<string, string> {
  const ordered = [...pairs].sort((a, b) => a.distance - b.distance
    || (a.textId < b.textId ? -1 : a.textId > b.textId ? 1 : 0)
    || (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0));
  const claimedTexts = new Set<string>();
  const claimedOwners = new Set<string>();
  const byOwner = new Map<string, string>();
  for (const pair of ordered) {
    if (claimedTexts.has(pair.textId) || claimedOwners.has(pair.ownerId)) continue;
    claimedTexts.add(pair.textId);
    claimedOwners.add(pair.ownerId);
    byOwner.set(pair.ownerId, pair.textId);
  }
  return byOwner;
}

export function inferHumanGraph(
  elements: readonly SketchElement[],
  options: HumanGraphOptions = {},
): HumanGraph {
  const labelTolerance = options.labelTolerance ?? HUMAN_LABEL_TOLERANCE;
  const endpointTolerance = options.endpointTolerance ?? HUMAN_ENDPOINT_TOLERANCE;
  const endpointFraction = options.endpointShapeFraction ?? HUMAN_ENDPOINT_SHAPE_FRACTION;
  const edgeLabelTolerance = options.edgeLabelTolerance ?? HUMAN_EDGE_LABEL_TOLERANCE;

  const scope = options.elementIds ? new Set(options.elementIds) : undefined;
  const mine = humanElements(elements).filter((element) => !scope
    || scope.has(element.id)
    || (typeof element.containerId === "string" && scope.has(element.containerId)));

  const shapes = mine.filter((element) => NODE_TYPES.has(element.type));
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const connectors = mine.filter((element) => EDGE_TYPES.has(element.type));

  const boundLabels = new Map<string, SketchElement>();
  const freeTexts: SketchElement[] = [];
  for (const element of mine) {
    if (element.type !== "text") continue;
    if (typeof element.containerId === "string" && shapeById.has(element.containerId)) {
      boundLabels.set(element.containerId, element);
      continue;
    }
    if (typeof element.containerId === "string") continue;
    freeTexts.push(element);
  }

  // A shape already wearing a bound label is not looking for a caption.
  const unlabelled = shapes.filter((shape) => !boundLabels.has(shape.id));
  const labelPairs: Array<{ textId: string; ownerId: string; distance: number }> = [];
  for (const text of freeTexts) {
    const center = centerOf(boundsOf(text));
    for (const shape of unlabelled) {
      const distance = distanceToBounds(center, boundsOf(shape));
      if (distance <= labelTolerance) labelPairs.push({ textId: text.id, ownerId: shape.id, distance });
    }
  }
  const captionByShape = claimNearest(labelPairs);
  const textById = new Map(freeTexts.map((text) => [text.id, text]));

  const nodes: HumanNode[] = shapes.map((shape) => {
    const bound = boundLabels.get(shape.id);
    const captionId = captionByShape.get(shape.id);
    const caption = captionId ? textById.get(captionId) : undefined;
    const label = bound?.text?.trim() || caption?.text?.trim();
    return {
      elementId: shape.id,
      shape: shape.type,
      bounds: boundsOf(shape),
      ...(label ? { label } : {}),
      ...(caption && label ? { labelElementId: caption.id } : {}),
    };
  });

  const attach = (point: { x: number; y: number }): string | undefined => {
    let best: { id: string; distance: number } | undefined;
    for (const node of nodes) {
      const reach = Math.max(
        endpointTolerance,
        endpointFraction * Math.min(node.bounds.width, node.bounds.height),
      );
      const distance = distanceToBounds(point, node.bounds);
      if (distance > reach) continue;
      if (!best || distance < best.distance
        || (distance === best.distance && node.elementId < best.id)) {
        best = { id: node.elementId, distance };
      }
    }
    return best?.id;
  };

  const edges: HumanEdge[] = connectors.map((connector) => {
    const points = connectorPoints(connector);
    const startBound = connector.startBinding?.elementId;
    const endBound = connector.endBinding?.elementId;
    const from = startBound && shapeById.has(startBound) ? startBound : attach(points[0]);
    const to = endBound && shapeById.has(endBound)
      ? endBound
      : attach(points[points.length - 1]);
    return {
      elementId: connector.id,
      ...(from ? { fromElementId: from } : {}),
      ...(to ? { toElementId: to } : {}),
      bound: {
        start: Boolean(startBound && shapeById.has(startBound)),
        end: Boolean(endBound && shapeById.has(endBound)),
      },
    };
  });

  const takenTexts = new Set(captionByShape.values());
  const edgeLabelPairs: Array<{ textId: string; ownerId: string; distance: number }> = [];
  for (const connector of connectors) {
    const midpoint = polylineMidpoint(connectorPoints(connector));
    for (const text of freeTexts) {
      if (takenTexts.has(text.id)) continue;
      const distance = Math.hypot(
        centerOf(boundsOf(text)).x - midpoint.x,
        centerOf(boundsOf(text)).y - midpoint.y,
      );
      if (distance <= edgeLabelTolerance) {
        edgeLabelPairs.push({ textId: text.id, ownerId: connector.id, distance });
      }
    }
  }
  const captionByEdge = claimNearest(edgeLabelPairs);
  for (const edge of edges) {
    const captionId = captionByEdge.get(edge.elementId);
    const caption = captionId ? textById.get(captionId) : undefined;
    const label = caption?.text?.trim();
    if (!label) continue;
    edge.label = label;
    edge.labelElementId = caption!.id;
    takenTexts.add(caption!.id);
  }

  const placed = new Set<string>([
    ...nodes.map((node) => node.elementId),
    ...nodes.map((node) => node.labelElementId).filter((id): id is string => Boolean(id)),
    ...[...boundLabels.values()].map((label) => label.id),
    ...edges.map((edge) => edge.elementId),
    ...edges.map((edge) => edge.labelElementId).filter((id): id is string => Boolean(id)),
  ]);
  return {
    nodes,
    edges,
    unattached: mine.filter((element) => !placed.has(element.id)).map((element) => element.id),
  };
}

/** The whole sketch's outline, for placing new work clear of it. */
export function humanGraphBounds(graph: HumanGraph): HumanBounds | null {
  if (graph.nodes.length === 0) return null;
  const minX = Math.min(...graph.nodes.map((node) => node.bounds.x));
  const minY = Math.min(...graph.nodes.map((node) => node.bounds.y));
  const maxX = Math.max(...graph.nodes.map((node) => node.bounds.x + node.bounds.width));
  const maxY = Math.max(...graph.nodes.map((node) => node.bounds.y + node.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** How many arrows the reading could not fully attach. */
export function looseEdgeCount(graph: HumanGraph): number {
  return graph.edges.filter((edge) => !edge.fromElementId || !edge.toElementId).length;
}

/**
 * The shape the agent's context carries: enough to name a human element in a
 * request without spending a tool call reading the raw scene.
 */
export function humanGraphPayload(graph: HumanGraph) {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.elementId,
      shape: node.shape,
      ...(node.label ? { label: node.label } : {}),
      bbox: {
        x: Math.round(node.bounds.x),
        y: Math.round(node.bounds.y),
        w: Math.round(node.bounds.width),
        h: Math.round(node.bounds.height),
      },
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.elementId,
      from: edge.fromElementId ?? null,
      to: edge.toElementId ?? null,
      ...(edge.label ? { label: edge.label } : {}),
    })),
    unattached: graph.unattached,
  };
}

const SUMMARY_LABEL_LIMIT = 6;

/** One line: what the person drew, in the words they wrote on it. */
export function formatHumanGraph(graph: HumanGraph): string {
  if (graph.nodes.length === 0 && graph.edges.length === 0) return "(none)";
  const labelled = graph.nodes
    .map((node) => node.label)
    .filter((label): label is string => Boolean(label));
  const shown = labelled.slice(0, SUMMARY_LABEL_LIMIT).map((label) => JSON.stringify(label));
  if (labelled.length > SUMMARY_LABEL_LIMIT) shown.push("...");
  const loose = looseEdgeCount(graph);
  const parts = [
    `${graph.nodes.length} shapes${shown.length ? ` (${shown.join(", ")})` : ""}`,
    `${graph.edges.length} connectors${loose ? ` (${loose} unattached)` : ""}`,
  ];
  if (graph.unattached.length > 0) parts.push(`${graph.unattached.length} loose marks`);
  return `human sketch: ${parts.join(", ")}`;
}
