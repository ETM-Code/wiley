/**
 * Tidying the person's own sketch.
 *
 * This is the one operation allowed to move a human element, and it exists
 * only because someone asked for it out loud. Every element keeps its id, its
 * colours, and its text; nothing is deleted and nothing is replaced by an
 * agent-drawn copy. What changes is where things sit: sizes and positions
 * snap to the grid, shapes line up into the rows and columns they were
 * already roughly in, spacing evens out, captions ride the shapes they name,
 * and the arrows get re-routed and given the real bindings the person's
 * freehand ones never had.
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
import type { DiagramObstacle } from "../diagram-quality";
import { assertDiagramQuality } from "./diagram-render";
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

/** The straightened grid: same rough topology, exact rows, even gaps. */
export function alignBoxes(nodes: readonly HumanNode[]): Map<string, Geometry> {
  const sizes = new Map(nodes.map((node) => [node.elementId, {
    width: snapUp(node.bounds.width),
    height: snapUp(node.bounds.height),
  }]));
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
  const extent = (groups: string[][], pick: (node: HumanNode) => number) => groups
    .map((group) => Math.max(...group.map((id) => pick(byId.get(id)!))));
  const columnWidths = extent(columns, (node) => snapUp(node.bounds.width));
  const rowHeights = extent(rows, (node) => snapUp(node.bounds.height));

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
      x: columnX[columnOf.get(node.elementId)!],
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
    size: { width: snapUp(node.bounds.width), height: snapUp(node.bounds.height) },
  }));
  const graphEdges: GraphEdge[] = edges
    .filter((edge) => edge.fromElementId && edge.toElementId
      && edge.fromElementId !== edge.toElementId)
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
      width: snapUp(node.bounds.width),
      height: snapUp(node.bounds.height),
    });
  }
  return boxes;
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
  for (const route of input.routes) {
    const origin = route.points[0];
    merge(route.edge.elementId, {
      x: origin.x,
      y: origin.y,
      width: Math.max(...route.points.map((point) => point.x)) - Math.min(...route.points.map((point) => point.x)),
      height: Math.max(...route.points.map((point) => point.y)) - Math.min(...route.points.map((point) => point.y)),
      points: route.points.map((point) => [point.x - origin.x, point.y - origin.y]),
      startBinding: { elementId: route.edge.fromElementId, focus: 0, gap: 4 },
      endBinding: { elementId: route.edge.toElementId, focus: 0, gap: 4 },
    });
    bound += 1;
    for (const endpoint of [route.edge.fromElementId, route.edge.toElementId]) {
      if (!endpoint) continue;
      boundAdditions.set(endpoint, [...(boundAdditions.get(endpoint) ?? []), route.edge.elementId]);
    }
    // A caption on a re-routed arrow follows it to the new midpoint.
    const caption = route.edge.labelElementId ? byId.get(route.edge.labelElementId) : undefined;
    const arrow = byId.get(route.edge.elementId);
    if (!caption || !arrow) continue;
    const wasMiddle = middleOf(connectorPoints(arrow));
    const nowMiddle = middleOf(route.points);
    merge(caption.id, {
      x: finiteNumber(caption.x) + (nowMiddle.x - wasMiddle.x),
      y: finiteNumber(caption.y) + (nowMiddle.y - wasMiddle.y),
    });
  }

  // A half-connected arrow keeps pointing at the shape it did reach.
  for (const edge of input.graph.edges) {
    if (routed.has(edge.elementId)) continue;
    const anchor = edge.fromElementId ?? edge.toElementId;
    const delta = anchor ? deltas.get(anchor) : undefined;
    if (!delta || (delta.dx === 0 && delta.dy === 0)) continue;
    const element = byId.get(edge.elementId);
    if (!element) continue;
    merge(edge.elementId, {
      x: finiteNumber(element.x) + delta.dx,
      y: finiteNumber(element.y) + delta.dy,
    });
  }

  for (const [elementId, arrows] of boundAdditions) {
    const element = byId.get(elementId) as (SketchElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
    }) | undefined;
    const existing = element?.boundElements ?? [];
    const missing = arrows
      .filter((id) => !existing.some((entry) => entry?.id === id))
      .map((id) => ({ id, type: "arrow" as const }));
    if (missing.length === 0) continue;
    merge(elementId, { boundElements: [...existing, ...missing] });
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
  const targets = tidyTargets(sketch, params);
  if (targets.length === 0) {
    throw new Error("tidy-diagram found nothing of the user's to tidy");
  }
  const graph = inferHumanGraph(sketch, { elementIds: targets });
  if (graph.nodes.length === 0) {
    throw new Error("tidy-diagram found no shapes in that part of the board");
  }

  const layout: TidyLayout = params.layout ?? "align";
  const boxes = layout === "relayout"
    ? await relayoutBoxes(graph.nodes, graph.edges, params.direction ?? "RIGHT")
    : alignBoxes(graph.nodes);
  anchorToOrigin(boxes, graph.nodes);

  // Everything outside the tidy is somebody else's: the agent's own diagrams
  // and any part of the sketch this request did not name.
  const inside = new Set<string>(targets);
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

  const routes = routeSketch(
    boxes,
    graph.edges,
    obstacles.filter((obstacle) => obstacle.kind === "shape")
      .map((obstacle) => ({ id: obstacle.id, ...obstacle.bounds })),
  );
  const shapes = new Map(graph.nodes.map((node) => [node.elementId, node.shape]));
  const quality = assertDiagramQuality(tidyPlan(boxes, routes, shapes), obstacles);

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
