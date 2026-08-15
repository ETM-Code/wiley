import ELK from "elkjs/lib/elk.bundled";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import type { DiagramElementRole } from "../shared/diagram-stamp";
import {
  NODE_EMPHASES,
  NODE_ROLES,
  EDGE_ARROWS,
  EDGE_LINE_STYLES,
  EDGE_WEIGHTS,
  isHexColor,
  isNodeRole,
  resolveEdgeStyle,
  resolveNodeStyle,
  resolveTheme,
  type EdgeArrow,
  type EdgeLineStyle,
  type EdgeWeight,
  type NodeEmphasis,
  type NodeRole,
  type ThemeName,
} from "./diagram-theme";

import {
  MAX_ROUTE_REPAIR_ITERATIONS,
  PORT_SPACING,
  placeEdgeLabel,
  planRoutes,
  routeDefects,
  type Box as RouteBox,
  type Point as RoutePoint,
  type RouteRequest,
  type SnapDelta,
} from "./diagram-routes";

import {
  deriveDiagramId,
  edgeElementId,
  edgeKey,
  edgeLabelElementId,
  edgeOrdinals,
  nodeElementId,
  titleElementId,
} from "./diagram-spec";

type JsonObject = Record<string, unknown>;

export type GraphShape = "rectangle" | "diamond" | "ellipse" | "text";

export const GRAPH_SHAPES: readonly GraphShape[] = ["rectangle", "diamond", "ellipse", "text"];
export type GraphNode = {
  id: string;
  label: string;
  shape?: GraphShape;
  role?: NodeRole;
  emphasis?: NodeEmphasis;
  backgroundColor?: string;
  strokeColor?: string;
  rounded?: boolean;
};
export type GraphEdge = {
  from: string;
  to: string;
  label?: string;
  style?: EdgeLineStyle;
  weight?: EdgeWeight;
  /** A hex value or one of the node role names. */
  color?: string;
  arrow?: EdgeArrow;
};
export type DiagramDirection = "RIGHT" | "DOWN" | "LEFT" | "UP";

export const DIAGRAM_DIRECTIONS: readonly DiagramDirection[] = ["RIGHT", "DOWN", "LEFT", "UP"];

/**
 * Layers advance along one axis, so connectors always attach to the two
 * sides square to it: the vertical sides for RIGHT and LEFT, the horizontal
 * sides for DOWN and UP. Ports therefore spread along a node's height in the
 * first pair and along its width in the second.
 */
export function portsSpreadAlongWidth(direction: DiagramDirection): boolean {
  return direction === "DOWN" || direction === "UP";
}

/**
 * layered is the flow-chart engine and the safe default. tree lays out a
 * hierarchy, radial rings a hub, and force and stress place graphs with no
 * inherent direction at all.
 */
export type DiagramAlgorithm = "layered" | "tree" | "radial" | "force" | "stress";

export const DIAGRAM_ALGORITHMS: readonly DiagramAlgorithm[] = [
  "layered",
  "tree",
  "radial",
  "force",
  "stress",
];

/** What the request asked for and what it actually got. */
export type DiagramLayoutOutcome = {
  requested: DiagramAlgorithm;
  used: DiagramAlgorithm;
  /** Why the request was not honoured. */
  reason?: string;
  /** Set when the chosen algorithm has no notion of a flow direction. */
  ignoredDirection?: DiagramDirection;
};

export type DiagramLayoutOptions = {
  algorithm?: DiagramAlgorithm;
  direction?: DiagramDirection;
  nodeSpacing?: number;
  layerSpacing?: number;
};
export type LayoutParams = {
  title?: string;
  theme?: ThemeName;
  nodes: GraphNode[];
  edges: GraphEdge[];
  anchor?: string;
  anchorDirection?: "right" | "left" | "above" | "below";
  layout?: DiagramLayoutOptions;
};

export type { DiagramElementRole } from "../shared/diagram-stamp";

/**
 * What an emitted element is, semantically. Everything downstream (quality
 * evaluation, validation, scene summaries) classifies by this instead of
 * pattern-matching element ids.
 */
export type DiagramElementRoleEntry = {
  role: DiagramElementRole;
  /** Semantic node id for nodes, endpoint key for edges; absent for titles. */
  key?: string;
  edgeIndex?: number;
};

export interface DiagramPlan {
  skeletons: JsonObject[];
  nodeCount: number;
  edgeCount: number;
  edgeLabelCount: number;
  elementIdByNode: Map<string, string>;
  diagramId: string;
  roles: Map<string, DiagramElementRoleEntry>;
  /** The theme every derived colour in this plan came from. */
  theme: ThemeName;
  /**
   * Colours the request asked for by hand. Style checks accept these as
   * deliberate; anything else has to be theme-derived.
   */
  explicitColors: Set<string>;
  layout: DiagramLayoutOutcome;
}

export const MODEL_GRID_SIZE = 20;

const NODE_FONT_SIZE = 20;
const EDGE_LABEL_FONT_SIZE = 16;
// fontFamily 5 in Excalidraw's FONT_FAMILY map; the editor loads this face,
// so canvas measureText below measures the genuinely rendered font.
const DIAGRAM_FONT_CSS = "Excalifont";
// Fallback ratio for headless environments (tests) where no canvas 2D
// context exists and the real font cannot be measured.
const FALLBACK_CHAR_WIDTH_RATIO = 0.62;
const LINE_HEIGHT_RATIO = 1.3;
const NODE_PADDING_X = 48;
const NODE_PADDING_Y = 36;
const NODE_MIN_WIDTH = 160;
const NODE_MAX_WIDTH = 440;
const NODE_MIN_HEIGHT = 80;
const NODE_TEXT_WRAP_WIDTH = 280;
// Emoji, pictographs, and the symbol blocks above it render as a square tile
// roughly 1.2x the font size wide, nothing like an average Latin glyph.
export const WIDE_GLYPH_MIN_CODE_POINT = 0x1f000;
export const WIDE_GLYPH_ADVANCE_RATIO = 1.2;
const elk = new ELK();

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function snapModelCoordinate(value: unknown, fallback = 0): number {
  return Math.round(finiteNumber(value, fallback) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
}

export function snapModelSize(value: unknown, fallback: number): number {
  return Math.max(MODEL_GRID_SIZE, snapModelCoordinate(value, fallback));
}

function snapUpSize(value: number): number {
  return Math.max(MODEL_GRID_SIZE, Math.ceil(value / MODEL_GRID_SIZE) * MODEL_GRID_SIZE);
}

export function nodeToType(node: GraphNode): GraphShape {
  return node.shape ?? "rectangle";
}

let measuringContext: CanvasRenderingContext2D | null | undefined;

function fontMeasuringContext(): CanvasRenderingContext2D | null {
  if (measuringContext !== undefined) return measuringContext;
  measuringContext = typeof document !== "undefined"
    ? document.createElement("canvas").getContext("2d")
    : null;
  return measuringContext;
}

export type DiagramTextMeasurer = (text: string, fontSize: number, fontFamily: string) => number | null;

let measurerOverride: DiagramTextMeasurer | null = null;

/** Node test runs install a measurer parsed from the real font files. */
export function setDiagramTextMeasurer(measurer: DiagramTextMeasurer | null): void {
  measurerOverride = measurer;
}

/**
 * Measures the width the rendered font actually produces: an installed
 * measurer first (tests parse the shipped Excalifont), then the browser
 * canvas with the loaded face. The average-glyph estimate is a last resort
 * for environments with neither.
 */
export function measureText(
  text: string,
  fontSize: number,
  fontFamily = DIAGRAM_FONT_CSS,
): { width: number; height: number } {
  const height = fontSize * LINE_HEIGHT_RATIO;
  const overridden = measurerOverride?.(text, fontSize, fontFamily);
  if (typeof overridden === "number" && Number.isFinite(overridden) && overridden > 0) {
    return { width: overridden, height };
  }
  const context = fontMeasuringContext();
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`;
    const width = context.measureText(text).width;
    if (Number.isFinite(width) && width > 0) return { width, height };
  }
  return { width: Math.max(fontSize * FALLBACK_CHAR_WIDTH_RATIO, estimateWidth(text, fontSize)), height };
}

/**
 * Average-glyph estimate for environments with neither a real measurer nor a
 * canvas. Emoji are the one case where the average is badly wrong, so they
 * get their own square-tile advance.
 */
function estimateWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    width += codePoint >= WIDE_GLYPH_MIN_CODE_POINT
      ? fontSize * WIDE_GLYPH_ADVANCE_RATIO
      : fontSize * FALLBACK_CHAR_WIDTH_RATIO;
  }
  return width;
}

export function wrapLabel(
  label: string,
  fontSize = NODE_FONT_SIZE,
  maxWidth = NODE_TEXT_WRAP_WIDTH,
): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measureText(candidate, fontSize).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Excalidraw wraps bound text to the container's inscribed area, not its
 * bounding box: a diamond offers about half its width at the label band and
 * an ellipse about width/sqrt(2). Oversize those shapes accordingly.
 */
function shapeFactor(shape: GraphShape): number {
  if (shape === "diamond") return 2;
  if (shape === "ellipse") return Math.SQRT2;
  return 1;
}

/**
 * A text node is its own text: no border, no padding, no bound label. It is
 * laid out from the exact measured block so neighbours keep their distance
 * from the glyphs rather than from an invented box.
 */
export function textNodeLines(node: GraphNode): string[] {
  return wrapLabel(node.label, NODE_FONT_SIZE, NODE_TEXT_WRAP_WIDTH);
}

function textNodeDimensions(node: GraphNode): { width: number; height: number } {
  const lines = textNodeLines(node);
  const width = lines.reduce((max, line) => Math.max(max, measureText(line, NODE_FONT_SIZE).width), 1);
  return {
    width: Math.ceil(width),
    height: Math.ceil(lines.length * NODE_FONT_SIZE * LINE_HEIGHT_RATIO),
  };
}

export function nodeDimensions(
  node: GraphNode,
  portDemand = 0,
  direction: DiagramDirection = "RIGHT",
): { width: number; height: number } {
  if (nodeToType(node) === "text") return textNodeDimensions(node);
  const factor = shapeFactor(nodeToType(node));
  const lines = wrapLabel(node.label, NODE_FONT_SIZE, NODE_TEXT_WRAP_WIDTH / factor);
  const textWidth = lines.reduce((max, line) => Math.max(max, measureText(line, NODE_FONT_SIZE).width), 1);
  const textHeight = lines.length * NODE_FONT_SIZE * LINE_HEIGHT_RATIO;
  // The connector side needs room for every port to stay more than one grid
  // cell from its neighbour.
  const portSide = (portDemand + 1) * PORT_SPACING;
  const alongWidth = portsSpreadAlongWidth(direction);
  const width = Math.max(
    Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, textWidth * factor + NODE_PADDING_X)),
    alongWidth ? portSide : 0,
  );
  const height = Math.max(
    NODE_MIN_HEIGHT,
    textHeight * factor + NODE_PADDING_Y,
    alongWidth ? 0 : portSide,
  );
  return { width: snapUpSize(width), height: snapUpSize(height) };
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): void {
  if (value !== undefined && !(allowed as readonly string[]).includes(String(value))) {
    throw new Error(`Diagram ${what} must be one of ${allowed.join(", ")}`);
  }
}

function validateGraph(params: LayoutParams): void {
  if (!Array.isArray(params?.nodes) || params.nodes.length === 0) {
    throw new Error("layout-diagram requires at least one node");
  }
  const nodeIds = new Set<string>();
  for (const node of params.nodes) {
    if (!node?.id || !node.label || nodeIds.has(node.id)) {
      throw new Error("Diagram nodes require unique ids and non-empty labels");
    }
    if (node.shape && !(GRAPH_SHAPES as readonly string[]).includes(node.shape)) {
      throw new Error(`Diagram node ${node.id} has an unsupported shape`);
    }
    requireMember(node.role, NODE_ROLES, `node ${node.id} role`);
    requireMember(node.emphasis, NODE_EMPHASES, `node ${node.id} emphasis`);
    nodeIds.add(node.id);
  }
  requireMember(params.layout?.direction, DIAGRAM_DIRECTIONS, "layout direction");
  requireMember(params.layout?.algorithm, DIAGRAM_ALGORITHMS, "layout algorithm");
  for (const edge of params.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Diagram edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
    const where = `edge ${edge.from} -> ${edge.to}`;
    requireMember(edge.style, EDGE_LINE_STYLES, `${where} style`);
    requireMember(edge.weight, EDGE_WEIGHTS, `${where} weight`);
    requireMember(edge.arrow, EDGE_ARROWS, `${where} arrow`);
    if (edge.color !== undefined && !isNodeRole(edge.color) && !isHexColor(edge.color)) {
      throw new Error(`Diagram ${where} colour must be a hex value or a role name`);
    }
  }
}

type Point = { x: number; y: number };
type Size = { width: number; height: number };

function exitPoint(position: Point, size: Size, direction: DiagramDirection): Point {
  const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
  if (direction === "RIGHT") return { x: position.x + size.width, y: center.y };
  if (direction === "LEFT") return { x: position.x, y: center.y };
  if (direction === "DOWN") return { x: center.x, y: position.y + size.height };
  return { x: center.x, y: position.y };
}

function entryPoint(position: Point, size: Size, direction: DiagramDirection): Point {
  const opposite: Record<DiagramDirection, DiagramDirection> = {
    RIGHT: "LEFT",
    LEFT: "RIGHT",
    DOWN: "UP",
    UP: "DOWN",
  };
  return exitPoint(position, size, opposite[direction]);
}

function dedupePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.filter((point, index) => index === 0
    || point.x !== points[index - 1].x
    || point.y !== points[index - 1].y);
}

type EdgeGeometry = { points: RoutePoint[]; rounded: boolean; label?: RoutePoint };

type LayoutGeometry = {
  /** Snapped top-left corners in layout-local coordinates. */
  positions: Map<string, RoutePoint>;
  sizes: Map<string, { width: number; height: number }>;
  edges: EdgeGeometry[];
  outcome: DiagramLayoutOutcome;
};

type GeometryInput = {
  params: LayoutParams;
  edges: GraphEdge[];
  direction: DiagramDirection;
  sizes: Map<string, { width: number; height: number }>;
  nodeSpacing: number;
  layerSpacing: number;
};

function elkGraph(input: GeometryInput, layoutOptions: Record<string, string>): ElkNode {
  return {
    id: "root",
    layoutOptions,
    children: input.params.nodes.map((node) => ({
      id: node.id,
      width: input.sizes.get(node.id)?.width ?? NODE_MIN_WIDTH,
      height: input.sizes.get(node.id)?.height ?? NODE_MIN_HEIGHT,
    })),
    edges: input.edges.map((edge, index) => ({
      id: `edge-${index}`,
      sources: [edge.from],
      targets: [edge.to],
      ...(edge.label?.trim()
        ? {
            labels: [{
              text: edge.label.trim(),
              ...measureText(edge.label.trim(), EDGE_LABEL_FONT_SIZE),
            }],
          }
        : {}),
    })),
  };
}

function snappedPositions(result: ElkNode): Map<string, RoutePoint> {
  return new Map((result.children ?? []).map((node: ElkNode) => [node.id, {
    x: snapModelCoordinate(node.x),
    y: snapModelCoordinate(node.y),
  }]));
}

function elkSection(result: ElkNode, index: number) {
  const edge = ((result.edges ?? []) as ElkExtendedEdge[])
    .find((candidate) => candidate.id === `edge-${index}`);
  return { section: edge?.sections?.[0], label: edge?.labels?.[0] };
}

/**
 * The layered path, unchanged in behaviour: ELK routes orthogonally through
 * channels it reserved itself, and those routes stay exactly where it put
 * them. Snapping a 16px channel onto the 20px grid is what merges two
 * arrows into one line.
 */
async function layeredGeometry(input: GeometryInput, outcome: DiagramLayoutOutcome): Promise<LayoutGeometry> {
  const result = await elk.layout(elkGraph(input, {
    "elk.algorithm": "layered",
    "elk.direction": input.direction,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": String(input.nodeSpacing),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(input.layerSpacing),
    // Channel spacing stays above one grid cell so snapping can never merge
    // two parallel routes or a route into a node border.
    "elk.spacing.edgeNode": "40",
    "elk.spacing.edgeEdge": "24",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
    "elk.spacing.edgeLabel": "10",
  }));
  const positions = snappedPositions(result);
  return {
    positions,
    sizes: input.sizes,
    outcome,
    edges: input.edges.map((edge, index) => {
      const { section, label } = elkSection(result, index);
      const fromPosition = positions.get(edge.from) ?? { x: 0, y: 0 };
      const toPosition = positions.get(edge.to) ?? { x: 0, y: 0 };
      const fromSize = input.sizes.get(edge.from) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      const toSize = input.sizes.get(edge.to) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      // ELK routes to distributed border points; fall back to the midpoints
      // of the two sides this direction actually connects, only if a section
      // is missing entirely.
      const points = dedupePoints([
        section?.startPoint ?? exitPoint(fromPosition, fromSize, input.direction),
        ...(section?.bendPoints ?? []),
        section?.endPoint ?? entryPoint(toPosition, toSize, input.direction),
      ]);
      return {
        points,
        rounded: false,
        ...(label ? { label: { x: finiteNumber(label.x), y: finiteNumber(label.y) } } : {}),
      };
    }),
  };
}

const NON_LAYERED_OPTIONS: Record<Exclude<DiagramAlgorithm, "layered">, Record<string, string>> = {
  tree: { "elk.algorithm": "mrtree" },
  radial: { "elk.algorithm": "radial" },
  // A fixed seed is the whole reason these two are usable: without it the
  // same graph lands somewhere different on every call.
  force: { "elk.algorithm": "force", "elk.randomSeed": "1" },
  stress: { "elk.algorithm": "stress", "elk.randomSeed": "1" },
};

/** Only the tree algorithm reads a flow direction; the rest are undirected. */
export function algorithmUsesDirection(algorithm: DiagramAlgorithm): boolean {
  return algorithm === "layered" || algorithm === "tree";
}

/** Enough room after scaling that snapping to the grid cannot close the gap. */
const OVERLAP_MARGIN = 40;
const MAX_SPREAD = 8;

/**
 * force, stress, and radial place nodes as points and do not care that a node
 * is a box, so boxes end up on top of each other. Scaling every centre away
 * from the centroid separates them without distorting the shape the algorithm
 * found, and one pass is enough: each pair's requirement is a fixed multiple
 * of its own centre distance.
 */
function spreadFactor(
  centers: ReadonlyMap<string, RoutePoint>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): number {
  const ids = [...centers.keys()];
  let scale = 1;
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const first = centers.get(ids[a])!;
      const second = centers.get(ids[b])!;
      const firstSize = sizes.get(ids[a]) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      const secondSize = sizes.get(ids[b]) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      const dx = Math.abs(first.x - second.x);
      const dy = Math.abs(first.y - second.y);
      const needX = (firstSize.width + secondSize.width) / 2 + OVERLAP_MARGIN;
      const needY = (firstSize.height + secondSize.height) / 2 + OVERLAP_MARGIN;
      // Separating on either axis is enough, so the cheaper one wins.
      const required = Math.min(
        dx > 1e-6 ? needX / dx : Number.POSITIVE_INFINITY,
        dy > 1e-6 ? needY / dy : Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(required)) scale = Math.max(scale, required);
    }
  }
  return Math.min(MAX_SPREAD, scale);
}

function boxesTouch(a: RouteBox, b: RouteBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** ELK reports near-duplicate bendpoints on mrtree routes; collapse them. */
function dedupeNearPoints(points: readonly RoutePoint[], tolerance = 2): RoutePoint[] {
  return points.filter((point, index) => index === 0
    || Math.abs(point.x - points[index - 1].x) > tolerance
    || Math.abs(point.y - points[index - 1].y) > tolerance);
}

/**
 * Everything except layered. ELK places these graphs well and routes them
 * badly, so the routes are thrown away and rebuilt: real ports, a bend around
 * whatever is in the way, and up to three evaluate/repair rounds that push
 * still-guilty edges onto wider arcs. Returns null when three rounds are not
 * enough, which is the caller's cue to fall back to layered.
 */
async function nonLayeredGeometry(
  input: GeometryInput,
  algorithm: Exclude<DiagramAlgorithm, "layered">,
): Promise<{ geometry: LayoutGeometry } | { reason: string }> {
  let result: ElkNode;
  try {
    result = await elk.layout(elkGraph(input, {
      ...NON_LAYERED_OPTIONS[algorithm],
      ...(algorithmUsesDirection(algorithm) ? { "elk.direction": input.direction } : {}),
      "elk.spacing.nodeNode": String(input.nodeSpacing),
      "elk.spacing.edgeNode": "40",
      "elk.spacing.edgeEdge": "24",
      "elk.spacing.edgeLabel": "10",
    }));
  } catch {
    // radial rejects anything that is not a tree, and the others can refuse a
    // graph outright. That is a fallback, not a failed request.
    return { reason: `${algorithm} could not lay this graph out` };
  }

  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const rawCenters = new Map<string, RoutePoint>((result.children ?? []).map((node: ElkNode) => {
    const size = sizeOf(node.id);
    return [node.id, {
      x: finiteNumber(node.x) + size.width / 2,
      y: finiteNumber(node.y) + size.height / 2,
    }];
  }));
  const scale = spreadFactor(rawCenters, input.sizes);
  const anchor = [...rawCenters.values()].reduce(
    (total, point) => ({ x: total.x + point.x / rawCenters.size, y: total.y + point.y / rawCenters.size }),
    { x: 0, y: 0 },
  );
  const positions = new Map<string, RoutePoint>([...rawCenters].map(([id, center]) => {
    const size = sizeOf(id);
    return [id, {
      x: snapModelCoordinate(anchor.x + (center.x - anchor.x) * scale - size.width / 2),
      y: snapModelCoordinate(anchor.y + (center.y - anchor.y) * scale - size.height / 2),
    }];
  }));
  const snapDeltas = new Map<string, SnapDelta>();
  for (const node of result.children ?? []) {
    const snapped = positions.get(node.id);
    if (!snapped) continue;
    snapDeltas.set(node.id, { dx: snapped.x - finiteNumber(node.x), dy: snapped.y - finiteNumber(node.y) });
  }
  const boxes = new Map<string, RouteBox>(input.params.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    return [node.id, { id: node.id, x: position.x, y: position.y, ...sizeOf(node.id) }];
  }));
  const placedBoxes = [...boxes.values()];
  for (let a = 0; a < placedBoxes.length; a++) {
    for (let b = a + 1; b < placedBoxes.length; b++) {
      if (boxesTouch(placedBoxes[a], placedBoxes[b])) {
        return { reason: `${algorithm} left nodes overlapping even after spreading` };
      }
    }
  }
  const requests: RouteRequest[] = input.edges.map((edge, index) => {
    const { section } = elkSection(result, index);
    const raw = section
      ? dedupeNearPoints([section.startPoint, ...(section.bendPoints ?? []), section.endPoint])
      : undefined;
    return { id: `edge-${index}`, from: edge.from, to: edge.to, ...(raw ? { route: raw } : {}) };
  });
  const attachments = new Map(requests.map((request) => [request.id, { from: request.from, to: request.to }]));

  const minSteps = new Map<string, number>();
  let routes = planRoutes(boxes, requests, { snapDeltas, minSteps });
  for (let round = 0; round < MAX_ROUTE_REPAIR_ITERATIONS; round++) {
    const guilty = routeDefects(boxes, routes, attachments);
    if (guilty.size === 0) break;
    if (round === MAX_ROUTE_REPAIR_ITERATIONS - 1) {
      return { reason: `${algorithm} routes still crossed nodes after ${MAX_ROUTE_REPAIR_ITERATIONS} repair rounds` };
    }
    // Push each still-guilty edge onto a wider arc so the next round cannot
    // reproduce the answer that failed.
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(boxes, requests, { snapDeltas, minSteps });
  }

  const placed: RouteBox[] = [...boxes.values()];
  const edgeGeometry: EdgeGeometry[] = input.edges.map((edge, index) => {
    const route = routes[index];
    const text = edge.label?.trim();
    if (!text) return { points: route.points, rounded: route.rounded };
    // ELK hands back (0,0) for every edge label under mrtree and radial, so
    // the label is placed against the route we actually drew.
    const size = measureText(text, EDGE_LABEL_FONT_SIZE);
    const label = placeEdgeLabel(route.points, size, placed);
    placed.push({ id: `label-${index}`, x: label.x, y: label.y, ...size });
    return { points: route.points, rounded: route.rounded, label };
  });

  return {
    geometry: {
      positions,
      sizes: input.sizes,
      edges: edgeGeometry,
      outcome: {
        requested: algorithm,
        used: algorithm,
        ...(algorithmUsesDirection(algorithm) ? {} : { ignoredDirection: input.direction }),
      },
    },
  };
}

export async function planDiagramLayout(
  params: LayoutParams,
  origin: { x: number; y: number },
  diagramId = deriveDiagramId(params),
): Promise<DiagramPlan> {
  validateGraph(params);
  const edges = params.edges ?? [];
  const requested = params.layout?.algorithm ?? "layered";
  const direction = params.layout?.direction ?? "RIGHT";
  const nodeSpacing = Math.min(240, Math.max(60, snapModelCoordinate(params.layout?.nodeSpacing, 80)));
  const layerSpacing = Math.min(360, Math.max(80, snapModelCoordinate(params.layout?.layerSpacing, 140)));

  const degreeIn = new Map<string, number>();
  const degreeOut = new Map<string, number>();
  for (const edge of edges) {
    degreeOut.set(edge.from, (degreeOut.get(edge.from) ?? 0) + 1);
    degreeIn.set(edge.to, (degreeIn.get(edge.to) ?? 0) + 1);
  }
  const sizes = new Map(params.nodes.map((node) => [
    node.id,
    nodeDimensions(node, Math.max(degreeIn.get(node.id) ?? 0, degreeOut.get(node.id) ?? 0), direction),
  ]));
  const input: GeometryInput = { params, edges, direction, sizes, nodeSpacing, layerSpacing };

  let geometry: LayoutGeometry | null = null;
  let reason: string | undefined;
  if (requested !== "layered") {
    const attempt = await nonLayeredGeometry(input, requested);
    if ("geometry" in attempt) geometry = attempt.geometry;
    else reason = attempt.reason;
  }
  geometry ??= await layeredGeometry(input, {
    requested,
    used: "layered",
    ...(reason ? { reason } : {}),
  });

  return assemblePlan(params, edges, geometry, origin, diagramId);
}

function assemblePlan(
  params: LayoutParams,
  edges: GraphEdge[],
  geometry: LayoutGeometry,
  origin: { x: number; y: number },
  diagramId: string,
): DiagramPlan {
  const ordinals = edgeOrdinals(edges);
  const edgeKeys = edges.map((edge, index) => edgeKey(edge, ordinals[index]));
  const theme = resolveTheme(params.theme);
  const explicitColors = new Set<string>();
  for (const node of params.nodes) {
    if (isHexColor(node.backgroundColor)) explicitColors.add(node.backgroundColor.trim());
    if (isHexColor(node.strokeColor)) explicitColors.add(node.strokeColor.trim());
  }
  for (const edge of edges) {
    if (isHexColor(edge.color)) explicitColors.add(edge.color.trim());
  }
  const elementIdByNode = new Map(
    params.nodes.map((node) => [node.id, nodeElementId(diagramId, node.id)]),
  );
  const roles = new Map<string, DiagramElementRoleEntry>();
  // Every element carries its own identity, so a later call can find, restyle,
  // or replace exactly this diagram's parts without re-reading the scene.
  const stamp = (role: DiagramElementRole, key?: string) => ({
    customData: { wiley: { diagram: diagramId, role, theme: theme.name, ...(key ? { key } : {}) } },
  });

  const nodeSkeletons: JsonObject[] = params.nodes.map((node) => {
    const position = geometry.positions.get(node.id) ?? { x: 0, y: 0 };
    const size = geometry.sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const type = nodeToType(node);
    const id = elementIdByNode.get(node.id)!;
    const style = resolveNodeStyle(theme, node.role, node.emphasis, {
      backgroundColor: node.backgroundColor,
      strokeColor: node.strokeColor,
    });
    roles.set(id, { role: "node", key: node.id });
    const x = snapModelCoordinate(origin.x + position.x);
    const y = snapModelCoordinate(origin.y + position.y);
    if (type === "text") {
      return {
        id,
        type,
        ...stamp("node", node.id),
        x,
        y,
        width: size.width,
        height: size.height,
        text: textNodeLines(node).join("\n"),
        fontSize: NODE_FONT_SIZE,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        opacity: style.opacity,
        strokeColor: style.strokeColor,
        backgroundColor: node.backgroundColor ?? "transparent",
      };
    }
    return {
      id,
      type,
      ...stamp("node", node.id),
      x,
      y,
      width: size.width,
      height: size.height,
      strokeColor: style.strokeColor,
      backgroundColor: style.backgroundColor,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      ...(style.backgroundColor !== "transparent" ? { fillStyle: style.fillStyle } : {}),
      ...(type === "rectangle" && node.rounded ? { roundness: { type: 3 } } : {}),
      label: { text: node.label, strokeColor: style.labelColor },
    };
  });

  const edgeSkeletons: JsonObject[] = [];
  const edgeLabelSkeletons: JsonObject[] = [];
  for (const [index, edge] of edges.entries()) {
    const routed = geometry.edges[index];
    const absoluteRoute = dedupePoints(routed.points.map((point) => ({
      x: origin.x + point.x,
      y: origin.y + point.y,
    })));
    const routeOrigin = absoluteRoute[0];
    const key = edgeKeys[index];
    const edgeId = edgeElementId(diagramId, key);
    const edgeStyle = resolveEdgeStyle(theme, edge);
    roles.set(edgeId, { role: "edge", key, edgeIndex: index });
    edgeSkeletons.push({
      id: edgeId,
      type: "arrow",
      ...stamp("edge", key),
      x: routeOrigin.x,
      y: routeOrigin.y,
      points: absoluteRoute.map((point) => [point.x - routeOrigin.x, point.y - routeOrigin.y]),
      start: { id: elementIdByNode.get(edge.from) },
      end: { id: elementIdByNode.get(edge.to) },
      strokeColor: edgeStyle.strokeColor,
      strokeStyle: edgeStyle.strokeStyle,
      strokeWidth: edgeStyle.strokeWidth,
      opacity: edgeStyle.opacity,
      startArrowhead: edgeStyle.startArrowhead,
      endArrowhead: edgeStyle.endArrowhead,
      // A repaired route bends once; the curve reads as a deliberate detour
      // rather than a mistake, and the quality checks account for it.
      ...(routed.rounded ? { roundness: { type: 2 } } : {}),
    });
    const text = edge.label?.trim();
    if (text && routed.label) {
      const size = measureText(text, EDGE_LABEL_FONT_SIZE);
      const edgeLabelId = edgeLabelElementId(diagramId, key);
      roles.set(edgeLabelId, { role: "edgeLabel", key, edgeIndex: index });
      edgeLabelSkeletons.push({
        id: edgeLabelId,
        type: "text",
        ...stamp("edgeLabel", key),
        x: origin.x + routed.label.x,
        y: origin.y + routed.label.y,
        width: size.width,
        height: size.height,
        text,
        fontSize: EDGE_LABEL_FONT_SIZE,
        fontFamily: 5,
        strokeColor: edgeStyle.labelColor,
        backgroundColor: "transparent",
      });
    }
  }

  const title = params.title?.trim();
  // Top-left, its own measured width, and a full band of headroom: a title
  // centered across the graph sits exactly where inbound arrows and
  // neighboring clusters land.
  const titleSize = title ? measureText(title, 24) : { width: 0, height: 0 };
  const titleId = titleElementId(diagramId);
  if (title) roles.set(titleId, { role: "title" });
  const skeletons: JsonObject[] = [
    ...(title ? [{
      id: titleId,
      type: "text",
      ...stamp("title"),
      x: origin.x,
      y: snapModelCoordinate(origin.y - 100),
      width: titleSize.width,
      height: 40,
      text: title,
      fontSize: 24,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "middle",
      strokeColor: theme.titleColor,
      backgroundColor: "transparent",
    }] : []),
    ...nodeSkeletons,
    ...edgeSkeletons,
    ...edgeLabelSkeletons,
  ];

  return {
    skeletons,
    nodeCount: params.nodes.length,
    edgeCount: edges.length,
    edgeLabelCount: edgeLabelSkeletons.length,
    elementIdByNode,
    diagramId,
    roles,
    theme: theme.name,
    explicitColors,
    layout: geometry.outcome,
  };
}

export interface PlanBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function planBounds(plan: DiagramPlan): PlanBounds {
  const bounds: PlanBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  const include = (x: number, y: number) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  for (const skeleton of plan.skeletons) {
    const x = finiteNumber(skeleton.x);
    const y = finiteNumber(skeleton.y);
    if (skeleton.type === "arrow" && Array.isArray(skeleton.points)) {
      for (const point of skeleton.points as Array<[number, number]>) {
        include(x + finiteNumber(point[0]), y + finiteNumber(point[1]));
      }
    } else {
      include(x, y);
      include(x + finiteNumber(skeleton.width), y + finiteNumber(skeleton.height));
    }
  }
  if (!Number.isFinite(bounds.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return bounds;
}

/** Shifts a plan wholesale; arrow points are relative and move with x/y. */
export function translatePlan(plan: DiagramPlan, dx: number, dy: number): void {
  for (const skeleton of plan.skeletons) {
    if (typeof skeleton.x === "number") skeleton.x += dx;
    if (typeof skeleton.y === "number") skeleton.y += dy;
  }
}
