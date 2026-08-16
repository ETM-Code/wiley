/**
 * Tidying the person's own sketch.
 *
 * The diagram machinery treats a human element as a fixed obstacle everywhere
 * else; this is the one place inside it that moves one, and only because
 * someone asked out loud. (applyPatch moves a human element too, but only the
 * one the user just pointed at, which is a different thing from rearranging
 * somebody's drawing on the agent's own initiative.)
 *
 * Every element keeps its id, its colours, and its text; nothing is deleted
 * and nothing is replaced by an agent-drawn copy. What changes is where
 * things sit: sizes and positions snap to the grid, shapes line up into the
 * rows and columns they were already roughly in, spacing evens out, captions
 * ride the shapes they name, and the arrows get re-routed and given the real
 * bindings the person's freehand ones never had.
 *
 * `align` keeps the topology the person drew and straightens it. `relayout`
 * hands the inferred graph to ELK and takes the arrangement it comes back
 * with, at each shape's own size.
 */

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { readDiagramStamp } from "../../shared/diagram-stamp";
import {
  MODEL_GRID_SIZE,
  finiteNumber,
  planDiagramLayout,
  snapModelCoordinate,
  type DiagramDirection,
  type DiagramPlan,
  type GraphEdge,
  type GraphNode,
} from "../diagram-layout";
import {
  MAX_ROUTE_REPAIR_ITERATIONS,
  planRoutes,
  routeDefects,
  type Box,
  type Point,
  type RouteRequest,
} from "../diagram-routes";
import { easeInOutCubic } from "../diagram-diff";
import { OBSTACLE_MARKER, type DiagramObstacle } from "../diagram-quality";
import { assertDiagramQuality, placementCollisions } from "./diagram-render";
import { shiftClearOf } from "./geometry";
import {
  connectorPoints,
  humanElements,
  inferHumanGraph,
  type HumanEdge,
  type HumanGraph,
  type HumanNode,
  type SketchElement,
} from "./human-graph";
import { humanObstacles } from "./human-merge";
import { shiftedArrowGeometry } from "./patch";
import { pauseForStreaming, shouldStreamCanvas } from "./streaming";
import type { SceneElement } from "./types";

export type TidyLayout = "align" | "relayout";

export type TidyParams = {
  /** Exactly which elements to tidy. */
  elementIds?: string[];
  /** Or: everything of the person's drawn around this element. */
  near?: string;
  /** How far around `near` to reach. */
  radius?: number;
  layout?: TidyLayout;
  direction?: DiagramDirection;
};

/** How far around a named element a sketch is taken to extend. */
export const TIDY_NEAR_RADIUS = 600;
/** Gaps are evened out to the sketch's own median, held inside this range. */
const MIN_GAP = 60;
const MAX_GAP = 240;
const DEFAULT_GAP = 80;
/** Centres closer than this on one axis were meant to be the same row. */
const MIN_CLUSTER_TOLERANCE = 24;
const CLUSTER_HEIGHT_FRACTION = 0.6;

const MOVE_MS = 420;
const MOVE_FRAMES = 12;

type Geometry = { x: number; y: number; width: number; height: number };

function snapUp(value: number): number {
  return Math.max(MODEL_GRID_SIZE, Math.ceil(value / MODEL_GRID_SIZE) * MODEL_GRID_SIZE);
}

/** Types whose proportions carry meaning and must not be snapped apart. */
const FIXED_RATIO_TYPES = new Set(["image", "embeddable", "iframe"]);

/**
 * A shape's tidied size. A drawn box rounds up onto the grid; a screenshot or
 * an embed keeps the exact size it has, because snapping its width and height
 * to separate multiples would stretch the picture inside it.
 */
function tidiedSize(node: HumanNode): { width: number; height: number } {
  if (FIXED_RATIO_TYPES.has(node.shape)) {
    return { width: node.bounds.width, height: node.bounds.height };
  }
  return { width: snapUp(node.bounds.width), height: snapUp(node.bounds.height) };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function gapOf(values: readonly number[]): number {
  const middle = median(values.filter((value) => value > 0));
  if (middle === undefined) return DEFAULT_GAP;
  return Math.min(MAX_GAP, Math.max(MIN_GAP, snapUp(middle)));
}

/**
 * Which elements the request is aimed at: the ones it named, everything the
 * person drew around a named element, or the whole sketch.
 */
export function tidyTargets(
  elements: readonly SketchElement[],
  params: TidyParams,
): string[] {
  const mine = humanElements(elements);
  if (params.elementIds?.length) {
    const wanted = new Set(params.elementIds);
    const found = mine.filter((element) => wanted.has(element.id)).map((element) => element.id);
    const missing = params.elementIds.filter((id) => !found.includes(id));
    if (missing.length > 0) {
      throw new Error(`tidy-diagram cannot move ${missing.join(", ")}: not the user's own elements`);
    }
    return found;
  }
  if (!params.near) return mine.map((element) => element.id);

  const anchor = elements.find((element) => element.id === params.near);
  if (!anchor) throw new Error(`tidy-diagram: unknown element ${params.near}`);
  const radius = params.radius ?? TIDY_NEAR_RADIUS;
  const box = {
    x: finiteNumber(anchor.x),
    y: finiteNumber(anchor.y),
    width: finiteNumber(anchor.width),
    height: finiteNumber(anchor.height),
  };
  return mine
    .filter((element) => {
      const dx = Math.max(box.x - (finiteNumber(element.x) + finiteNumber(element.width)),
        0,
        finiteNumber(element.x) - (box.x + box.width));
      const dy = Math.max(box.y - (finiteNumber(element.y) + finiteNumber(element.height)),
        0,
        finiteNumber(element.y) - (box.y + box.height));
      return Math.hypot(dx, dy) <= radius;
    })
    .map((element) => element.id);
}

/**
 * Widens a named selection to everything that has to travel with it.
 *
 * A request names shapes, because shapes are what the canvas context lists.
 * Moving them without their connectors would leave the person's arrows lying
 * where the boxes used to be, still claiming bindings to shapes they no
 * longer reach, so every connector with an end inside the selection comes
 * too, along with the captions riding all of it.
 */
export function expandTidyScope(graph: HumanGraph, targets: readonly string[]): string[] {
  const scope = new Set(targets);
  // A frame drawn round the selection comes too, to a fixed point for nested
  // frames. Leaving it behind would move the shapes out from under the
  // grouping the person drew and quietly lose it.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    const before = scope.size;
    for (const node of graph.nodes) {
      if (node.encloses?.some((id) => scope.has(id))) scope.add(node.elementId);
    }
    if (scope.size === before) break;
  }
  for (const node of graph.nodes) {
    if (!scope.has(node.elementId) || !node.labelElementId) continue;
    scope.add(node.labelElementId);
  }
  for (const edge of graph.edges) {
    const touches = (edge.fromElementId && scope.has(edge.fromElementId))
      || (edge.toElementId && scope.has(edge.toElementId));
    if (!touches) continue;
    scope.add(edge.elementId);
    if (edge.labelElementId) scope.add(edge.labelElementId);
  }
  return [...scope];
}

/**
 * Groups centres that were already meant to line up. Sorting first and
 * breaking a run the moment a gap exceeds the tolerance keeps the answer
 * stable: two shapes either belong to the same row or they do not, and
 * nothing about the order they happen to sit in the scene can change that.
 */
export function clusterAxis(
  entries: ReadonlyArray<{ id: string; center: number }>,
  tolerance: number,
): string[][] {
  const sorted = [...entries].sort((a, b) => a.center - b.center
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const clusters: string[][] = [];
  let current: string[] = [];
  let anchor = 0;
  for (const entry of sorted) {
    if (current.length === 0 || entry.center - anchor <= tolerance) {
      if (current.length === 0) anchor = entry.center;
      current.push(entry.id);
      continue;
    }
    clusters.push(current);
    current = [entry.id];
    anchor = entry.center;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Clear space a shape drawn around others keeps outside them. */
const WRAP_PADDING = 40;

export type WrapperGroup = { node: HumanNode; memberIds: string[]; depth: number };

/**
 * Separates the shapes someone drew *around* other shapes from the shapes
 * themselves. A rectangle enclosing a cluster is framing, not a step in the
 * flow: laying it out as a peer would either put it in a grid cell of its own,
 * miles from the things it holds, or in the same cell as one of them. It gets
 * its geometry from what it ends up holding instead, and is never judged,
 * because overlapping its own members is the entire point of it.
 */
export function splitWrappers(nodes: readonly HumanNode[]): {
  members: HumanNode[];
  wrappers: WrapperGroup[];
} {
  const wrapping = new Set(nodes.filter((node) => node.encloses).map((node) => node.elementId));
  const members = nodes.filter((node) => !wrapping.has(node.elementId));
  const wrappers = nodes
    .filter((node) => wrapping.has(node.elementId))
    .map((node) => ({
      node,
      memberIds: (node.encloses ?? []).filter((id) => !wrapping.has(id)),
      // A wrapper around a wrapper stands off further, so the two do not
      // collapse onto the same box.
      depth: (node.encloses ?? []).filter((id) => wrapping.has(id)).length,
    }));
  return { members, wrappers };
}

/** Each wrapper redrawn around wherever its members ended up. */
export function wrapperBoxes(
  wrappers: readonly WrapperGroup[],
  boxes: ReadonlyMap<string, Geometry>,
): Map<string, Geometry> {
  const wrapped = new Map<string, Geometry>();
  for (const wrapper of wrappers) {
    const held = wrapper.memberIds
      .map((id) => boxes.get(id))
      .filter((box): box is Geometry => Boolean(box));
    if (held.length === 0) continue;
    const pad = WRAP_PADDING * (wrapper.depth + 1);
    const x = snapModelCoordinate(Math.min(...held.map((box) => box.x)) - pad);
    const y = snapModelCoordinate(Math.min(...held.map((box) => box.y)) - pad);
    wrapped.set(wrapper.node.elementId, {
      x,
      y,
      width: snapUp(Math.max(...held.map((box) => box.x + box.width)) + pad - x),
      height: snapUp(Math.max(...held.map((box) => box.y + box.height)) + pad - y),
    });
  }
  return wrapped;
}

/** The straightened grid: same rough topology, exact rows, even gaps. */
export function alignBoxes(nodes: readonly HumanNode[]): Map<string, Geometry> {
  const sizes = new Map(nodes.map((node) => [node.elementId, tidiedSize(node)]));
  const heights = nodes.map((node) => node.bounds.height);
  const tolerance = Math.max(
    MIN_CLUSTER_TOLERANCE,
    (median(heights) ?? MIN_CLUSTER_TOLERANCE) * CLUSTER_HEIGHT_FRACTION,
  );
  const rows = clusterAxis(
    nodes.map((node) => ({ id: node.elementId, center: node.bounds.y + node.bounds.height / 2 })),
    tolerance,
  );
  const columns = clusterAxis(
    nodes.map((node) => ({ id: node.elementId, center: node.bounds.x + node.bounds.width / 2 })),
    tolerance,
  );
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => row.forEach((id) => rowOf.set(id, index)));
  const columnOf = new Map<string, number>();
  columns.forEach((column, index) => column.forEach((id) => columnOf.set(id, index)));

  const byId = new Map(nodes.map((node) => [node.elementId, node]));
  // Rows and columns are clustered independently, so two shapes the person
  // drew nearly on top of each other fall in the same row *and* the same
  // column. Sharing a cell would put them at identical coordinates, which is
  // an overlap the evaluator rightly refuses. Each row therefore hands out
  // its own columns left to right, never reusing one it has already given.
  const columnFor = new Map<string, number>();
  for (const row of rows) {
    let previous = -1;
    const members = [...row].sort((a, b) => byId.get(a)!.bounds.x - byId.get(b)!.bounds.x
      || (a < b ? -1 : a > b ? 1 : 0));
    for (const id of members) {
      const column = Math.max(columnOf.get(id)!, previous + 1);
      columnFor.set(id, column);
      previous = column;
    }
  }
  const columnCount = Math.max(0, ...[...columnFor.values()].map((column) => column + 1));

  const widest = (column: number) => Math.max(0, ...nodes
    .filter((node) => columnFor.get(node.elementId) === column)
    .map((node) => sizes.get(node.elementId)!.width));
  const columnWidths = Array.from({ length: columnCount }, (_, column) => widest(column));
  const rowHeights = rows.map((row) => Math.max(...row.map((id) => sizes.get(id)!.height)));

  const columnGap = gapOf(columns.slice(1).map((group, index) => {
    const left = Math.max(...columns[index].map((id) => byId.get(id)!.bounds.x + byId.get(id)!.bounds.width));
    const right = Math.min(...group.map((id) => byId.get(id)!.bounds.x));
    return right - left;
  }));
  const rowGap = gapOf(rows.slice(1).map((group, index) => {
    const top = Math.max(...rows[index].map((id) => byId.get(id)!.bounds.y + byId.get(id)!.bounds.height));
    const bottom = Math.min(...group.map((id) => byId.get(id)!.bounds.y));
    return bottom - top;
  }));

  const columnX: number[] = [];
  const rowY: number[] = [];
  for (let index = 0; index < columnWidths.length; index++) {
    columnX[index] = index === 0 ? 0 : columnX[index - 1] + columnWidths[index - 1] + columnGap;
  }
  for (let index = 0; index < rowHeights.length; index++) {
    rowY[index] = index === 0 ? 0 : rowY[index - 1] + rowHeights[index - 1] + rowGap;
  }

  // Shapes sit at the corner of their cell rather than centred in it. Every
  // size is already a grid multiple, so a centred offset would be a half
  // multiple and two boxes of different heights in one row would end up
  // aligned on neither their tops nor, after snapping, their centres.
  const boxes = new Map<string, Geometry>();
  for (const node of nodes) {
    const size = sizes.get(node.elementId)!;
    boxes.set(node.elementId, {
      x: columnX[columnFor.get(node.elementId)!],
      y: rowY[rowOf.get(node.elementId)!],
      width: size.width,
      height: size.height,
    });
  }
  return boxes;
}

/** ELK's arrangement, at each shape's own size rather than a measured one. */
async function relayoutBoxes(
  nodes: readonly HumanNode[],
  edges: readonly HumanEdge[],
  direction: DiagramDirection,
): Promise<Map<string, Geometry>> {
  const graphNodes: GraphNode[] = nodes.map((node) => ({
    id: node.elementId,
    label: node.label ?? node.elementId,
    size: tidiedSize(node),
  }));
  // Only edges between shapes ELK is actually laying out. An arrow onto a
  // framing shape names a node that was deliberately held back, and naming a
  // node the graph does not have fails validation before layout even starts.
  const laidOut = new Set(nodes.map((node) => node.elementId));
  const graphEdges: GraphEdge[] = edges
    .filter((edge) => edge.fromElementId && edge.toElementId
      && edge.fromElementId !== edge.toElementId
      && laidOut.has(edge.fromElementId) && laidOut.has(edge.toElementId))
    .map((edge) => ({ from: edge.fromElementId!, to: edge.toElementId! }));
  const plan = await planDiagramLayout(
    { nodes: graphNodes, edges: graphEdges, layout: { direction } },
    { x: 0, y: 0 },
    "wd-tidy",
  );
  const skeletonById = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
  const boxes = new Map<string, Geometry>();
  for (const node of nodes) {
    const skeleton = skeletonById.get(plan.elementIdByNode.get(node.elementId) ?? "");
    if (!skeleton) continue;
    boxes.set(node.elementId, {
      x: snapModelCoordinate(skeleton.x),
      y: snapModelCoordinate(skeleton.y),
      ...tidiedSize(node),
    });
  }
  return boxes;
}

function boxesBounds(boxes: readonly Geometry[]) {
  return {
    minX: Math.min(...boxes.map((box) => box.x)),
    minY: Math.min(...boxes.map((box) => box.y)),
    maxX: Math.max(...boxes.map((box) => box.x + box.width)),
    maxY: Math.max(...boxes.map((box) => box.y + box.height)),
  };
}

/** Puts the tidied sketch back where the person had it. */
function anchorToOrigin(boxes: Map<string, Geometry>, previous: readonly HumanNode[]): void {
  if (boxes.size === 0 || previous.length === 0) return;
  const wasX = Math.min(...previous.map((node) => node.bounds.x));
  const wasY = Math.min(...previous.map((node) => node.bounds.y));
  const nowX = Math.min(...[...boxes.values()].map((box) => box.x));
  const nowY = Math.min(...[...boxes.values()].map((box) => box.y));
  const dx = snapModelCoordinate(wasX - nowX);
  const dy = snapModelCoordinate(wasY - nowY);
  if (dx === 0 && dy === 0) return;
  for (const box of boxes.values()) {
    box.x += dx;
    box.y += dy;
  }
}

type TidyRoute = { edge: HumanEdge; points: Point[] };

function routeSketch(
  boxes: ReadonlyMap<string, Geometry>,
  edges: readonly HumanEdge[],
  blockers: readonly Box[],
): TidyRoute[] {
  const connected = edges.filter((edge) => edge.fromElementId && edge.toElementId
    && edge.fromElementId !== edge.toElementId
    && boxes.has(edge.fromElementId) && boxes.has(edge.toElementId));
  if (connected.length === 0) return [];
  const nodes = new Map<string, Box>();
  for (const [id, box] of boxes) nodes.set(id, { id, ...box });
  for (const blocker of blockers) if (!nodes.has(blocker.id)) nodes.set(blocker.id, blocker);

  const requests: RouteRequest[] = connected.map((edge) => ({
    id: edge.elementId,
    from: edge.fromElementId!,
    to: edge.toElementId!,
  }));
  const attachments = new Map(requests.map((request) => [
    request.id,
    { from: request.from, to: request.to },
  ]));
  const minSteps = new Map<string, number>();
  let routes = planRoutes(nodes, requests, { minSteps });
  for (let round = 0; round < MAX_ROUTE_REPAIR_ITERATIONS; round++) {
    const guilty = routeDefects(nodes, routes, attachments);
    if (guilty.size === 0) break;
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(nodes, requests, { minSteps });
  }
  return connected.map((edge, index) => ({ edge, points: routes[index].points }));
}

/**
 * A geometric stand-in for the tidied sketch, so the same evaluator that
 * judges the agent's own diagrams judges this one. Deliberately colourless:
 * the person's palette is theirs, and the checks that would grade it have
 * nothing to say about whether the arrangement came out clean.
 */
export function tidyPlan(
  boxes: ReadonlyMap<string, Geometry>,
  routes: readonly TidyRoute[],
  shapes: ReadonlyMap<string, string>,
): DiagramPlan {
  const skeletons: Record<string, unknown>[] = [];
  const roles: DiagramPlan["roles"] = new Map();
  const elementIdByNode = new Map<string, string>();
  for (const [id, box] of boxes) {
    skeletons.push({ id, type: shapes.get(id) ?? "rectangle", ...box });
    roles.set(id, { role: "node", key: id });
    elementIdByNode.set(id, id);
  }
  for (const route of routes) {
    const origin = route.points[0];
    skeletons.push({
      id: route.edge.elementId,
      type: "arrow",
      x: origin.x,
      y: origin.y,
      width: 0,
      height: 0,
      points: route.points.map((point) => [point.x - origin.x, point.y - origin.y]),
      start: { id: route.edge.fromElementId },
      end: { id: route.edge.toElementId },
    });
    roles.set(route.edge.elementId, { role: "edge", key: route.edge.elementId });
  }
  return {
    skeletons,
    nodeCount: boxes.size,
    edgeCount: routes.length,
    edgeLabelCount: 0,
    elementIdByNode,
    diagramId: "wd-tidy",
    roles,
    containers: new Map(),
    theme: "slate",
    explicitColors: new Set(),
    boundLabelBoxes: [],
    layout: { requested: "layered", used: "layered" },
  };
}

type Patch = Record<string, unknown>;

/** What the tidy is going to write, worked out before anything is applied. */
export function tidyPatches(input: {
  scene: readonly SketchElement[];
  graph: HumanGraph;
  boxes: ReadonlyMap<string, Geometry>;
  routes: readonly TidyRoute[];
}): { patches: Map<string, Patch>; bound: number } {
  const byId = new Map(input.scene.map((element) => [element.id, element]));
  const patches = new Map<string, Patch>();
  const merge = (id: string, props: Patch) => {
    patches.set(id, { ...(patches.get(id) ?? {}), ...props });
  };

  const deltas = new Map<string, { dx: number; dy: number }>();
  for (const node of input.graph.nodes) {
    const box = input.boxes.get(node.elementId);
    if (!box) continue;
    deltas.set(node.elementId, { dx: box.x - node.bounds.x, dy: box.y - node.bounds.y });
    merge(node.elementId, box);
  }

  // Captions ride the shapes they name: a bound label re-centres on its new
  // box, a free-standing one travels the same distance its shape did.
  for (const element of input.scene) {
    if (element.type !== "text" || typeof element.containerId !== "string") continue;
    const box = input.boxes.get(element.containerId);
    if (!box) continue;
    merge(element.id, {
      x: box.x + (box.width - finiteNumber(element.width)) / 2,
      y: box.y + (box.height - finiteNumber(element.height)) / 2,
    });
  }
  for (const node of input.graph.nodes) {
    const caption = node.labelElementId ? byId.get(node.labelElementId) : undefined;
    const delta = deltas.get(node.elementId);
    if (!caption || !delta) continue;
    merge(caption.id, {
      x: finiteNumber(caption.x) + delta.dx,
      y: finiteNumber(caption.y) + delta.dy,
    });
  }

  const routed = new Set(input.routes.map((route) => route.edge.elementId));
  let bound = 0;
  const boundAdditions = new Map<string, string[]>();
  const attachedTo = new Map<string, Set<string>>();
  for (const route of input.routes) {
    const origin = route.points[0];
    const connector = byId.get(route.edge.elementId);
    // Only an arrow is a binding element in Excalidraw. A connector drawn
    // with the line tool is re-routed but never claims a binding, and never
    // gets recorded on a shape as an arrow it is not.
    const bindable = connector?.type === "arrow";
    merge(route.edge.elementId, {
      x: origin.x,
      y: origin.y,
      width: Math.max(...route.points.map((point) => point.x)) - Math.min(...route.points.map((point) => point.x)),
      height: Math.max(...route.points.map((point) => point.y)) - Math.min(...route.points.map((point) => point.y)),
      points: route.points.map((point) => [point.x - origin.x, point.y - origin.y]),
      ...(bindable
        ? {
            startBinding: { elementId: route.edge.fromElementId, focus: 0, gap: 4 },
            endBinding: { elementId: route.edge.toElementId, focus: 0, gap: 4 },
          }
        : {}),
    });
    if (bindable) {
      bound += 1;
      attachedTo.set(
        route.edge.elementId,
        new Set([route.edge.fromElementId, route.edge.toElementId]
          .filter((id): id is string => Boolean(id))),
      );
      for (const endpoint of attachedTo.get(route.edge.elementId) ?? []) {
        boundAdditions.set(endpoint, [...(boundAdditions.get(endpoint) ?? []), route.edge.elementId]);
      }
    }
    // A caption on a re-routed arrow follows it to the new midpoint.
    const caption = route.edge.labelElementId ? byId.get(route.edge.labelElementId) : undefined;
    if (!caption || !connector) continue;
    const wasMiddle = middleOf(connectorPoints(connector));
    const nowMiddle = middleOf(route.points);
    merge(caption.id, {
      x: finiteNumber(caption.x) + (nowMiddle.x - wasMiddle.x),
      y: finiteNumber(caption.y) + (nowMiddle.y - wasMiddle.y),
    });
  }

  // A half-connected arrow keeps pointing at the shape it did reach, unless
  // its other end is really bound to something this tidy is not moving:
  // dragging it then would pull that end off a shape that stayed put.
  for (const edge of input.graph.edges) {
    if (routed.has(edge.elementId)) continue;
    const anchor = edge.fromElementId ?? edge.toElementId;
    const delta = anchor ? deltas.get(anchor) : undefined;
    if (!delta || (delta.dx === 0 && delta.dy === 0)) continue;
    const element = byId.get(edge.elementId);
    if (!element) continue;
    const anchored = [element.startBinding?.elementId, element.endBinding?.elementId]
      .filter((id): id is string => Boolean(id))
      .some((id) => id !== anchor && !deltas.has(id));
    if (anchored) continue;
    merge(edge.elementId, {
      x: finiteNumber(element.x) + delta.dx,
      y: finiteNumber(element.y) + delta.dy,
    });
  }

  // Anything else on the board bound into the sketch travels with it: the
  // agent's own connectors reaching a hand-drawn box, and the person's arrows
  // that this tidy is not itself re-routing. Without this the box moves and
  // the arrow stays put, still bound, pointing where the box used to be.
  for (const element of input.scene) {
    if (element.type !== "arrow" || patches.has(element.id)) continue;
    const start = element.startBinding?.elementId;
    const end = element.endBinding?.elementId;
    const from = start ? deltas.get(start) : undefined;
    const to = end ? deltas.get(end) : undefined;
    if (!from && !to) continue;
    const moved = shiftedArrowGeometry(
      { x: finiteNumber(element.x), y: finiteNumber(element.y), points: element.points },
      { sdx: from?.dx ?? 0, sdy: from?.dy ?? 0, edx: to?.dx ?? 0, edy: to?.dy ?? 0 },
    );
    if (moved) merge(element.id, moved);
  }

  // A scribble or an aside was written beside something. It travels with
  // whichever shape it was nearest, so a tidy that packs the grid together
  // cannot drop a row of boxes on top of the note about them.
  const nodeById = new Map(input.graph.nodes.map((node) => [node.elementId, node]));
  for (const id of input.graph.unattached) {
    const element = byId.get(id);
    if (!element || patches.has(id)) continue;
    const center = {
      x: finiteNumber(element.x) + finiteNumber(element.width) / 2,
      y: finiteNumber(element.y) + finiteNumber(element.height) / 2,
    };
    let nearest: { id: string; distance: number } | undefined;
    for (const [nodeId, node] of nodeById) {
      if (!deltas.has(nodeId)) continue;
      const distance = Math.hypot(
        node.bounds.x + node.bounds.width / 2 - center.x,
        node.bounds.y + node.bounds.height / 2 - center.y,
      );
      if (!nearest || distance < nearest.distance
        || (distance === nearest.distance && nodeId < nearest.id)) {
        nearest = { id: nodeId, distance };
      }
    }
    const delta = nearest ? deltas.get(nearest.id) : undefined;
    if (!delta || (delta.dx === 0 && delta.dy === 0)) continue;
    merge(id, {
      x: finiteNumber(element.x) + delta.dx,
      y: finiteNumber(element.y) + delta.dy,
    });
  }

  // Re-routing can take an arrow off one shape and put it on another, so the
  // shape it left has to stop claiming it; a stale entry would drag an arrow
  // that is no longer attached the next time that shape moves.
  for (const element of input.scene) {
    const existing = (element as SketchElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
    }).boundElements ?? [];
    const kept = existing.filter((entry) => {
      const owners = attachedTo.get(entry?.id ?? "");
      return !owners || owners.has(element.id);
    });
    const missing = (boundAdditions.get(element.id) ?? [])
      .filter((id) => !kept.some((entry) => entry?.id === id))
      .map((id) => ({ id, type: "arrow" as const }));
    if (missing.length === 0 && kept.length === existing.length) continue;
    merge(element.id, { boundElements: [...kept, ...missing] });
  }
  return { patches, bound };
}

function middleOf(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const index = Math.floor((points.length - 1) / 2);
  const next = points[Math.min(points.length - 1, index + 1)];
  return { x: (points[index].x + next.x) / 2, y: (points[index].y + next.y) / 2 };
}

function applyPatches(
  elements: readonly SceneElement[],
  patches: ReadonlyMap<string, Patch>,
): SceneElement[] {
  return elements.map((element) => {
    const patch = patches.get(element.id);
    if (!patch) return element;
    return {
      ...element,
      ...patch,
      version: (element as SceneElement & { version: number }).version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as SceneElement;
  });
}

export async function tidyDiagram(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = (value ?? {}) as TidyParams;
  const scene = [...api.getSceneElements()];
  const sketch = scene as unknown as SketchElement[];
  const named = tidyTargets(sketch, params);
  if (named.length === 0) {
    throw new Error("tidy-diagram found nothing of the user's to tidy");
  }
  // Read the whole sketch first, so naming a handful of shapes still brings
  // the arrows between them along instead of stranding them.
  const targets = expandTidyScope(inferHumanGraph(sketch), named);
  const graph = inferHumanGraph(sketch, { elementIds: targets });
  if (graph.nodes.length === 0) {
    throw new Error("tidy-diagram found no shapes in that part of the board");
  }

  const layout: TidyLayout = params.layout ?? "align";
  // A shape drawn around a cluster is framing rather than a step, so it is
  // laid out from what it holds instead of competing for a cell.
  const { members, wrappers } = splitWrappers(graph.nodes);
  const placed = layout === "relayout"
    ? await relayoutBoxes(members, graph.edges, params.direction ?? "RIGHT")
    : alignBoxes(members);
  anchorToOrigin(placed, members);

  // Everything outside the tidy is somebody else's: the agent's own diagrams
  // and any part of the sketch this request did not name. A caption is inside
  // whenever the shape it names is, or it would be judged as a foreign
  // obstacle while travelling with the shape it belongs to.
  const inside = new Set<string>([
    ...targets,
    ...graph.nodes.map((node) => node.elementId),
    ...graph.edges.map((edge) => edge.elementId),
    ...graph.unattached,
    ...[...graph.nodes.map((node) => node.labelElementId),
      ...graph.edges.map((edge) => edge.labelElementId)]
      .filter((id): id is string => Boolean(id)),
  ]);
  for (const element of sketch) {
    if (typeof element.containerId === "string" && inside.has(element.containerId)) {
      inside.add(element.id);
    }
  }
  const foreign = humanObstacles(sketch.filter((element) => !inside.has(element.id)));
  const stamped: DiagramObstacle[] = scene
    .filter((element) => readDiagramStamp(element) !== undefined)
    .map((element) => ({
      id: element.id,
      bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
      kind: element.type === "text" ? "text" as const : "shape" as const,
    }))
    .filter((obstacle) => Object.values(obstacle.bounds).every(Number.isFinite));
  const obstacles = [...foreign, ...stamped];

  // The tidied sketch moves as one piece, so if it lands on work that is not
  // part of it, the whole piece slides clear. Down first, then sideways: a
  // sketch with the agent's diagrams stacked under it has nowhere to go
  // downwards and every reason to go right.
  const wrapped = wrapperBoxes(wrappers, placed);
  const avoid = obstacles.map((obstacle) => ({
    minX: obstacle.bounds.x,
    minY: obstacle.bounds.y,
    maxX: obstacle.bounds.x + obstacle.bounds.width,
    maxY: obstacle.bounds.y + obstacle.bounds.height,
  }));
  const here = boxesBounds([...placed.values(), ...wrapped.values()]);
  const clearing = shiftClearOf(here, avoid, "below") ?? shiftClearOf(here, avoid, "right");
  if (clearing && (clearing.dx !== 0 || clearing.dy !== 0)) {
    for (const box of [...placed.values(), ...wrapped.values()]) {
      box.x += clearing.dx;
      box.y += clearing.dy;
    }
  }
  const boxes = new Map([...placed, ...wrapped]);

  const routes = routeSketch(
    placed,
    graph.edges,
    obstacles.filter((obstacle) => obstacle.kind === "shape")
      .map((obstacle) => ({ id: obstacle.id, ...obstacle.bounds })),
  );
  // Only the shapes that were placed are judged: a wrapper overlapping the
  // members it was drawn around is what the person meant by drawing it.
  const shapes = new Map(members.map((node) => [node.elementId, node.shape]));
  const quality = assertDiagramQuality(tidyPlan(placed, routes, shapes), obstacles);
  const landed = quality ? placementCollisions(quality) : [];
  // Landing on somebody else's drawing is a refusal; landing on the agent's
  // own diagram is a fact worth reporting, because the agent can move that.
  const theirs = new Set(foreign.map((obstacle) => obstacle.id));
  const onTheirWork = landed.filter(
    (finding) => [...theirs].some((id) => finding.endsWith(` x ${id}${OBSTACLE_MARKER}`)),
  );
  if (onTheirWork.length > 0) {
    throw new Error(`The tidied sketch would land on their other drawing: ${onTheirWork.slice(0, 3).join("; ")}`);
  }
  const overlapping = landed.filter((finding) => !onTheirWork.includes(finding));

  const { patches, bound } = tidyPatches({ scene: sketch, graph, boxes, routes });
  const moved = [...patches].filter(([id, patch]) => {
    const element = scene.find((candidate) => candidate.id === id);
    return element && (("x" in patch && patch.x !== element.x) || ("y" in patch && patch.y !== element.y));
  }).length;

  const commit = () => {
    api.updateScene({
      elements: applyPatches([...api.getSceneElements()], patches),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return {
      layout,
      nodes: graph.nodes.length,
      edges: routes.length,
      moved,
      bound,
      unattached: graph.unattached.length,
      ...(overlapping.length > 0 ? { overlapsYourDiagrams: overlapping.length } : {}),
      ...(quality ? { quality } : {}),
    };
  };

  if (!shouldStreamCanvas()) return commit();
  // The journey is drawn without capturing history; only the arrival is an
  // undo step, exactly as an animated diagram update behaves. Every frame is
  // measured from where things started, so a frame the editor drops cannot
  // leave an element short of where it was going.
  const travelling = [...patches]
    .map(([id, patch]) => {
      const element = scene.find((candidate) => candidate.id === id);
      if (!element || (!("x" in patch) && !("y" in patch))) return undefined;
      return {
        id,
        from: { x: element.x, y: element.y },
        to: { x: Number(patch.x ?? element.x), y: Number(patch.y ?? element.y) },
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  for (let frame = 1; frame < MOVE_FRAMES && travelling.length > 0; frame++) {
    const eased = easeInOutCubic(frame / MOVE_FRAMES);
    const partial = new Map<string, Patch>(travelling.map((entry) => [entry.id, {
      x: entry.from.x + (entry.to.x - entry.from.x) * eased,
      y: entry.from.y + (entry.to.y - entry.from.y) * eased,
    }]));
    api.updateScene({
      elements: applyPatches([...api.getSceneElements()], partial),
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    await pauseForStreaming(MOVE_MS / MOVE_FRAMES);
  }
  return commit();
}
