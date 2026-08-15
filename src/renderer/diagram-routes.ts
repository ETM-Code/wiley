/**
 * Connector geometry and the deterministic repair pipeline every non-layered
 * algorithm runs its edges through.
 *
 * ELK's tree, radial, force, and stress algorithms place nodes well and
 * routes badly: they hand back straight lines between node centres that walk
 * through whatever happens to sit between. This module re-anchors those
 * routes onto real ports, then bends or re-routes any run that crosses a
 * foreign node. Everything here is pure and deterministic, so the same graph
 * always produces the same picture.
 *
 * It deliberately imports nothing: the layout planner and the quality
 * evaluator both depend on it, and a dependency in the other direction would
 * close a cycle.
 */

export type Point = { x: number; y: number };
export type Segment = { x1: number; y1: number; x2: number; y2: number };
export type Box = { id: string; x: number; y: number; width: number; height: number };
export type Triangle = [Point, Point, Point];
export type Side = "top" | "right" | "bottom" | "left";

type JsonObject = Record<string, unknown>;

/** Ports separated by more than one grid cell can never snap onto each other. */
export const PORT_SPACING = 28;
/** Routes are tested against a slightly shrunk box; grazing a border is fine. */
export const NODE_CLEARANCE = 4;
/** Bend offsets are tried on grid multiples so repaired routes stay tidy. */
export const OFFSET_STEP = 20;
export const MAX_OFFSET_STEPS = 12;
/** After this many evaluate/repair rounds the algorithm itself is the problem. */
export const MAX_ROUTE_REPAIR_ITERATIONS = 3;

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function shrinkBox(box: Box, shrink: number) {
  return {
    left: box.x + shrink,
    right: box.x + box.width - shrink,
    top: box.y + shrink,
    bottom: box.y + box.height - shrink,
  };
}

/**
 * Liang-Barsky clipping. A bounding-box test would do for orthogonal routes
 * but reports every diagonal that merely passes a corner, which is most of
 * them once the non-layered algorithms are in play.
 */
export function segmentIntersectsBox(segment: Segment, box: Box, shrink = NODE_CLEARANCE): boolean {
  const { left, right, top, bottom } = shrinkBox(box, shrink);
  if (left >= right || top >= bottom) return false;
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const edges = [-dx, dx, -dy, dy];
  const distances = [
    segment.x1 - left,
    right - segment.x1,
    segment.y1 - top,
    bottom - segment.y1,
  ];
  let enter = 0;
  let exit = 1;
  for (let index = 0; index < 4; index++) {
    if (Math.abs(edges[index]) < 1e-12) {
      // Parallel to this edge: either wholly outside the slab or irrelevant.
      if (distances[index] < 0) return false;
      continue;
    }
    const t = distances[index] / edges[index];
    if (edges[index] < 0) {
      if (t > exit) return false;
      enter = Math.max(enter, t);
    } else {
      if (t < enter) return false;
      exit = Math.min(exit, t);
    }
  }
  return enter < exit;
}

/** Separating-axis test between a triangle and an axis-aligned box. */
export function triangleIntersectsBox(triangle: Triangle, box: Box, shrink = NODE_CLEARANCE): boolean {
  const { left, right, top, bottom } = shrinkBox(box, shrink);
  if (left >= right || top >= bottom) return false;
  const rect: Point[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const axes: Point[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (let index = 0; index < 3; index++) {
    const from = triangle[index];
    const to = triangle[(index + 1) % 3];
    axes.push({ x: -(to.y - from.y), y: to.x - from.x });
  }
  for (const axis of axes) {
    const length = Math.hypot(axis.x, axis.y);
    if (length < 1e-9) continue;
    const project = (points: Point[]) => {
      const values = points.map((point) => (point.x * axis.x + point.y * axis.y) / length);
      return { min: Math.min(...values), max: Math.max(...values) };
    };
    const a = project(triangle);
    const b = project(rect);
    if (a.max <= b.min || b.max <= a.min) return false;
  }
  return true;
}

export function absoluteArrowPoints(arrow: JsonObject): Point[] {
  const originX = finite(arrow.x);
  const originY = finite(arrow.y);
  const points = (Array.isArray(arrow.points) ? arrow.points : []) as Array<[number, number]>;
  return points.map((point) => ({ x: originX + finite(point[0]), y: originY + finite(point[1]) }));
}

export function pointsToSegments(points: readonly Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index++) {
    segments.push({
      x1: points[index - 1].x,
      y1: points[index - 1].y,
      x2: points[index].x,
      y2: points[index].y,
    });
  }
  return segments;
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export type ArrowGeometry = {
  /** The parts drawn as straight lines. */
  segments: Segment[];
  /** Conservative hulls containing whatever the rounded corners sweep. */
  corners: Triangle[];
};

/**
 * What a route actually covers on the canvas.
 *
 * A rounded arrow does not pass through its bendpoints: each interior corner
 * is replaced by a curve that cuts inside, staying within the triangle
 * spanned by the two neighbouring segment midpoints and the corner itself.
 * That triangle is the conservative hull. Testing the raw polyline instead
 * misses anything sitting in the pocket the curve sweeps through.
 */
export function routeGeometry(points: readonly Point[], rounded: boolean): ArrowGeometry {
  if (points.length < 2) return { segments: [], corners: [] };
  if (!rounded || points.length === 2) return { segments: pointsToSegments(points), corners: [] };
  const last = points.length - 1;
  const corners: Triangle[] = [];
  for (let index = 1; index < last; index++) {
    corners.push([
      midpoint(points[index - 1], points[index]),
      points[index],
      midpoint(points[index], points[index + 1]),
    ]);
  }
  const head = midpoint(points[0], points[1]);
  const tail = midpoint(points[last - 1], points[last]);
  return {
    segments: [
      { x1: points[0].x, y1: points[0].y, x2: head.x, y2: head.y },
      { x1: tail.x, y1: tail.y, x2: points[last].x, y2: points[last].y },
    ],
    corners,
  };
}

export function arrowGeometry(arrow: JsonObject): ArrowGeometry {
  return routeGeometry(absoluteArrowPoints(arrow), Boolean(arrow.roundness));
}

export function geometryIntersectsBox(
  geometry: ArrowGeometry,
  box: Box,
  shrink = NODE_CLEARANCE,
): boolean {
  return geometry.segments.some((segment) => segmentIntersectsBox(segment, box, shrink))
    || geometry.corners.some((corner) => triangleIntersectsBox(corner, box, shrink));
}

export function countBlockers(
  points: readonly Point[],
  rounded: boolean,
  blockers: readonly Box[],
): number {
  const geometry = routeGeometry(points, rounded);
  return blockers.filter((box) => geometryIntersectsBox(geometry, box)).length;
}

// ---------------------------------------------------------------------------
// (a) Port assignment
// ---------------------------------------------------------------------------

/**
 * Which side of a node an edge should leave from, decided against the box's
 * own diagonal so a wide node still uses its long sides for shallow angles.
 */
export function chooseSide(box: Box, target: Point): Side {
  const centre = boxCenter(box);
  const dx = target.x - centre.x;
  const dy = target.y - centre.y;
  if (Math.abs(dx) * Math.max(1, box.height) >= Math.abs(dy) * Math.max(1, box.width)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

type PortRequest = { key: string; nodeId: string; side: Side; target: Point };

/**
 * Evenly spaced slots centred on the side, ordered so the connectors do not
 * cross each other on their way out: down the vertical sides, across the
 * horizontal ones. Ties fall back to the request key so the result never
 * depends on iteration order.
 */
export function portSlots(box: Box, side: Side, count: number): Point[] {
  if (count <= 0) return [];
  const horizontal = side === "top" || side === "bottom";
  const length = horizontal ? box.width : box.height;
  const spacing = Math.max(PORT_SPACING, length / (count + 1));
  const centre = boxCenter(box);
  const middle = horizontal ? centre.x : centre.y;
  const low = (horizontal ? box.x : box.y) + 2;
  const high = (horizontal ? box.x + box.width : box.y + box.height) - 2;
  return Array.from({ length: count }, (_, index) => {
    const along = Math.min(high, Math.max(low, middle + (index - (count - 1) / 2) * spacing));
    if (side === "top") return { x: along, y: box.y };
    if (side === "bottom") return { x: along, y: box.y + box.height };
    if (side === "left") return { x: box.x, y: along };
    return { x: box.x + box.width, y: along };
  });
}

/**
 * Places every edge endpoint on a port slot. Returns start and end points per
 * edge id, in absolute coordinates.
 */
export function assignPorts(
  nodes: ReadonlyMap<string, Box>,
  edges: ReadonlyArray<{ id: string; from: string; to: string }>,
): Map<string, { start: Point; end: Point }> {
  const requests = new Map<string, PortRequest[]>();
  const request = (key: string, nodeId: string, otherId: string, fallbackSide: Side) => {
    const box = nodes.get(nodeId);
    const other = nodes.get(otherId);
    if (!box) return;
    // A self-edge has no direction to read, so it takes fixed opposite sides.
    const side = !other || otherId === nodeId ? fallbackSide : chooseSide(box, boxCenter(other));
    const bucket = `${nodeId}|${side}`;
    const list = requests.get(bucket) ?? [];
    list.push({ key, nodeId, side, target: other ? boxCenter(other) : boxCenter(box) });
    requests.set(bucket, list);
  };
  for (const edge of edges) {
    request(`${edge.id}|start`, edge.from, edge.to, "right");
    request(`${edge.id}|end`, edge.to, edge.from, "left");
  }

  const points = new Map<string, Point>();
  for (const [bucket, list] of [...requests.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [nodeId, side] = bucket.split("|") as [string, Side];
    const box = nodes.get(nodeId)!;
    const horizontal = side === "top" || side === "bottom";
    const ordered = [...list].sort((a, b) => {
      const first = horizontal ? a.target.x - b.target.x : a.target.y - b.target.y;
      if (Math.abs(first) > 1e-9) return first;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    const slots = portSlots(box, side, ordered.length);
    ordered.forEach((entry, index) => points.set(entry.key, slots[index]));
  }

  const assignment = new Map<string, { start: Point; end: Point }>();
  for (const edge of edges) {
    const start = points.get(`${edge.id}|start`);
    const end = points.get(`${edge.id}|end`);
    if (start && end) assignment.set(edge.id, { start, end });
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// (b) Snap re-anchor
// ---------------------------------------------------------------------------

export type SnapDelta = { dx: number; dy: number };

/**
 * Nodes move when they snap to the model grid; their attached route endpoints
 * have to move with them or the arrow detaches from the box it belongs to.
 * Only the endpoints shift: the bendpoints in between are channel geometry
 * and stay where the layout put them.
 */
export function reanchorRoute(
  points: readonly Point[],
  fromDelta: SnapDelta | undefined,
  toDelta: SnapDelta | undefined,
): Point[] {
  if (points.length === 0) return [];
  const moved = points.map((point) => ({ ...point }));
  const last = moved.length - 1;
  if (fromDelta) {
    moved[0] = { x: moved[0].x + fromDelta.dx, y: moved[0].y + fromDelta.dy };
  }
  if (toDelta) {
    moved[last] = { x: moved[last].x + toDelta.dx, y: moved[last].y + toDelta.dy };
  }
  return moved;
}

// ---------------------------------------------------------------------------
// (c) Straight-route repair
// ---------------------------------------------------------------------------

export type RepairedRoute = { points: Point[]; rounded: boolean };

/**
 * Bends a blocked straight run around whatever it crosses.
 *
 * The bend is a single perpendicular offset at the midpoint, tried at
 * increasing grid multiples on both sides. The smallest offset that clears
 * everything wins; a tie between two equal offsets goes to the one crossing
 * fewer boxes, then to the positive side, so the choice never depends on
 * anything but the geometry.
 */
export function repairStraightRoute(
  from: Point,
  to: Point,
  blockers: readonly Box[],
  minStep = 1,
): RepairedRoute | null {
  if (minStep <= 1 && countBlockers([from, to], false, blockers) === 0) {
    return { points: [from, to], rounded: false };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return null;
  const nx = -dy / length;
  const ny = dx / length;
  const centre = midpoint(from, to);

  // Offsets are tried smallest first and positive before negative, so the
  // first clearing candidate found is already the winner under
  // (smallest magnitude, fewest blockers, positive side).
  for (let step = Math.max(1, minStep); step <= MAX_OFFSET_STEPS; step++) {
    for (const sign of [1, -1]) {
      const magnitude = step * OFFSET_STEP * sign;
      const bend = { x: centre.x + nx * magnitude, y: centre.y + ny * magnitude };
      const points = [from, bend, to];
      if (countBlockers(points, true, blockers) === 0) return { points, rounded: true };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// (d) Orthogonal fallback
// ---------------------------------------------------------------------------

/**
 * When no arc clears, fall back to right angles: the two L shapes, then the
 * two Z shapes turning on the midline of the corridor between the endpoints.
 * The least-blocking candidate is returned even when none is clean, because a
 * tidy wrong route reads better than a diagonal through three boxes.
 */
export function orthogonalRoute(from: Point, to: Point, blockers: readonly Box[]): RepairedRoute {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const candidates: Point[][] = [
    [from, { x: to.x, y: from.y }, to],
    [from, { x: from.x, y: to.y }, to],
    [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to],
    [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to],
  ];
  let best = { points: candidates[0], blockers: Number.POSITIVE_INFINITY };
  for (const points of candidates) {
    const count = countBlockers(points, false, blockers);
    if (count === 0) return { points, rounded: false };
    if (count < best.blockers) best = { points, blockers: count };
  }
  return { points: best.points, rounded: false };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export type RouteRequest = {
  id: string;
  from: string;
  to: string;
  /** The layout's own route, if it produced one worth re-anchoring. */
  route?: Point[];
};

export type PlannedRoute = { id: string; points: Point[]; rounded: boolean };

export type RoutePlanOptions = {
  /** Snap corrections applied to each node, by node id. */
  snapDeltas?: ReadonlyMap<string, SnapDelta>;
  /**
   * Smallest bend offset an edge may use, by edge id. The repair loop raises
   * this for edges that are still in trouble after a pass, which is what
   * makes a second iteration produce a different answer from the first.
   */
  minSteps?: ReadonlyMap<string, number>;
};

export function planRoutes(
  nodes: ReadonlyMap<string, Box>,
  edges: readonly RouteRequest[],
  options: RoutePlanOptions = {},
): PlannedRoute[] {
  const ports = assignPorts(nodes, edges);
  return edges.map((edge) => {
    const assignment = ports.get(edge.id);
    const anchored = edge.route
      ? reanchorRoute(edge.route, options.snapDeltas?.get(edge.from), options.snapDeltas?.get(edge.to))
      : undefined;
    const start = assignment?.start ?? anchored?.[0] ?? boxCenter(nodes.get(edge.from)!);
    const end = assignment?.end ?? anchored?.[anchored.length - 1] ?? boxCenter(nodes.get(edge.to)!);
    const blockers = [...nodes.values()].filter((box) => box.id !== edge.from && box.id !== edge.to);
    const minStep = options.minSteps?.get(edge.id) ?? 1;
    const repaired = repairStraightRoute(start, end, blockers, minStep);
    if (repaired) return { id: edge.id, ...repaired };
    return { id: edge.id, ...orthogonalRoute(start, end, blockers) };
  });
}
