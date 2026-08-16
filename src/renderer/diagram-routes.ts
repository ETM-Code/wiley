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

/** Two runs closer in angle than this read as the same line. */
export const PARALLEL_ANGLE_DEGREES = 5;
/** How near two parallel runs have to be before they visually merge. */
export const PARALLEL_SEPARATION = 3;
/** Shorter shared runs than this are a crossing, not a doubled line. */
export const MIN_PARALLEL_OVERLAP = 10;

/**
 * Whether two runs are close enough to parallel, close enough together, and
 * overlapping for long enough that they draw as one thick line. Works at any
 * angle, so diagonal routes from the non-layered algorithms are held to the
 * same standard as orthogonal ones.
 */
export function segmentsVisuallyMerge(a: Segment, b: Segment): boolean {
  const ax = a.x2 - a.x1;
  const ay = a.y2 - a.y1;
  const bx = b.x2 - b.x1;
  const by = b.y2 - b.y1;
  const aLength = Math.hypot(ax, ay);
  const bLength = Math.hypot(bx, by);
  if (aLength < 1e-6 || bLength < 1e-6) return false;
  const cosine = (ax * bx + ay * by) / (aLength * bLength);
  const degrees = (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
  if (degrees >= PARALLEL_ANGLE_DEGREES && degrees <= 180 - PARALLEL_ANGLE_DEGREES) return false;

  const ux = ax / aLength;
  const uy = ay / aLength;
  const project = (point: Point) => (point.x - a.x1) * ux + (point.y - a.y1) * uy;
  const offset = (point: Point) => (point.x - a.x1) * -uy + (point.y - a.y1) * ux;
  const first = { x: b.x1, y: b.y1 };
  const second = { x: b.x2, y: b.y2 };
  const t1 = project(first);
  const t2 = project(second);
  const start = Math.max(0, Math.min(t1, t2));
  const end = Math.min(aLength, Math.max(t1, t2));
  if (end - start <= MIN_PARALLEL_OVERLAP) return false;

  // Measure separation in the middle of the shared run: at a near-parallel
  // angle the ends can drift apart while the visible overlap sits on top of
  // the other line.
  const centre = (start + end) / 2;
  const span = t2 - t1;
  const ratio = Math.abs(span) < 1e-6 ? 0 : Math.min(1, Math.max(0, (centre - t1) / span));
  const distance = Math.abs(offset(first) + ratio * (offset(second) - offset(first)));
  return distance < PARALLEL_SEPARATION;
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

/**
 * Where the ray from a box's centre towards a point leaves the box.
 *
 * A ring of spokes reads as a ring only when each one meets the hub on its own
 * bearing. Bucketing them onto four sides and spacing them evenly within each
 * side instead makes the fan bunch wherever the bucket boundaries happened to
 * fall, and the drawing stops looking radial.
 */
export function borderPoint(box: Box, target: Point): Point {
  const centre = boxCenter(box);
  const dx = target.x - centre.x;
  const dy = target.y - centre.y;
  const alongX = Math.abs(dx) < 1e-9 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx);
  const alongY = Math.abs(dy) < 1e-9 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy);
  const reach = Math.min(alongX, alongY);
  if (!Number.isFinite(reach)) return centre;
  return { x: centre.x + dx * reach, y: centre.y + dy * reach };
}

/** The outlines a node can be drawn with, as far as a connector is concerned. */
export type Outline = "rectangle" | "diamond" | "ellipse";

/**
 * How far along `direction` from `at` the box's outline lies, taking the
 * nearest crossing in either direction. Returns null when the line misses the
 * shape entirely, which a port on the shape's own box never does.
 */
function outlineReach(box: Box, outline: Outline, at: Point, direction: Point): number | null {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const a = box.width / 2;
  const b = box.height / 2;
  const px = at.x - cx;
  const py = at.y - cy;
  const nearest = (values: number[]) => (values.length === 0
    ? null
    : values.reduce((best, value) => (Math.abs(value) < Math.abs(best) ? value : best)));

  if (outline === "ellipse") {
    if (a <= 0 || b <= 0) return null;
    const qa = (direction.x / a) ** 2 + (direction.y / b) ** 2;
    const qb = 2 * ((px * direction.x) / a ** 2 + (py * direction.y) / b ** 2);
    const qc = (px / a) ** 2 + (py / b) ** 2 - 1;
    if (Math.abs(qa) < 1e-12) return null;
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    return nearest([(-qb + root) / (2 * qa), (-qb - root) / (2 * qa)]);
  }

  // Both remaining outlines are a closed run of straight edges: the four
  // corners for a rectangle, the four side midpoints for a diamond.
  const corners: Point[] = outline === "diamond"
    ? [{ x: cx, y: box.y }, { x: box.x + box.width, y: cy }, { x: cx, y: box.y + box.height }, { x: box.x, y: cy }]
    : [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ];
  const hits: number[] = [];
  for (let index = 0; index < corners.length; index++) {
    const from = corners[index];
    const to = corners[(index + 1) % corners.length];
    const ex = to.x - from.x;
    const ey = to.y - from.y;
    const denominator = direction.x * ey - direction.y * ex;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = ((from.x - at.x) * ey - (from.y - at.y) * ex) / denominator;
    const s = ((from.x - at.x) * direction.y - (from.y - at.y) * direction.x) / denominator;
    if (s >= -1e-9 && s <= 1 + 1e-9) hits.push(t);
  }
  return nearest(hits);
}

/**
 * Moves a connector endpoint from a node's bounding box onto the shape the
 * node is actually drawn as, keeping whatever gap it had from the box.
 *
 * A port halfway along the top of a diamond's box is nowhere near the diamond:
 * the arrowhead ends up floating in the corner beside the shape with nothing
 * under it, which is the single thing that makes an otherwise tidy decision
 * node look broken.
 */
export function meetOutline(box: Box, outline: Outline, at: Point, neighbour: Point): Point {
  if (outline === "rectangle") return at;
  const dx = at.x - neighbour.x;
  const dy = at.y - neighbour.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return at;
  const direction = { x: dx / length, y: dy / length };
  const shape = outlineReach(box, outline, at, direction);
  const bounding = outlineReach(box, "rectangle", at, direction);
  if (shape === null || bounding === null) return at;
  const shift = shape - bounding;
  // A correction longer than the shape itself means the geometry is not what
  // this was written for; leave the endpoint where the layout put it.
  if (Math.abs(shift) > Math.hypot(box.width, box.height)) return at;
  return { x: at.x + direction.x * shift, y: at.y + direction.y * shift };
}

type PortRequest = { key: string; nodeId: string; side: Side; target: Point };

export type PortOptions = {
  /** Attach on the bearing to the other node rather than on a side slot. */
  radial?: boolean;
};

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
  edges: ReadonlyArray<{ id: string; from: string; to: string; sides?: { from: Side; to: Side } }>,
  options: PortOptions = {},
): Map<string, { start: Point; end: Point }> {
  const requests = new Map<string, PortRequest[]>();
  const points = new Map<string, Point>();
  const request = (key: string, nodeId: string, otherId: string, fallbackSide: Side, forced?: Side) => {
    const box = nodes.get(nodeId);
    const other = nodes.get(otherId);
    if (!box) return;
    if (options.radial && other && otherId !== nodeId) {
      points.set(key, borderPoint(box, boxCenter(other)));
      return;
    }
    // A self-edge has no direction to read, so it takes fixed opposite sides.
    const side = forced ?? (!other || otherId === nodeId ? fallbackSide : chooseSide(box, boxCenter(other)));
    const bucket = `${nodeId}|${side}`;
    const list = requests.get(bucket) ?? [];
    list.push({ key, nodeId, side, target: other ? boxCenter(other) : boxCenter(box) });
    requests.set(bucket, list);
  };
  for (const edge of edges) {
    request(`${edge.id}|start`, edge.from, edge.to, "right", edge.sides?.from);
    request(`${edge.id}|end`, edge.to, edge.from, "left", edge.sides?.to);
  }

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

/**
 * The connector a hierarchy is drawn with: out of the parent along the flow
 * axis, across the gap between the two rows, then square onto the child's own
 * side.
 *
 * Naming the sides is not enough on its own. A straight line from the middle
 * of a parent's bottom to the middle of a child's top still arrives at
 * whatever angle the columns happen to give, and on a wide chart that angle is
 * shallow enough that the arrowhead reads as pointing into the child's corner
 * rather than down onto its top. Turning in the gap makes every arrival square
 * to the side it lands on, which is what makes a tree read as a tree.
 */
export function flowRoute(
  from: Point,
  to: Point,
  sides: { from: Side; to: Side },
  blockers: readonly Box[],
): RepairedRoute | null {
  const alongY = sides.from === "top" || sides.from === "bottom";
  const offset = alongY ? to.x - from.x : to.y - from.y;
  if (Math.abs(offset) < 1) {
    const points = [from, to];
    return countBlockers(points, false, blockers) === 0 ? { points, rounded: false } : null;
  }
  const turn = alongY ? (from.y + to.y) / 2 : (from.x + to.x) / 2;
  const points = alongY
    ? [from, { x: from.x, y: turn }, { x: to.x, y: turn }, to]
    : [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to];
  return countBlockers(points, true, blockers) === 0 ? { points, rounded: true } : null;
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

/**
 * The two defects the repair loop can actually act on: a route crossing a
 * node it does not belong to, and two routes drawing as one line. Everything
 * else in the quality report is a layout problem, not a routing one.
 */
export function routeDefects(
  nodes: ReadonlyMap<string, Box>,
  routes: readonly PlannedRoute[],
  attachments: ReadonlyMap<string, { from: string; to: string }>,
): Set<string> {
  const guilty = new Set<string>();
  for (const route of routes) {
    const ends = attachments.get(route.id);
    const geometry = routeGeometry(route.points, route.rounded);
    for (const box of nodes.values()) {
      if (box.id === ends?.from || box.id === ends?.to) continue;
      if (geometryIntersectsBox(geometry, box)) guilty.add(route.id);
    }
  }
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const first = pointsToSegments(routes[a].points);
      const second = pointsToSegments(routes[b].points);
      if (first.some((one) => second.some((other) => segmentsVisuallyMerge(one, other)))) {
        guilty.add(routes[a].id);
        guilty.add(routes[b].id);
      }
    }
  }
  return guilty;
}

/**
 * Where an edge label goes when the layout engine refuses to say. ELK's
 * mrtree and radial algorithms return every edge label at the origin, so the
 * label has to be placed against the route we ended up drawing.
 *
 * Candidates ring the route's midpoint in a fixed order, near before far, and
 * the first one clear of every obstacle wins. When the midpoint's ring is
 * blocked the search slides along the route the way a person would, and if
 * every spot is blocked the least covered one is used: a label grazing a line
 * still beats one parked squarely on a node, which is what taking the first
 * candidate blind used to do.
 */
/** The point a given fraction of the way along a polyline. */
function pointAlong(points: readonly Point[], at: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const segments = pointsToSegments(points);
  const lengths = segments.map((segment) => Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return points[0];
  let remaining = total * at;
  for (const [index, segment] of segments.entries()) {
    if (remaining > lengths[index]) {
      remaining -= lengths[index];
      continue;
    }
    const ratio = lengths[index] === 0 ? 0 : remaining / lengths[index];
    return {
      x: segment.x1 + (segment.x2 - segment.x1) * ratio,
      y: segment.y1 + (segment.y2 - segment.y1) * ratio,
    };
  }
  return points[points.length - 1];
}

export function placeEdgeLabel(
  points: readonly Point[],
  size: { width: number; height: number },
  obstacles: readonly Box[],
): Point {
  const anchor = points.length === 0
    ? { x: 0, y: 0 }
    : points.length % 2 === 1
      ? points[(points.length - 1) / 2]
      : midpoint(points[points.length / 2 - 1], points[points.length / 2]);
  const gap = 8;
  const candidates: Point[] = [];
  for (const along of [anchor, ...[0.3, 0.7, 0.15, 0.85].map((at) => pointAlong(points, at))]) {
    for (const scale of [1, 2, 3, 4]) {
      for (const offset of [
        { x: 0, y: -(size.height / 2 + gap) * scale },
        { x: 0, y: (size.height / 2 + gap) * scale },
        { x: (size.width / 2 + gap) * scale, y: 0 },
        { x: -(size.width / 2 + gap) * scale, y: 0 },
      ]) {
        candidates.push({
          x: along.x + offset.x - size.width / 2,
          y: along.y + offset.y - size.height / 2,
        });
      }
    }
  }
  let bestCandidate = candidates[0];
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const box: Box = { id: "label", ...candidate, width: size.width, height: size.height };
    let overlap = 0;
    for (const other of obstacles) {
      const across = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
      const down = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
      if (across > 0 && down > 0) overlap += across * down;
    }
    if (overlap === 0) return candidate;
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}

export type RouteRequest = {
  id: string;
  from: string;
  to: string;
  /**
   * The sides the connector must leave and arrive on, when the caller knows
   * the flow. A hierarchy reads as one because every child is entered from
   * the parent's side of it; letting each edge pick the nearest border turns
   * the same drawing into a web of lateral links.
   */
  sides?: { from: Side; to: Side };
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
  /** Attach every endpoint on its own bearing; see borderPoint. */
  radialPorts?: boolean;
};

export function planRoutes(
  nodes: ReadonlyMap<string, Box>,
  edges: readonly RouteRequest[],
  options: RoutePlanOptions = {},
): PlannedRoute[] {
  const ports = assignPorts(nodes, edges, { radial: options.radialPorts });
  return edges.map((edge) => {
    const assignment = ports.get(edge.id);
    const anchored = edge.route
      ? reanchorRoute(edge.route, options.snapDeltas?.get(edge.from), options.snapDeltas?.get(edge.to))
      : undefined;
    const fromBox = nodes.get(edge.from);
    const toBox = nodes.get(edge.to);
    const start = assignment?.start ?? anchored?.[0] ?? (fromBox ? boxCenter(fromBox) : { x: 0, y: 0 });
    const end = assignment?.end ?? anchored?.[anchored.length - 1] ?? (toBox ? boxCenter(toBox) : { x: 0, y: 0 });
    const blockers = [...nodes.values()].filter((box) => box.id !== edge.from && box.id !== edge.to);
    const minStep = options.minSteps?.get(edge.id) ?? 1;
    // A flow that named its sides gets the turned connector first. The repair
    // loop raises minStep on an edge that is still in trouble, and that is the
    // signal to stop insisting on the tidy shape and go looking for any shape.
    if (edge.sides && minStep <= 1) {
      const flow = flowRoute(start, end, edge.sides, blockers);
      if (flow) return { id: edge.id, ...flow };
    }
    const repaired = repairStraightRoute(start, end, blockers, minStep);
    if (repaired) return { id: edge.id, ...repaired };
    return { id: edge.id, ...orthogonalRoute(start, end, blockers) };
  });
}
