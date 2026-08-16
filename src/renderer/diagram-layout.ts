import ELK from "elkjs/lib/elk.bundled";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import {
  DIAGRAM_CONTAINER_RENDERS,
  DIAGRAM_EDGE_LABEL_MODES,
  type DiagramContainerRender,
  type DiagramEdgeLabelMode,
  type DiagramElementRole,
} from "../shared/diagram-stamp";
import { resolveAbsolute } from "./diagram-elk";
import {
  NODE_EMPHASES,
  NODE_ROLES,
  EDGE_ARROWS,
  EDGE_LINE_STYLES,
  EDGE_WEIGHTS,
  isHexColor,
  isNodeRole,
  resolveContainerTint,
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
  geometryIntersectsBox,
  meetOutline,
  placeEdgeLabel,
  type Side,
  routeGeometry,
  planRoutes,
  routeDefects,
  type Box as RouteBox,
  type Point as RoutePoint,
  type RouteRequest,
  type SnapDelta,
} from "./diagram-routes";

import {
  containerElementId,
  containerGroupId,
  containerLabelElementId,
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
  /** The container this node is a member of. */
  container?: string;
  /**
   * Set to "human" when this node stands for an element the person drew. Such
   * a node is never emitted: it is already on the board, and the layout only
   * treats its box as occupied. See canvas/human-merge.
   */
  origin?: "human";
  /** The real element a human-origin node stands for. */
  elementId?: string;
  /**
   * An exact box to lay the node out at, instead of one measured from its
   * label. Tidy mode uses it to rearrange the person's own shapes without
   * resizing them.
   */
  size?: { width: number; height: number };
};

export type ContainerRender = DiagramContainerRender;

export const CONTAINER_RENDERS = DIAGRAM_CONTAINER_RENDERS;

/**
 * A labelled region the layout keeps its members inside. `group` draws a
 * tinted rounded rectangle behind its members and ties them into one
 * Excalidraw group; `frame` emits a real Excalidraw frame, which cannot nest
 * and so is only allowed at the top level.
 */
export type GraphContainer = {
  id: string;
  label?: string;
  parent?: string;
  role?: NodeRole;
  render?: ContainerRender;
};
export type EdgeLabelMode = DiagramEdgeLabelMode;

export const EDGE_LABEL_MODES = DIAGRAM_EDGE_LABEL_MODES;

export type GraphEdge = {
  from: string;
  to: string;
  label?: string;
  style?: EdgeLineStyle;
  weight?: EdgeWeight;
  /** A hex value or one of the node role names. */
  color?: string;
  arrow?: EdgeArrow;
  labelMode?: EdgeLabelMode;
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
  containers?: GraphContainer[];
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
  /** Semantic id of the container holding this element, if any. */
  container?: string;
  /** Set on an edge label the converter attaches to the arrow itself. */
  bound?: boolean;
  /**
   * The parent whose fan this connector belongs to, when a tree's children
   * leave their parent by one shared trunk. Siblings overlap on the run they
   * share, and that run is the drawing, not a defect in it.
   */
  trunk?: string;
};

/** A container as it was actually drawn, keyed by its semantic id. */
export type DiagramContainerEntry = {
  id: string;
  elementId: string;
  render: ContainerRender;
  parent?: string;
  label?: string;
};

export interface DiagramPlan {
  skeletons: JsonObject[];
  nodeCount: number;
  edgeCount: number;
  edgeLabelCount: number;
  elementIdByNode: Map<string, string>;
  diagramId: string;
  roles: Map<string, DiagramElementRoleEntry>;
  /** Every container that was drawn, outermost first. */
  containers: Map<string, DiagramContainerEntry>;
  /** The theme every derived colour in this plan came from. */
  theme: ThemeName;
  /**
   * Colours the request asked for by hand. Style checks accept these as
   * deliberate; anything else has to be theme-derived.
   */
  explicitColors: Set<string>;
  /**
   * Where the editor will put every label that rides an arrow. These have no
   * skeleton of their own, so a later pass placing more labels against this
   * plan would otherwise be blind to them.
   */
  boundLabelBoxes: RouteBox[];
  layout: DiagramLayoutOutcome;
}

export const MODEL_GRID_SIZE = 20;

const NODE_FONT_SIZE = 20;
/** A title has to read as the name of the drawing, not as one more caption. */
const TITLE_FONT_SIZE = 28;
/** Clear band between the title and the top of what it names. */
const TITLE_HEADROOM = 60;
export const EDGE_LABEL_FONT_SIZE = 16;
/**
 * Clear run a bound label needs beyond its own width before auto mode will
 * seat one on the arrow.
 *
 * Half of it goes to each end, and an arrowhead is drawn about that long. Any
 * less and the caption starts where the arrowhead stops: the reader sees one
 * blob against the box it points at, not a line with a name on it.
 */
export const BOUND_LABEL_CLEARANCE = 48;
/**
 * Clear space two labels owe each other. Below this the reader stops seeing
 * two captions and starts seeing one run of text. Placement and the quality
 * checks read the same number, so a label is never put somewhere the checks
 * will then complain about.
 */
export const LABEL_MIN_GAP = 10;
/** A curved arrow's midpoint sits off the polyline; allow for the sag. */
export const CURVED_LABEL_SLACK = 4;
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

/**
 * A box measures an even number of grid cells on every side, so that its
 * centre lands on the grid like every other coordinate does. An odd number
 * puts the centre half a cell off, and a row of boxes that cannot share a
 * centre line is a row a reader sees wobble.
 */
function snapUpSize(value: number): number {
  const cell = MODEL_GRID_SIZE * 2;
  return Math.max(cell, Math.ceil(value / cell) * cell);
}

export function nodeToType(node: GraphNode): GraphShape {
  return node.shape ?? "rectangle";
}

function distance(a: RoutePoint, b: RoutePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Where Excalidraw centres a label bound to an arrow. An odd number of points
 * centres it on the middle point; an even number centres it on the midpoint of
 * the middle segment. Both branches are the editor's own rule, so a label
 * measured here lands where the editor is going to draw it.
 */
export function boundLabelAnchor(points: readonly RoutePoint[]): RoutePoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length % 2 === 1) return points[(points.length - 1) / 2];
  const index = points.length / 2 - 1;
  return {
    x: (points[index].x + points[index + 1].x) / 2,
    y: (points[index].y + points[index + 1].y) / 2,
  };
}

/** Breathing room between an arrow tip and a caption that has no border. */
export const CAPTION_ENDPOINT_GAP = 10;

/**
 * Pulls one end of a route back along its own last segment. A boxed node is
 * met at its border, which reads as contact; a text node has no border, so an
 * arrow that reaches its box lands on the first glyph instead.
 */
export function shortenRouteEnd(
  points: readonly RoutePoint[],
  end: "start" | "end",
  gap = CAPTION_ENDPOINT_GAP,
): RoutePoint[] {
  const route = points.map((point) => ({ ...point }));
  if (route.length < 2) return route;
  const tip = end === "start" ? 0 : route.length - 1;
  const inner = end === "start" ? 1 : route.length - 2;
  const run = distance(route[tip], route[inner]);
  // Never eat a whole segment: a shorter run than the gap means the two ends
  // are already all but touching, and moving the tip would invert the arrow.
  if (run <= gap * 1.5) return route;
  route[tip] = {
    x: route[tip].x + ((route[inner].x - route[tip].x) / run) * gap,
    y: route[tip].y + ((route[inner].y - route[tip].y) / run) * gap,
  };
  return route;
}

/**
 * Whether the label, sitting where the editor will put it, stays clear of
 * every box on the board. Run length alone is not enough: a route leaving the
 * side of a tall node still passes alongside it, and an axis-aligned label
 * centred on that run lands on the node it just left.
 */
export function boundLabelClears(
  points: readonly RoutePoint[],
  size: { width: number; height: number },
  boxes: readonly RouteBox[],
  margin = 4,
): boolean {
  const anchor = boundLabelAnchor(points);
  const box = {
    x: anchor.x - size.width / 2,
    y: anchor.y - size.height / 2,
    width: size.width,
    height: size.height,
  };
  return boxes.every((other) => !(box.x < other.x + other.width + margin
    && other.x < box.x + box.width + margin
    && box.y < other.y + other.height + margin
    && other.y < box.y + box.height + margin));
}

/**
 * How much straight run the label has to sit in. Centred on a bendpoint it
 * spills into both neighbouring segments, so the shorter of the two decides.
 */
export function boundLabelRoom(points: readonly RoutePoint[]): number {
  if (points.length < 2) return 0;
  if (points.length % 2 === 0) {
    const index = points.length / 2 - 1;
    return distance(points[index], points[index + 1]);
  }
  const index = (points.length - 1) / 2;
  return 2 * Math.min(
    distance(points[index - 1], points[index]),
    distance(points[index], points[index + 1]),
  );
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
  // cell from its neighbour: n ports are n-1 gaps apart, plus half a gap of
  // margin at each end. The extra whole gap this used to buy nothing ever
  // stood in is what made a two-input box 20px taller than the row it is in.
  const portSide = portDemand * PORT_SPACING;
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

/**
 * How much bigger the centre of a star is drawn than the things hanging off
 * it. A hub that measures the same as its spokes is one more box that happens
 * to sit in the middle; half as big again reads as the centre at a glance,
 * without crowding the ring.
 */
const STAR_HUB_SCALE = 1.5;

/** The centre of a star: no port room, and a size up on its spokes. */
export function hubDimensions(
  node: GraphNode,
  direction: DiagramDirection = "RIGHT",
): { width: number; height: number } {
  const natural = nodeDimensions(node, 0, direction);
  return {
    width: snapUpSize(natural.width * STAR_HUB_SCALE),
    height: snapUpSize(natural.height * STAR_HUB_SCALE),
  };
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

/**
 * Containers nest at most two deep, ids never collide with node ids, and a
 * frame is only legal where Excalidraw can actually draw one: at the top
 * level, with no container of its own inside it.
 */
export const MAX_CONTAINER_DEPTH = 2;

function validateContainers(params: LayoutParams, nodeIds: ReadonlySet<string>): void {
  const containers = params.containers ?? [];
  const byId = new Map<string, GraphContainer>();
  for (const container of containers) {
    if (!container?.id) throw new Error("Diagram containers require an id");
    if (byId.has(container.id)) {
      throw new Error(`Diagram container ${container.id} is declared twice`);
    }
    if (nodeIds.has(container.id)) {
      throw new Error(`Diagram container ${container.id} collides with a node id`);
    }
    requireMember(container.role, NODE_ROLES, `container ${container.id} role`);
    requireMember(container.render, CONTAINER_RENDERS, `container ${container.id} render`);
    byId.set(container.id, container);
  }
  const hasChildContainer = new Set<string>();
  for (const container of containers) {
    if (container.parent === undefined) continue;
    if (container.parent === container.id || !byId.has(container.parent)) {
      throw new Error(`Diagram container ${container.id} names an unknown parent ${container.parent}`);
    }
    hasChildContainer.add(container.parent);
  }
  for (const container of containers) {
    let depth = 1;
    let cursor = byId.get(container.parent ?? "");
    while (cursor) {
      depth += 1;
      if (depth > MAX_CONTAINER_DEPTH) {
        throw new Error(`Diagram container ${container.id} nests deeper than ${MAX_CONTAINER_DEPTH} levels`);
      }
      cursor = byId.get(cursor.parent ?? "");
    }
    if (container.render === "frame" && container.parent !== undefined) {
      throw new Error(`Diagram container ${container.id} cannot render as a frame inside another container`);
    }
    if (container.render === "frame" && hasChildContainer.has(container.id)) {
      throw new Error(`Diagram container ${container.id} cannot render as a frame while holding another container`);
    }
  }
  for (const node of params.nodes) {
    if (node.container !== undefined && !byId.has(node.container)) {
      throw new Error(`Diagram node ${node.id} names an unknown container ${node.container}`);
    }
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
  validateContainers(params, nodeIds);
  requireMember(params.layout?.direction, DIAGRAM_DIRECTIONS, "layout direction");
  requireMember(params.layout?.algorithm, DIAGRAM_ALGORITHMS, "layout algorithm");
  validateGraphEdges(params.edges ?? [], nodeIds);
}

/**
 * Every edge is held to this, including the ones that never reach ELK because
 * one end of them is a shape the person drew. An edge that skipped the check
 * would route from nowhere and carry whatever style string it was handed.
 */
export function validateGraphEdges(
  edges: readonly GraphEdge[],
  nodeIds: ReadonlySet<string>,
): void {
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Diagram edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
    const where = `edge ${edge.from} -> ${edge.to}`;
    requireMember(edge.style, EDGE_LINE_STYLES, `${where} style`);
    requireMember(edge.weight, EDGE_WEIGHTS, `${where} weight`);
    requireMember(edge.arrow, EDGE_ARROWS, `${where} arrow`);
    requireMember(edge.labelMode, EDGE_LABEL_MODES, `${where} labelMode`);
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

type EdgeGeometry = {
  points: RoutePoint[];
  rounded: boolean;
  label?: RoutePoint;
  /**
   * Set when the layout deliberately reserved no room for this edge's label,
   * because it is short enough to ride the arrow. Without it, "no label came
   * back" would be read as "the layout could not place one", which forces the
   * label onto the arrow even when it does not fit.
   */
  placeLabel?: boolean;
  /**
   * The parent whose fan this connector belongs to, when it leaves by a
   * shared trunk. Two siblings running over each other on the way out of one
   * box is the shape, so the checks that would otherwise call it a doubled
   * line need to know which pairs are deliberate.
   */
  trunk?: string;
};

type LayoutGeometry = {
  /** Snapped top-left corners in layout-local coordinates. */
  positions: Map<string, RoutePoint>;
  sizes: Map<string, { width: number; height: number }>;
  edges: EdgeGeometry[];
  outcome: DiagramLayoutOutcome;
  /** Present only when the request declared containers. */
  containers?: Map<string, RouteBox>;
};

/**
 * Room reserved inside a container. The top band is wider than the rest
 * because the container's own label sits in it, above its first member.
 */
export const CONTAINER_PADDING = { top: 64, left: 32, bottom: 32, right: 32 };
const CONTAINER_LABEL_INSET = { x: 20, y: 18 };
const CONTAINER_LABEL_FONT_SIZE = 20;

/** The membership graph, resolved once and read by layout and emission alike. */
type ContainerPlan = {
  /** Outermost first, declaration order within a level. */
  order: string[];
  byId: Map<string, GraphContainer>;
  childContainers: Map<string, string[]>;
  memberNodes: Map<string, string[]>;
  rootContainers: string[];
  rootNodes: string[];
  /** Node or container id to the container that holds it. */
  ownerOf: Map<string, string>;
};

function planContainers(params: LayoutParams): ContainerPlan | null {
  const containers = params.containers ?? [];
  if (containers.length === 0) return null;
  const byId = new Map(containers.map((container) => [container.id, container]));
  const childContainers = new Map<string, string[]>();
  const memberNodes = new Map<string, string[]>();
  const ownerOf = new Map<string, string>();
  const rootContainers: string[] = [];
  for (const container of containers) {
    if (container.parent === undefined) {
      rootContainers.push(container.id);
      continue;
    }
    ownerOf.set(container.id, container.parent);
    childContainers.set(container.parent, [...(childContainers.get(container.parent) ?? []), container.id]);
  }
  const rootNodes: string[] = [];
  for (const node of params.nodes) {
    if (node.container === undefined) {
      rootNodes.push(node.id);
      continue;
    }
    ownerOf.set(node.id, node.container);
    memberNodes.set(node.container, [...(memberNodes.get(node.container) ?? []), node.id]);
  }
  const order: string[] = [];
  const visit = (id: string) => {
    order.push(id);
    for (const child of childContainers.get(id) ?? []) visit(child);
  };
  for (const id of rootContainers) visit(id);
  return { order, byId, childContainers, memberNodes, rootContainers, rootNodes, ownerOf };
}

/** Innermost container first, up to the top level. */
function containerChain(plan: ContainerPlan, id: string): string[] {
  const chain: string[] = [];
  let cursor = plan.ownerOf.get(id);
  while (cursor && !chain.includes(cursor)) {
    chain.push(cursor);
    cursor = plan.ownerOf.get(cursor);
  }
  return chain;
}

/** The deepest container holding both ends, or undefined for a root edge. */
function lowestCommonContainer(plan: ContainerPlan, from: string, to: string): string | undefined {
  const first = containerChain(plan, from).reverse();
  const second = containerChain(plan, to).reverse();
  let common: string | undefined;
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    if (first[index] !== second[index]) break;
    common = first[index];
  }
  return common;
}

/**
 * A container's box is derived from where its members actually landed rather
 * than from the box ELK reported, so snapping every member onto the grid can
 * never leave one poking through a border.
 */
function containerBoxes(
  plan: ContainerPlan,
  positions: ReadonlyMap<string, RoutePoint>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  minWidths: ReadonlyMap<string, number>,
  direction: DiagramDirection,
): Map<string, RouteBox> {
  const boxes = new Map<string, RouteBox>();
  const build = (id: string): RouteBox | null => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const include = (x: number, y: number, width: number, height: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    };
    for (const child of plan.childContainers.get(id) ?? []) {
      const box = build(child);
      if (box) include(box.x, box.y, box.width, box.height);
    }
    for (const nodeId of plan.memberNodes.get(id) ?? []) {
      const position = positions.get(nodeId);
      const size = sizes.get(nodeId);
      if (position && size) include(position.x, position.y, size.width, size.height);
    }
    // A container nobody joined has no geometry and is simply not drawn.
    if (!Number.isFinite(minX)) return null;
    const x = Math.floor((minX - CONTAINER_PADDING.left) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
    const y = Math.floor((minY - CONTAINER_PADDING.top) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
    const right = Math.ceil((maxX + CONTAINER_PADDING.right) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
    const bottom = Math.ceil((maxY + CONTAINER_PADDING.bottom) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
    const box: RouteBox = {
      id,
      x,
      y,
      width: Math.max(right - x, snapUpSize(minWidths.get(id) ?? 0)),
      height: bottom - y,
    };
    boxes.set(id, box);
    return box;
  };
  for (const id of plan.rootContainers) build(id);
  alignSiblingBands(plan, boxes, direction, positions, sizes);
  return boxes;
}

/** Runs of boxes that overlap along one axis, in the order they start. */
function bandsOf(boxes: readonly RouteBox[], alongY: boolean): RouteBox[][] {
  const start = (box: RouteBox) => (alongY ? box.y : box.x);
  const end = (box: RouteBox) => start(box) + (alongY ? box.height : box.width);
  const sorted = [...boxes].sort((a, b) => start(a) - start(b) || (a.id < b.id ? -1 : 1));
  const bands: RouteBox[][] = [];
  let reach = Number.NEGATIVE_INFINITY;
  for (const box of sorted) {
    if (bands.length === 0 || start(box) >= reach) bands.push([box]);
    else bands[bands.length - 1].push(box);
    reach = Math.max(reach, end(box));
  }
  return bands;
}

/**
 * Sibling regions that share a band share their edges.
 *
 * A row of regions laid across a flow is read as a row, and four of them whose
 * tops each landed wherever their own tallest member happened to sit reads as
 * four unrelated boxes that someone forgot to line up. The band is only taken
 * when stretching to it stays clear of everything the regions do not hold, so
 * a region can never grow over a node or a neighbour to get there.
 */
function alignSiblingBands(
  plan: ContainerPlan,
  boxes: Map<string, RouteBox>,
  direction: DiagramDirection,
  positions: ReadonlyMap<string, RoutePoint>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): void {
  // A flow separates its regions along its own axis, so the band is the other
  // one: columns of a RIGHT flow share tops, rows of a DOWN flow share sides.
  const alongY = !portsSpreadAlongWidth(direction);
  const held = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const owned = new Set<string>(plan.memberNodes.get(id) ?? []);
    for (const child of plan.childContainers.get(id) ?? []) {
      for (const nodeId of collect(child)) owned.add(nodeId);
    }
    held.set(id, owned);
    return owned;
  };
  for (const id of plan.rootContainers) collect(id);

  const nodeBoxes: RouteBox[] = [];
  for (const [nodeId, position] of positions) {
    const size = sizes.get(nodeId);
    if (size) nodeBoxes.push({ id: nodeId, x: position.x, y: position.y, ...size });
  }
  const outside = (id: string): RouteBox[] => {
    const owned = held.get(id) ?? new Set<string>();
    const chain = new Set([id, ...containerChain(plan, id)]);
    return [
      ...nodeBoxes.filter((box) => !owned.has(box.id)),
      ...[...boxes].filter(([other]) => !chain.has(other) && !containerChain(plan, other).includes(id))
        .map(([, box]) => box),
    ];
  };

  const families = [plan.rootContainers, ...plan.childContainers.values()];
  for (const family of families) {
    const drawn = family.map((id) => boxes.get(id)).filter((box): box is RouteBox => Boolean(box));
    if (drawn.length < 2) continue;
    for (const band of bandsOf(drawn, alongY)) {
      if (band.length < 2) continue;
      const low = Math.min(...band.map((box) => (alongY ? box.y : box.x)));
      const high = Math.max(...band.map((box) => (alongY ? box.y + box.height : box.x + box.width)));
      const stretched = band.map((box) => (alongY
        ? { ...box, y: low, height: high - low }
        : { ...box, x: low, width: high - low }));
      const clear = stretched.every((box) => outside(box.id)
        .every((other) => !boxesTouch(box, other)));
      if (!clear) continue;
      for (const box of stretched) boxes.set(box.id, box);
    }
  }
}

/** Enough width that the container's own label fits inside its top band. */
function containerLabelWidths(params: LayoutParams): Map<string, number> {
  const widths = new Map<string, number>();
  for (const container of params.containers ?? []) {
    const label = container.label?.trim();
    if (!label) continue;
    const size = measureText(label, CONTAINER_LABEL_FONT_SIZE);
    widths.set(container.id, size.width + CONTAINER_LABEL_INSET.x * 2);
  }
  return widths;
}

type GeometryInput = {
  params: LayoutParams;
  edges: GraphEdge[];
  direction: DiagramDirection;
  sizes: Map<string, { width: number; height: number }>;
  nodeSpacing: number;
  layerSpacing: number;
  containers: ContainerPlan | null;
  containerLabelWidths: ReadonlyMap<string, number>;
  /**
   * Whether this edge's label needs room of its own in the layout. Reserving
   * room for a centred label costs a whole extra layer, so a label that will
   * ride its arrow answers false and the flow keeps one rhythm.
   */
  reserveLabel?: (edge: GraphEdge) => boolean;
};

const CONTAINER_PADDING_OPTION = `[top=${CONTAINER_PADDING.top},left=${CONTAINER_PADDING.left},bottom=${CONTAINER_PADDING.bottom},right=${CONTAINER_PADDING.right}]`;

/**
 * The spacings a region has to be told about itself.
 *
 * `INCLUDE_CHILDREN` lays the whole nest out in one pass but does not hand a
 * region the root's spacing: every container fell back to ELK's own defaults,
 * which are 20px between neighbours and 10px between a connector and a box it
 * passes. That is how members of a region ended up packed four times tighter
 * than members of the same board outside one, and how a connector crossing a
 * region came to run ten pixels under a node and read as going through it.
 *
 * Only the spacings go down. Handing a region the algorithm and hierarchy keys
 * as well makes elkjs 0.11 throw before it lays anything out at all.
 */
function spacingOptions(layoutOptions: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(layoutOptions).filter(([key]) => key.includes(".spacing.")),
  );
}

function elkGraph(input: GeometryInput, layoutOptions: Record<string, string>): ElkNode {
  const elkNode = (id: string): ElkNode => ({
    id,
    width: input.sizes.get(id)?.width ?? NODE_MIN_WIDTH,
    height: input.sizes.get(id)?.height ?? NODE_MIN_HEIGHT,
  });
  // ELK fills in `sections` on the way back out; declaring one on the way in
  // would be read as a route it has to preserve.
  const elkEdge = (edge: GraphEdge, index: number) => ({
    id: `edge-${index}`,
    sources: [edge.from],
    targets: [edge.to],
    ...(edge.label?.trim() && (input.reserveLabel?.(edge) ?? true)
      ? {
          labels: [{
            text: edge.label.trim(),
            ...measureText(edge.label.trim(), EDGE_LABEL_FONT_SIZE),
          }],
        }
      : {}),
  });

  const containers = input.containers;
  if (!containers) {
    return {
      id: "root",
      layoutOptions,
      children: input.params.nodes.map((node) => elkNode(node.id)),
      edges: input.edges.map(elkEdge),
    };
  }

  // An edge is declared at the lowest container holding both of its ends, so
  // ELK routes it in the channel that actually belongs to it.
  const ROOT = "";
  const edgesByOwner = new Map<string, ReturnType<typeof elkEdge>[]>();
  for (const [index, edge] of input.edges.entries()) {
    const owner = lowestCommonContainer(containers, edge.from, edge.to) ?? ROOT;
    edgesByOwner.set(owner, [...(edgesByOwner.get(owner) ?? []), elkEdge(edge, index)]);
  }
  const build = (id: string): ElkNode => ({
    id,
    layoutOptions: { ...spacingOptions(layoutOptions), "elk.padding": CONTAINER_PADDING_OPTION },
    children: [
      ...(containers.childContainers.get(id) ?? []).map(build),
      ...(containers.memberNodes.get(id) ?? []).map(elkNode),
    ],
    edges: edgesByOwner.get(id) ?? [],
  });
  return {
    id: "root",
    layoutOptions: { ...layoutOptions, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [
      ...containers.rootContainers.map(build),
      ...containers.rootNodes.map(elkNode),
    ],
    edges: edgesByOwner.get(ROOT) ?? [],
  };
}

function elkSection(result: ElkNode, index: number) {
  const edge = ((result.edges ?? []) as ElkExtendedEdge[])
    .find((candidate) => candidate.id === `edge-${index}`);
  return { section: edge?.sections?.[0], label: edge?.labels?.[0] };
}

/**
 * Longest side over shortest, over the ink: the boxes plus every route drawn
 * between them. A flow whose connectors need as much room as its boxes is not
 * a ribbon however narrow the boxes are, but the room ELK reserves and does
 * not use is not part of the drawing a reader is handed, and counting it
 * called a perfectly square dependency graph a ribbon and folded it into
 * swooping arcs.
 */
function aspect(node: ElkNode): number {
  const drawn = resolveAbsolute(node);
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const cover = (x: number, y: number, width = 0, height = 0) => {
    left = Math.min(left, x);
    right = Math.max(right, x + width);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y + height);
  };
  for (const [id, box] of drawn.boxes) {
    if (id === node.id) continue;
    cover(box.x, box.y, box.width, box.height);
  }
  for (const route of drawn.routes.values()) {
    for (const point of route) cover(point.x, point.y);
  }
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(width, height) / Math.min(width, height);
}

/**
 * Past this the drawing is a ribbon rather than a picture: it has to be
 * scrolled or shrunk to nothing before it can be read, and every reference
 * board on the shelf sits well inside it.
 */
const RIBBON_ASPECT = 4;
/**
 * A flow shorter than this is narrow because it is short. Two boxes side by
 * side are wider than they are tall and there is nothing to fold; stacking
 * them would only break the direction the request asked for.
 */
const MIN_FOLD_LAYERS = 5;
/** The shape a folded flow aims for. */
const TARGET_ASPECT = 1.6;
/** The gap a row of the fold leaves the row below it for the turn to run in. */
const FOLD_ROW_GAP = 100;
/**
 * A row of two is a step, not a row: folding a chain onto pairs draws a
 * zigzag column rather than the grid a reader recognises.
 */
const MIN_FOLD_COLUMNS = 3;

/** How many ranks the flow advanced through, read off the placed children. */
function layerCount(node: ElkNode, direction: DiagramDirection): number {
  const alongY = portsSpreadAlongWidth(direction);
  return new Set((node.children ?? [])
    .map((child) => Math.round(finiteNumber(alongY ? child.y : child.x)))).size;
}

/**
 * How lopsided the fold's rows are allowed to be before the fold is thrown
 * away. Under a half, the cut fell somewhere the chain did not want to be cut:
 * one row carries the drawing, another carries a single box, and the connector
 * joining them has to run the whole width of the board and back to get there.
 * That is the U-turn a reader sees, and a plain ribbon beats it.
 */
const MIN_FOLD_ROW_BALANCE = 0.5;

/** A rank of the flow, as the fold moves it around: whole, never split. */
type FlowLayer = {
  nodes: ElkNode[];
  /** Where the rank starts and how far it reaches along the flow axis. */
  flow: { start: number; extent: number };
  /** The same across the axis the rows stack on. */
  stack: { start: number; extent: number };
};

export type FoldedFlow = {
  positions: Map<string, RoutePoint>;
  /** The sides each edge leaves and arrives on, by the edge's index. */
  sides: Map<number, { from: Side; to: Side }>;
  /** Which lane out from the board each margin run takes, by edge index. */
  lanes?: Map<number, number>;
  aspect: number;
  rows: number[];
  /** Every connector orthogonal; see RoutePlanOptions.square. */
  square?: boolean;
};

/** The ranks ELK laid out, in flow order, each one whole. */
function flowLayers(laid: ElkNode, alongY: boolean): FlowLayer[] {
  const flowStart = (child: ElkNode) => finiteNumber(alongY ? child.y : child.x);
  const stackStart = (child: ElkNode) => finiteNumber(alongY ? child.x : child.y);
  const flowSize = (child: ElkNode) => finiteNumber(alongY ? child.height : child.width);
  const stackSize = (child: ElkNode) => finiteNumber(alongY ? child.width : child.height);
  // A rank is a band across the flow, not a coordinate. Layers never overlap
  // along the flow axis, but ELK centres a narrow node inside the layer its
  // widest neighbour asked for, so two nodes of one rank can start twenty
  // pixels apart. Keying on the coordinate split them, and a rank counted
  // twice is a rank the fold seats twice and the main path cannot reach.
  const ordered = [...(laid.children ?? [])].sort((a, b) => flowStart(a) - flowStart(b));
  const bands: ElkNode[][] = [];
  for (const child of ordered) {
    const band = bands[bands.length - 1];
    const end = band ? Math.max(...band.map((node) => flowStart(node) + flowSize(node))) : Number.NaN;
    if (band && flowStart(child) < end) band.push(child);
    else bands.push([child]);
  }
  return bands
    .map((nodes) => ({
      nodes,
      flow: {
        start: Math.min(...nodes.map(flowStart)),
        extent: Math.max(...nodes.map((node) => flowStart(node) + flowSize(node)))
          - Math.min(...nodes.map(flowStart)),
      },
      stack: {
        start: Math.min(...nodes.map(stackStart)),
        extent: Math.max(...nodes.map((node) => stackStart(node) + stackSize(node)))
          - Math.min(...nodes.map(stackStart)),
      },
    }));
}

/**
 * Where a rank lands once the flow is folded into rows of `columns`.
 *
 * Rows alternate direction, which is the whole point. Wrapping a chain
 * left-to-right on every row leaves the last box of one row and the first box
 * of the next at opposite ends of the board, and the connector between them
 * has to sweep the full width and back. Turning the row round instead puts
 * them in the same column, one directly above the other, and the turn is a
 * short straight run down the outside. That is what the roadmap boards on the
 * reference shelf do, and it is what a person drawing the same chain does.
 */
function foldSeat(index: number, columns: number): { row: number; column: number } {
  const row = Math.floor(index / columns);
  const along = index % columns;
  return { row, column: row % 2 === 0 ? along : columns - 1 - along };
}

/**
 * Folds a ribbon into a serpentine grid.
 *
 * The ranks keep their internal shape and their order; only where each rank
 * sits changes. Every candidate row count is measured and the one landing
 * closest to a readable page shape wins, provided the rows come out even: a
 * cut that leaves one row carrying the drawing and another carrying a single
 * box is the U-turn a reader sees, and a plain ribbon beats it.
 */
function foldFlow(input: GeometryInput, laid: ElkNode): FoldedFlow | null {
  // A region is a column of the drawing and folding one is not a fold, it is
  // a scramble, so a nested graph keeps the shape it was given.
  if (input.containers) return null;
  const alongY = portsSpreadAlongWidth(input.direction);
  const layers = flowLayers(laid, alongY);
  if (layers.length < MIN_FOLD_LAYERS) return null;

  const rankOf = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const node of layer.nodes) rankOf.set(node.id, index);
  });
  // A serpentine grid gives exactly two kinds of connector a lane of its own:
  // a step along the row, and the turn down the outside into the row below,
  // which the alternating rows put in the same column. Both join neighbouring
  // ranks. An edge that reaches further -- a branch skipping past a rank, a
  // feedback edge closing a loop three ranks back -- has no lane, so it cuts
  // across the middle of the board, crossing whatever the grid put in its way.
  // That is the connector sweeping the folded block, and it undoes the fold.
  // So the fold is for a chain: a decision flow that branches, or a pipeline
  // that loops back, keeps the shape its direction asked for.
  const consecutive = input.edges.every((edge) => {
    const from = rankOf.get(edge.from);
    const to = rankOf.get(edge.to);
    return from === undefined || to === undefined || from === to || Math.abs(to - from) === 1;
  });
  if (!consecutive) return null;

  let best: FoldedFlow | null = null;
  for (let columns = MIN_FOLD_COLUMNS; columns < layers.length; columns++) {
    const rowCount = Math.ceil(layers.length / columns);
    if (rowCount < 2) continue;
    const counts = Array.from({ length: rowCount }, (_, row) => layers
      .filter((_layer, index) => foldSeat(index, columns).row === row).length);
    if (Math.min(...counts) < Math.max(...counts) * MIN_FOLD_ROW_BALANCE) continue;

    const columnExtent = Array.from({ length: columns }, () => 0);
    const rowExtent = Array.from({ length: rowCount }, () => 0);
    layers.forEach((layer, index) => {
      const seat = foldSeat(index, columns);
      columnExtent[seat.column] = Math.max(columnExtent[seat.column], layer.flow.extent);
      rowExtent[seat.row] = Math.max(rowExtent[seat.row], layer.stack.extent);
    });
    const total = (extents: number[], gap: number) => extents.reduce((sum, one) => sum + one, 0)
      + gap * (extents.length - 1);
    const flowSpan = total(columnExtent, input.layerSpacing);
    const stackSpan = total(rowExtent, FOLD_ROW_GAP);
    const width = alongY ? stackSpan : flowSpan;
    const height = alongY ? flowSpan : stackSpan;
    const shape = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (best && Math.abs(shape - TARGET_ASPECT) >= Math.abs(best.aspect - TARGET_ASPECT)) continue;

    const offsets = (extents: number[], gap: number) => extents.reduce<number[]>(
      (starts, extent, index) => [...starts, starts[index] + extent + gap],
      [0],
    );
    const columnStart = offsets(columnExtent, input.layerSpacing);
    const rowStart = offsets(rowExtent, FOLD_ROW_GAP);
    const positions = new Map<string, RoutePoint>();
    layers.forEach((layer, index) => {
      const seat = foldSeat(index, columns);
      // A rank narrower than its column, or shallower than its row, is centred
      // in the room the widest of its neighbours asked for.
      const flowShift = columnStart[seat.column]
        + (columnExtent[seat.column] - layer.flow.extent) / 2 - layer.flow.start;
      const stackShift = rowStart[seat.row]
        + (rowExtent[seat.row] - layer.stack.extent) / 2 - layer.stack.start;
      for (const node of layer.nodes) {
        const flow = finiteNumber(alongY ? node.y : node.x) + flowShift;
        const stack = finiteNumber(alongY ? node.x : node.y) + stackShift;
        positions.set(node.id, alongY ? { x: stack, y: flow } : { x: flow, y: stack });
      }
    });

    // Along the row the flow reads as it always did; between rows it turns
    // down the outside of the board and arrives square on the box below.
    const forward: { from: Side; to: Side } = alongY
      ? { from: "bottom", to: "top" }
      : { from: "right", to: "left" };
    const backward: { from: Side; to: Side } = { from: forward.to, to: forward.from };
    const turn: { from: Side; to: Side } = alongY
      ? { from: "right", to: "left" }
      : { from: "bottom", to: "top" };
    const sides = new Map<number, { from: Side; to: Side }>();
    input.edges.forEach((edge, index) => {
      const from = rankOf.get(edge.from);
      const to = rankOf.get(edge.to);
      if (from === undefined || to === undefined || from === to) return;
      const here = foldSeat(from, columns);
      const there = foldSeat(to, columns);
      if (here.row === there.row) {
        sides.set(index, there.column > here.column ? forward : backward);
      } else if (there.row === here.row + 1 && there.column === here.column) {
        sides.set(index, turn);
      }
    });
    best = { positions, sides, aspect: shape, rows: counts };
  }
  return best;
}

/**
 * How far off the line a main path has to wander before it is worth redrawing
 * the board's connectors to straighten it. Half a grid cell is the rounding
 * ELK's own placement leaves behind and reads as straight.
 */
const MAIN_PATH_DRIFT = MODEL_GRID_SIZE / 2;

/**
 * The nodes on the flow's main path: one per rank, joined end to end.
 *
 * The longest run of one-rank steps is what a reader follows down the middle
 * of a flow chart, and everything else on the board is a branch off it. A flow
 * whose longest run does not reach every rank has no single main path, so
 * there is no one line to stand it on.
 */
function mainPath(layers: readonly FlowLayer[], edges: readonly GraphEdge[]): ElkNode[] | null {
  const rankOf = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const node of layer.nodes) rankOf.set(node.id, index);
  });
  const steps = new Map<string, string[]>();
  for (const edge of edges) {
    const from = rankOf.get(edge.from);
    const to = rankOf.get(edge.to);
    if (from === undefined || to === undefined || to !== from + 1) continue;
    steps.set(edge.to, [...(steps.get(edge.to) ?? []), edge.from]);
  }
  const reach = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  for (const layer of layers) {
    for (const node of layer.nodes) {
      let best = 1;
      for (const previous of steps.get(node.id) ?? []) {
        const through = (reach.get(previous) ?? 0) + 1;
        if (through > best) {
          best = through;
          cameFrom.set(node.id, previous);
        }
      }
      reach.set(node.id, best);
    }
  }
  const [end] = [...reach].sort(([, a], [, b]) => b - a)[0] ?? [];
  if (end === undefined || (reach.get(end) ?? 0) < layers.length) return null;
  const byId = new Map((layers.flatMap((layer) => layer.nodes)).map((node) => [String(node.id), node]));
  const path: ElkNode[] = [];
  for (let id: string | undefined = end; id !== undefined; id = cameFrom.get(id)) {
    path.unshift(byId.get(id)!);
  }
  return path.length === layers.length ? path : null;
}

/**
 * Stands a flow's main path on one line.
 *
 * ELK routes through ports it spreads along a node's side itself, and it
 * aligns the ports, not the boxes. A rank whose node carries three connectors
 * therefore hangs off the channel by whatever the spread was, and the run down
 * the middle of an eight-rank decision chart arrives at each box on a slightly
 * different axis. The ranks are shifted whole, so nothing inside one moves
 * relative to anything else in it; only the board's own centre line changes.
 *
 * The connectors are redrawn, because ELK's channels describe where it put the
 * ranks and not where they are now. Everything else is the fold's machinery,
 * including the guard: a board that cannot be redrawn with square corners is
 * handed back to ELK unchanged.
 */
function alignMainPath(input: GeometryInput, laid: ElkNode): FoldedFlow | null {
  if (input.containers) return null;
  const alongY = portsSpreadAlongWidth(input.direction);
  const layers = flowLayers(laid, alongY);
  if (layers.length < 3) return null;
  const path = mainPath(layers, input.edges);
  if (!path) return null;

  const crossCentre = (node: ElkNode) => finiteNumber(alongY ? node.x : node.y)
    + finiteNumber(alongY ? node.width : node.height) / 2;
  const centres = path.map(crossCentre).sort((a, b) => a - b);
  const axis = centres[Math.floor(centres.length / 2)];
  const shifts = path.map((node) => axis - crossCentre(node));
  if (shifts.every((shift) => Math.abs(shift) <= MAIN_PATH_DRIFT)) return null;

  // One rhythm down the board, too. ELK buys a whole caption's width of extra
  // layer gap for every caption it has to reserve room for, so a nine-letter
  // word on one connector opens a gap twice the size of every other gap on the
  // board. The captions are placed against the routes drawn here, not in the
  // room ELK set aside, so the room goes back and every rank stands one layer
  // spacing from the last.
  const stride = layers.map((layer, index) => (index === 0
    ? 0
    : layer.flow.start - (layers[index - 1].flow.start + layers[index - 1].flow.extent)));
  const flowShift: number[] = [];
  layers.forEach((layer, index) => {
    flowShift[index] = index === 0
      ? 0
      : flowShift[index - 1] + Math.min(0, input.layerSpacing - stride[index]);
  });

  const positions = new Map<string, RoutePoint>();
  layers.forEach((layer, index) => {
    const across = shifts[index];
    const along = flowShift[index];
    for (const node of layer.nodes) {
      const x = finiteNumber(node.x) + (alongY ? across : along);
      const y = finiteNumber(node.y) + (alongY ? along : across);
      positions.set(String(node.id), { x, y });
    }
  });

  const rankOf = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const node of layer.nodes) rankOf.set(String(node.id), index);
  });
  const forward: { from: Side; to: Side } = alongY
    ? { from: "bottom", to: "top" }
    : { from: "right", to: "left" };
  // The flow's own two sides belong to the flow. A branch that skips a rank
  // and a feedback edge that closes a loop run in the margin beside the board
  // instead, and they leave and arrive there: an edge that rejoins the flow
  // head on lands a second arrowhead beside the first, which reads as one
  // connector drawn twice. Which margin is whichever side of the centre line
  // the two ends already sit on, so the run never has to cross the board to
  // reach its own lane; a branch that hangs off neither side takes the right
  // and a loop that closes off neither takes the left, so the two kinds do
  // not share a lane.
  const high: Side = alongY ? "right" : "bottom";
  const low: Side = alongY ? "left" : "top";
  const offset = (id: string) => {
    const point = positions.get(id);
    const size = input.sizes.get(id);
    if (!point || !size) return 0;
    return (alongY ? point.x + size.width / 2 : point.y + size.height / 2) - axis;
  };
  const sides = new Map<number, { from: Side; to: Side }>();
  /** How far along the flow each margin run reaches, by edge index. */
  const reach = new Map<number, number>();
  input.edges.forEach((edge, index) => {
    const from = rankOf.get(edge.from);
    const to = rankOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) return;
    if (to === from + 1) {
      sides.set(index, forward);
      return;
    }
    reach.set(index, Math.abs(to - from));
    // Within half a cell of the line is on the line: the snap moves a box that
    // far anyway, and an end that came out a hundredth of a pixel off the
    // centre would otherwise send a branch down the loop's own margin.
    const away = [offset(edge.from), offset(edge.to)]
      .reduce((worst, one) => (Math.abs(one) > Math.abs(worst) ? one : worst), 0);
    const margin = Math.abs(away) <= MODEL_GRID_SIZE / 2
      ? (to > from ? high : low)
      : (away > 0 ? high : low);
    sides.set(index, { from: margin, to: margin });
  });
  // One margin can carry more than one run, and two runs on one line is the
  // whole board's worth of feedback drawn once. Each margin's runs are given
  // their own lane, the one reaching furthest along the flow taking the
  // outermost, so the short run nests inside the long one instead of the two
  // fighting over the same line.
  const lanes = new Map<number, number>();
  for (const margin of [high, low]) {
    [...reach.entries()]
      .filter(([index]) => sides.get(index)?.from === margin)
      .sort(([a, one], [b, other]) => one - other || a - b)
      .forEach(([index], order) => lanes.set(index, order + 1));
  }
  return {
    positions,
    sides,
    lanes,
    aspect: aspect(laid),
    rows: layers.map((layer) => layer.nodes.length),
    square: true,
  };
}

/**
 * Past this a band of regions has to be scrolled or shrunk to nothing before
 * a reader can tell one region from another. It is stricter than the ribbon
 * threshold a plain flow is held to, because a region carries a whole layout
 * inside it: at four times as wide as it is tall, the boxes inside the regions
 * are the size of the text on them.
 */
const REGION_BAND_ASPECT = 2.5;
/**
 * Fewer than this and there is no grid to move to. Three regions can only be
 * packed into a row of two and a row of one, and a grid with a corner missing
 * reads worse than the band it replaced.
 */
const MIN_PACKED_REGIONS = 4;

/** A region, or a node belonging to no region: whatever moves as one piece. */
type RegionCell = {
  id: string;
  /** Every node that travels with the cell. */
  nodes: string[];
  box: RouteBox;
};

/** Where a cell was put, so an edge between two cells knows which way to go. */
type RegionPacking = {
  positions: Map<string, RoutePoint>;
  seats: Map<string, { row: number; column: number }>;
  /** The cell each node belongs to. */
  cellOf: Map<string, string>;
  aspect: number;
};

/**
 * Lays a board's regions out on a grid.
 *
 * A layered engine puts every sibling region in one band along the flow, and
 * four regions in a band is a drawing four times wider than it is tall with
 * the whole of its detail inside them. Folding a region is not an option:
 * a region is one piece and scrambling its members is not a layout. But the
 * regions themselves are exactly the kind of thing a grid is for, and moving
 * one is free -- every member travels with it and the layout inside is
 * untouched.
 *
 * So the band is folded at the level above: the same serpentine the fold uses
 * for the ranks of a flow, applied to whole regions, so the last region of a
 * row and the first of the next sit one above the other and the connector
 * between them is a straight drop rather than a sweep back across the board.
 */
function packRegions(
  input: GeometryInput,
  laid: ReadonlyMap<string, RoutePoint>,
): RegionPacking | null {
  const plan = input.containers;
  if (!plan) return null;
  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const regions = containerBoxes(plan, laid, input.sizes, input.containerLabelWidths, input.direction);
  const membersOf = (id: string): string[] => [
    ...(plan.memberNodes.get(id) ?? []),
    ...(plan.childContainers.get(id) ?? []).flatMap(membersOf),
  ];
  const cells: RegionCell[] = [
    ...plan.rootContainers
      .filter((id) => regions.has(id))
      .map((id) => ({ id, nodes: membersOf(id), box: regions.get(id)! })),
    ...plan.rootNodes.filter((id) => laid.has(id)).map((id) => ({
      id,
      nodes: [id],
      box: { id, ...laid.get(id)!, ...sizeOf(id) },
    })),
  ];
  if (cells.length < MIN_PACKED_REGIONS) return null;

  const alongY = portsSpreadAlongWidth(input.direction);
  const flowStart = (cell: RegionCell) => (alongY ? cell.box.y : cell.box.x);
  const stackStart = (cell: RegionCell) => (alongY ? cell.box.x : cell.box.y);
  const flowSize = (cell: RegionCell) => (alongY ? cell.box.height : cell.box.width);
  const stackSize = (cell: RegionCell) => (alongY ? cell.box.width : cell.box.height);
  // The order the flow put them in is the order a reader reads them in, and
  // the grid keeps it.
  cells.sort((a, b) => flowStart(a) - flowStart(b) || (a.id < b.id ? -1 : 1));

  const span = (values: number[]) => Math.max(...values) - Math.min(...values);
  const bandWidth = span(cells.flatMap((cell) => [cell.box.x, cell.box.x + cell.box.width]));
  const bandHeight = span(cells.flatMap((cell) => [cell.box.y, cell.box.y + cell.box.height]));
  const bandAspect = Math.max(bandWidth, bandHeight) / Math.max(1, Math.min(bandWidth, bandHeight));
  if (bandAspect <= REGION_BAND_ASPECT) return null;

  let best: { aspect: number; seats: Map<string, { row: number; column: number }>; shift: Map<string, RoutePoint> } | null = null;
  for (let columns = 2; columns < cells.length; columns++) {
    // Every row full. A ragged last row leaves a hole in the corner of the
    // board, and a reader reads the hole before anything else on it.
    if (cells.length % columns !== 0) continue;
    const rowCount = cells.length / columns;
    if (rowCount < 2) continue;

    const columnExtent = Array.from({ length: columns }, () => 0);
    const rowExtent = Array.from({ length: rowCount }, () => 0);
    cells.forEach((cell, index) => {
      const seat = foldSeat(index, columns);
      columnExtent[seat.column] = Math.max(columnExtent[seat.column], flowSize(cell));
      rowExtent[seat.row] = Math.max(rowExtent[seat.row], stackSize(cell));
    });
    const gap = input.layerSpacing;
    const total = (extents: number[]) => extents.reduce((sum, one) => sum + one, 0) + gap * (extents.length - 1);
    const flowSpan = total(columnExtent);
    const stackSpan = total(rowExtent);
    const width = alongY ? stackSpan : flowSpan;
    const height = alongY ? flowSpan : stackSpan;
    const shape = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (best && Math.abs(shape - TARGET_ASPECT) >= Math.abs(best.aspect - TARGET_ASPECT)) continue;

    const offsets = (extents: number[]) => extents.reduce<number[]>(
      (starts, extent, index) => [...starts, starts[index] + extent + gap],
      [0],
    );
    const columnStart = offsets(columnExtent);
    const rowStart = offsets(rowExtent);
    const seats = new Map<string, { row: number; column: number }>();
    const shift = new Map<string, RoutePoint>();
    cells.forEach((cell, index) => {
      const seat = foldSeat(index, columns);
      seats.set(cell.id, seat);
      // Regions in a row start on a common edge, which is what makes a row of
      // them read as a row rather than as boxes nobody lined up.
      const flow = columnStart[seat.column] - flowStart(cell);
      const stack = rowStart[seat.row] - stackStart(cell);
      shift.set(cell.id, alongY ? { x: stack, y: flow } : { x: flow, y: stack });
    });
    best = { aspect: shape, seats, shift };
  }
  if (!best || best.aspect >= bandAspect) return null;

  const positions = new Map<string, RoutePoint>();
  const cellOf = new Map<string, string>();
  for (const cell of cells) {
    const delta = best.shift.get(cell.id)!;
    for (const nodeId of cell.nodes) {
      const point = laid.get(nodeId);
      if (!point) continue;
      cellOf.set(nodeId, cell.id);
      positions.set(nodeId, {
        x: snapModelCoordinate(point.x + delta.x),
        y: snapModelCoordinate(point.y + delta.y),
      });
    }
  }
  return { positions, seats: best.seats, cellOf, aspect: best.aspect };
}

/**
 * The stretch of a route that is inside none of the given boxes, as a straight
 * run between its two ends.
 *
 * A caption belonging to no region may not sit in one, and on a board of
 * regions most of a cross-region connector is inside one or the other. What is
 * left is the corridor it crosses, and that is where the caption goes: asking
 * for a spot beside the whole route offers the middle first, and the middle of
 * a connector between two regions is inside one of them.
 */
function runOutside(points: readonly RoutePoint[], boxes: readonly RouteBox[]): RoutePoint[] {
  if (points.length < 2 || boxes.length === 0) return [...points];
  const samples = 100;
  const at = (fraction: number): RoutePoint => {
    const total = points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
    let remaining = total * fraction;
    for (let index = 1; index < points.length; index++) {
      const length = distance(points[index - 1], points[index]);
      if (remaining > length && index < points.length - 1) {
        remaining -= length;
        continue;
      }
      const ratio = length === 0 ? 0 : Math.min(1, remaining / length);
      return {
        x: points[index - 1].x + (points[index].x - points[index - 1].x) * ratio,
        y: points[index - 1].y + (points[index].y - points[index - 1].y) * ratio,
      };
    }
    return points[points.length - 1];
  };
  const clear = Array.from({ length: samples + 1 }, (_, index) => {
    const point = at(index / samples);
    return boxes.every((box) => point.x < box.x || point.x > box.x + box.width
      || point.y < box.y || point.y > box.y + box.height);
  });
  let best: { start: number; end: number } | null = null;
  let start: number | null = null;
  for (let index = 0; index <= samples; index++) {
    if (clear[index] && start === null) start = index;
    if ((!clear[index] || index === samples) && start !== null) {
      const end = clear[index] ? index : index - 1;
      if (!best || end - start > best.end - best.start) best = { start, end };
      start = null;
    }
  }
  if (!best || best.end === best.start) return [...points];
  return [at(best.start / samples), at(best.end / samples)];
}

/**
 * Draws a board whose regions were packed onto a grid.
 *
 * Moving the regions moved every route ELK drew between them, so the routes
 * are drawn here instead against the grid the regions now sit on: along the
 * row between neighbours, down the outside at the turn, and on the flow's own
 * sides inside a region, where the layered engine's own arrangement still
 * holds. Every region an edge has no end inside is a blocker to it, so no
 * connector may take a short cut through somebody else's border.
 */
function packedGeometry(
  input: GeometryInput,
  packed: RegionPacking,
  outcome: DiagramLayoutOutcome,
): LayoutGeometry | null {
  const plan = input.containers;
  if (!plan) return null;
  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const positions = packed.positions;
  const boxes = new Map<string, RouteBox>(input.params.nodes
    .filter((node) => positions.has(node.id))
    .map((node) => {
      const position = positions.get(node.id)!;
      return [node.id, { id: node.id, x: position.x, y: position.y, ...sizeOf(node.id) }];
    }));
  const regions = containerBoxes(plan, positions, input.sizes, input.containerLabelWidths, input.direction);
  const held = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const owned = new Set<string>(plan.memberNodes.get(id) ?? []);
    for (const child of plan.childContainers.get(id) ?? []) {
      for (const nodeId of collect(child)) owned.add(nodeId);
    }
    held.set(id, owned);
    return owned;
  };
  for (const id of plan.rootContainers) collect(id);

  const alongY = portsSpreadAlongWidth(input.direction);
  const forward: { from: Side; to: Side } = alongY
    ? { from: "bottom", to: "top" }
    : { from: "right", to: "left" };
  const backward: { from: Side; to: Side } = { from: forward.to, to: forward.from };
  const turn: { from: Side; to: Side } = alongY
    ? { from: "right", to: "left" }
    : { from: "bottom", to: "top" };
  const sidesFor = (from: string, to: string): { from: Side; to: Side } | undefined => {
    const here = packed.seats.get(packed.cellOf.get(from) ?? "");
    const there = packed.seats.get(packed.cellOf.get(to) ?? "");
    if (!here || !there) return undefined;
    // Inside one region the flow is the one the request asked for, which is
    // what the layered engine arranged the members along.
    if (here === there) return TREE_PORT_SIDES[input.direction];
    if (here.row === there.row) return there.column > here.column ? forward : backward;
    if (there.row === here.row + 1 && there.column === here.column) return turn;
    return undefined;
  };

  const requests: RouteRequest[] = input.edges.map((edge, index) => {
    const sides = sidesFor(edge.from, edge.to);
    const outside = [...regions]
      .filter(([id]) => !(held.get(id)?.has(edge.from) ?? false) && !(held.get(id)?.has(edge.to) ?? false))
      .map(([, box]) => box);
    return {
      id: `edge-${index}`,
      from: edge.from,
      to: edge.to,
      ...(sides ? { sides } : {}),
      ...(outside.length > 0 ? { blockers: outside } : {}),
    };
  });
  const attachments = new Map(requests.map((request) => [request.id, { from: request.from, to: request.to }]));
  const minSteps = new Map<string, number>();
  let routes = planRoutes(boxes, requests, { minSteps, square: true });
  for (let round = 0; ; round++) {
    const guilty = routeDefects(boxes, routes, attachments);
    for (const [index, request] of requests.entries()) {
      const geometry = routeGeometry(routes[index].points, routes[index].rounded);
      if ((request.blockers ?? []).some((box) => geometryIntersectsBox(geometry, box, 0))) {
        guilty.add(request.id);
      }
    }
    if (guilty.size === 0) break;
    if (round === MAX_ROUTE_REPAIR_ITERATIONS - 1) return null;
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(boxes, requests, { minSteps, square: true });
  }
  // A grid is drawn with square corners, the same rule a folded flow is held
  // to. One connector swooping across a board of regions says the grid does
  // not suit this graph, and the band it replaced at least read as a band.
  if (routes.some((route) => route.rounded)) return null;

  const placed: RouteBox[] = [...boxes.values()];
  const edges: EdgeGeometry[] = input.edges.map((edge, index) => {
    const route = routes[index];
    const text = edge.label?.trim();
    if (!text) return { points: route.points, rounded: route.rounded };
    const size = measureText(text, EDGE_LABEL_FONT_SIZE);
    // A caption inside a region reads as belonging to it, so a connector
    // between two regions may not park its caption in either of them, nor in
    // any other. Only a region the edge itself lives in will take it.
    const owner = lowestCommonContainer(plan, edge.from, edge.to);
    const home = new Set(owner ? [owner, ...containerChain(plan, owner)] : []);
    const barred = [...regions].filter(([id]) => !home.has(id)).map(([, box]) => box);
    const label = placeEdgeLabel(runOutside(route.points, barred), size, [...placed, ...barred]);
    placed.push({ id: `label-${index}`, x: label.x, y: label.y, ...size });
    return { points: route.points, rounded: route.rounded, label };
  });
  return { positions, sizes: input.sizes, outcome, containers: regions, edges };
}

/**
 * Draws the connectors of a folded flow.
 *
 * The fold moved every rank, so ELK's channel routes no longer describe the
 * board. The grid it moved them onto is regular enough to route by hand: a
 * step along a row is a straight run out of one box into the next, and a turn
 * between rows is a straight drop down the outside, because the fold put the
 * last rank of a row and the first rank of the next in the same column.
 * Anything else, a branch or an edge closing a loop, goes through the same
 * repair loop every non-layered algorithm uses, and a fold with an edge that
 * loop cannot clear is thrown away: a chain that closes a loop back across two
 * rows has no tidy route through the grid, and the ribbon it replaced at least
 * had one.
 */
function foldedGeometry(
  input: GeometryInput,
  folded: FoldedFlow,
  outcome: DiagramLayoutOutcome,
): LayoutGeometry | null {
  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const positions = new Map<string, RoutePoint>(input.params.nodes.map((node) => {
    const point = folded.positions.get(node.id) ?? { x: 0, y: 0 };
    return [node.id, { x: snapModelCoordinate(point.x), y: snapModelCoordinate(point.y) }];
  }));
  const boxes = new Map<string, RouteBox>(input.params.nodes.map((node) => {
    const position = positions.get(node.id)!;
    return [node.id, { id: node.id, x: position.x, y: position.y, ...sizeOf(node.id) }];
  }));
  const requests: RouteRequest[] = input.edges.map((edge, index) => ({
    id: `edge-${index}`,
    from: edge.from,
    to: edge.to,
    ...(folded.sides.has(index) ? { sides: folded.sides.get(index)! } : {}),
    ...(folded.lanes?.has(index) ? { lane: folded.lanes.get(index)! } : {}),
  }));
  const attachments = new Map(requests.map((request) => [request.id, { from: request.from, to: request.to }]));
  const minSteps = new Map<string, number>();
  const square = folded.square === true;
  let routes = planRoutes(boxes, requests, { minSteps, square });
  for (let round = 0; ; round++) {
    const guilty = routeDefects(boxes, routes, attachments);
    if (guilty.size === 0) break;
    if (round === MAX_ROUTE_REPAIR_ITERATIONS - 1) return null;
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(boxes, requests, { minSteps, square });
  }
  // A grid is drawn with straight runs and square corners. An edge that had to
  // be bent onto an arc to get anywhere is the grid saying it does not suit
  // this graph, and one swooping curve across a folded board undoes what the
  // fold was for.
  if (routes.some((route) => route.rounded)) return null;

  const placed: RouteBox[] = [...boxes.values()];
  const edges: EdgeGeometry[] = input.edges.map((edge, index) => {
    const route = routes[index];
    const text = edge.label?.trim();
    if (!text) return { points: route.points, rounded: route.rounded };
    const size = measureText(text, EDGE_LABEL_FONT_SIZE);
    const label = placeEdgeLabel(route.points, size, placed);
    placed.push({ id: `label-${index}`, x: label.x, y: label.y, ...size });
    return { points: route.points, rounded: route.rounded, label };
  });
  return { positions, sizes: input.sizes, outcome, edges };
}

/**
 * The layered path: ELK routes orthogonally through channels it reserved
 * itself, and those routes stay exactly where it put them. Snapping a 16px
 * channel onto the 20px grid is what merges two arrows into one line.
 */
async function layeredGeometry(input: GeometryInput, outcome: DiagramLayoutOutcome): Promise<LayoutGeometry> {
  // A label only needs room of its own when it cannot fit in the channel the
  // layer gap already provides. Asking ELK to reserve room for a centred
  // label costs an entire extra layer, which is what made a chart carrying
  // "yes" and "no" twice as long as the same chart without them.
  const ridesTheArrow = (edge: GraphEdge): boolean => {
    const text = edge.label?.trim();
    if (!text || edge.labelMode === "standalone") return false;
    // Inside a region the reserved room is also what keeps the label within
    // its own borders, so a region's edges always pay for it.
    if (input.containers && lowestCommonContainer(input.containers, edge.from, edge.to)) return false;
    return measureText(text, EDGE_LABEL_FONT_SIZE).width + BOUND_LABEL_CLEARANCE <= input.layerSpacing;
  };
  const withheld = new Set(input.edges.filter(ridesTheArrow));
  const graph = { ...input, reserveLabel: (edge: GraphEdge) => !withheld.has(edge) };
  const options = {
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
    // A request lists its edges in the order the story is told, so the edge
    // that closes a loop is the later one. ELK's default greedy cycle breaker
    // ignores that and is free to reverse the forward edge instead, which
    // turns a flow chart upside down and sends the retry edge the long way
    // around the whole drawing. Model order breaks exactly the edges that
    // point backwards against the declared order.
    "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  };
  const result = await elk.layout(elkGraph(graph, options));
  // A flow that came out as a ribbon is refolded onto a serpentine grid, and
  // routed by hand: ELK's channels belong to the shape it laid out, not to
  // the one the fold moved the ranks into.
  const folded = aspect(result) > RIBBON_ASPECT && layerCount(result, input.direction) >= MIN_FOLD_LAYERS
    ? foldFlow(input, result)
    : null;
  const foldGeometry = folded && folded.aspect < aspect(result)
    ? foldedGeometry(input, folded, outcome)
    : null;
  if (foldGeometry) return foldGeometry;
  // A flow that keeps its shape still owes its reader one centre line to
  // follow. The ranks are shifted onto it whole and the connectors redrawn.
  const aligned = alignMainPath(input, result);
  const alignedGeometry = aligned ? foldedGeometry(input, aligned, outcome) : null;
  if (alignedGeometry) return alignedGeometry;
  const absolute = resolveAbsolute(result);
  const positions = new Map<string, RoutePoint>(input.params.nodes.map((node) => {
    const box = absolute.boxes.get(node.id);
    return [node.id, { x: snapModelCoordinate(box?.x), y: snapModelCoordinate(box?.y) }];
  }));
  // A band of regions is folded at the level above the flow: the regions move,
  // whole, onto a grid, and what is inside each one is left exactly as it was.
  const packed = input.containers ? packRegions(input, positions) : null;
  const packedResult = packed ? packedGeometry(input, packed, outcome) : null;
  if (packedResult) return packedResult;
  return {
    positions,
    sizes: input.sizes,
    outcome,
    ...(input.containers
      ? {
          containers: containerBoxes(
            input.containers,
            positions,
            input.sizes,
            input.containerLabelWidths,
            input.direction,
          ),
        }
      : {}),
    edges: input.edges.map((edge, index) => {
      const route = absolute.routes.get(`edge-${index}`);
      const label = absolute.labels.get(`edge-${index}`);
      const fromPosition = positions.get(edge.from) ?? { x: 0, y: 0 };
      const toPosition = positions.get(edge.to) ?? { x: 0, y: 0 };
      const fromSize = input.sizes.get(edge.from) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      const toSize = input.sizes.get(edge.to) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
      // ELK routes to distributed border points; fall back to the midpoints
      // of the two sides this direction actually connects, only if the route
      // is missing entirely.
      const points = dedupePoints(route ?? [
        exitPoint(fromPosition, fromSize, input.direction),
        entryPoint(toPosition, toSize, input.direction),
      ]);
      return {
        points,
        rounded: false,
        ...(label ? { label } : {}),
        ...(withheld.has(edge) ? { placeLabel: true } : {}),
      };
    }),
  };
}

/**
 * Daylight two neighbours in a tree owe each other, measured against the
 * smaller of the two.
 *
 * mrtree gives every neighbour the board's node spacing, which is a number
 * chosen for boxes. Two words of bare text are not boxes: eighty pixels of
 * daylight around twenty-six pixels of ink is three parts air to one part
 * drawing, and the row of leaves it draws is a column of things stranded from
 * each other and from the branch they hang off.
 */
const TREE_GAP_RATIO = 0.4;
/** Below this two neighbours read as one thing however small they are. */
const MIN_TREE_GAP = 24;
/**
 * How much more daylight a whole subtree owes its neighbour than one leaf owes
 * the next. With one gap for every neighbour, eight leaves under three
 * managers read as one row of eight; the hierarchy is in the drawing only if
 * the space between two groups says they are two groups.
 */
const TREE_GROUP_SPREAD = 1.75;
/**
 * How far apart two boxes on one rank may be before a common width is the
 * wrong answer.
 *
 * A rank of an org chart is a rank of peers, and peers are drawn the same
 * size: what a reader takes from one box being half again as wide as the one
 * beside it is that the two are different kinds of thing. Widening every box
 * to the widest is only the right answer while the widest is not so much
 * wider that the narrow ones become boxes of air, so a rank carrying one
 * outlier keeps its own widths.
 */
const TREE_COMMON_WIDTH_RATIO = 2;

/**
 * Re-seats a tree across the axis its siblings stack on, and gives one rank
 * one width.
 *
 * The ranks ELK laid out are kept exactly: this changes only how much room
 * each subtree is given beside the next, where a parent stands over the
 * children it owns, and how wide the boxes on one rank are drawn. Anything
 * that is not a plain tree -- a node with two parents, a cycle, a node no
 * root reaches -- is handed back untouched.
 */
function tidyTree(
  input: GeometryInput,
  positions: ReadonlyMap<string, RoutePoint>,
): { positions: Map<string, RoutePoint>; sizes: Map<string, Size> } | null {
  const parentOf = new Map<string, string>();
  for (const edge of input.edges) {
    if (edge.from === edge.to || parentOf.has(edge.to)) return null;
    parentOf.set(edge.to, edge.from);
  }
  const alongWidth = portsSpreadAlongWidth(input.direction);
  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const extentOf = (id: string) => (alongWidth ? sizeOf(id).width : sizeOf(id).height);
  const seatOf = (id: string) => {
    const point = positions.get(id) ?? { x: 0, y: 0 };
    return alongWidth ? point.x : point.y;
  };
  const ids = input.params.nodes.map((node) => node.id);
  const childrenOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [child, parent] of parentOf) childrenOf.get(parent)?.push(child);
  for (const list of childrenOf.values()) {
    list.sort((a, b) => seatOf(a) - seatOf(b) || (a < b ? -1 : 1));
  }
  const roots = ids.filter((id) => !parentOf.has(id));
  if (roots.length === 0) return null;

  const depth = new Map<string, number>();
  const walk = (id: string, level: number): boolean => {
    if (depth.has(id)) return false;
    depth.set(id, level);
    return (childrenOf.get(id) ?? []).every((child) => walk(child, level + 1));
  };
  if (!roots.every((id) => walk(id, 0)) || depth.size !== ids.length) return null;

  // One rank, one width. Bare text is left out of it: a caption is drawn at
  // its own left edge, so padding its box out to a common width moves the
  // words off the line the rest of the rank is drawn on rather than centring
  // them in anything.
  const sized = new Map<string, Size>(ids.map((id) => [id, { ...sizeOf(id) }]));
  const ranks = new Map<number, string[]>();
  for (const id of ids) {
    if (nodeToType(input.params.nodes.find((node) => node.id === id)!) === "text") continue;
    ranks.set(depth.get(id)!, [...(ranks.get(depth.get(id)!) ?? []), id]);
  }
  for (const rank of ranks.values()) {
    const extents = rank.map(extentOf);
    const widest = Math.max(...extents);
    if (widest > Math.min(...extents) * TREE_COMMON_WIDTH_RATIO) continue;
    for (const id of rank) {
      const size = sized.get(id)!;
      if (alongWidth) size.width = widest;
      else size.height = widest;
    }
  }
  // The room two neighbours owe each other is measured against the ink, not
  // against the padding a common width just added: a rank widened to its
  // widest box and then spaced as if every box were that wide is a board that
  // grew twice for one change.
  const commonExtent = (id: string) => (alongWidth ? sized.get(id)!.width : sized.get(id)!.height);

  const heightOf = new Map<string, number>();
  const measure = (id: string): number => {
    const own = (childrenOf.get(id) ?? []).reduce((tallest, child) => Math.max(tallest, measure(child) + 1), 0);
    heightOf.set(id, own);
    return own;
  };
  for (const id of roots) measure(id);
  const gapBetween = (a: string, b: string) => {
    const base = Math.max(MIN_TREE_GAP, TREE_GAP_RATIO * Math.min(extentOf(a), extentOf(b)));
    const group = TREE_GROUP_SPREAD ** Math.max(heightOf.get(a) ?? 0, heightOf.get(b) ?? 0);
    return snapModelCoordinate(base * group);
  };

  const seats = new Map<string, number>();
  const shift = (id: string, delta: number) => {
    seats.set(id, (seats.get(id) ?? 0) + delta);
    for (const child of childrenOf.get(id) ?? []) shift(child, delta);
  };
  const centreOf = (id: string) => (seats.get(id) ?? 0) + commonExtent(id) / 2;
  // Bottom up: a subtree takes the room its children need, and the parent
  // stands opposite the middle of its first and last child rather than the
  // middle of everything hanging off them. A deeper subtree on one side pulls
  // the parent past the child it is meant to sit beside, and the fan of
  // connectors that comes out of it doubles back over itself.
  const place = (id: string, start: number): number => {
    const children = childrenOf.get(id) ?? [];
    const own = commonExtent(id);
    if (children.length === 0) {
      seats.set(id, start);
      return own;
    }
    let at = start;
    children.forEach((child, index) => {
      if (index > 0) at += gapBetween(children[index - 1], child);
      at += place(child, at);
    });
    const middle = (centreOf(children[0]) + centreOf(children[children.length - 1])) / 2;
    let seat = middle - own / 2;
    if (seat < start) {
      const delta = start - seat;
      for (const child of children) shift(child, delta);
      at += delta;
      seat = start;
    }
    seats.set(id, seat);
    return Math.max(at, seat + own) - start;
  };
  let at = 0;
  roots.forEach((id, index) => {
    if (index > 0) at += gapBetween(roots[index - 1], id);
    at += place(id, at);
  });

  // Every node of one rank starts on one line along the flow, so a fan of
  // leaves is entered at one depth however long the words on it are. mrtree
  // centres a node inside its layer, which leaves a short caption further from
  // its parent than a long one and gives every connector in the fan a
  // different length.
  const flowSize = (id: string) => (alongWidth ? sized.get(id)!.height : sized.get(id)!.width);
  const flowSeat = (id: string) => {
    const point = positions.get(id) ?? { x: 0, y: 0 };
    return alongWidth ? point.y : point.x;
  };
  const forwards = input.direction === "DOWN" || input.direction === "RIGHT";
  const lineOf = new Map<number, number>();
  for (const id of ids) {
    const level = depth.get(id)!;
    const leading = forwards ? flowSeat(id) : flowSeat(id) + flowSize(id);
    const found = lineOf.get(level);
    lineOf.set(level, found === undefined ? leading
      : forwards ? Math.min(found, leading) : Math.max(found, leading));
  }

  return {
    positions: new Map(ids.map((id) => {
      // Bare text is not a box and does not stand on the box grid, so it keeps
      // the exact seat it was given. Rounding it would cost a fan of two
      // leaves its symmetry: a caption is twenty-six pixels tall, so the pair
      // straddling its parent's centre line rounds one way and then the other.
      const text = nodeToType(input.params.nodes.find((node) => node.id === id)!) === "text";
      const raw = seats.get(id) ?? 0;
      const seat = text ? raw : snapModelCoordinate(raw);
      const line = lineOf.get(depth.get(id)!)!;
      const along = forwards ? line : line - flowSize(id);
      return [id, alongWidth ? { x: seat, y: along } : { x: along, y: seat }];
    })),
    sizes: sized,
  };
}

/** Which sides a parent leaves and a child is entered on, per flow direction. */
const TREE_PORT_SIDES: Record<DiagramDirection, { from: Side; to: Side }> = {
  DOWN: { from: "bottom", to: "top" },
  UP: { from: "top", to: "bottom" },
  RIGHT: { from: "right", to: "left" },
  LEFT: { from: "left", to: "right" },
};

const NON_LAYERED_OPTIONS: Record<Exclude<DiagramAlgorithm, "layered">, Record<string, string>> = {
  tree: { "elk.algorithm": "mrtree" },
  radial: { "elk.algorithm": "radial" },
  // A fixed seed is the whole reason these two are usable: without it the
  // same graph lands somewhere different on every call.
  force: { "elk.algorithm": "force", "elk.randomSeed": "1" },
  stress: { "elk.algorithm": "stress", "elk.randomSeed": "1" },
};

/**
 * The line each parent's fan of children splits on, by parent.
 *
 * Every child of one parent leaves by the middle of the parent's side and
 * runs to this line before it turns, so what a reader sees is one connector
 * out of the box that divides, rather than one stub per child spread along
 * the side. The line sits halfway between the parent's own edge and the
 * nearest child's, which is the middle of the gap between the two ranks and
 * therefore the same line for every fan hanging off that rank.
 */
function trunkLines(
  boxes: ReadonlyMap<string, RouteBox>,
  edges: readonly GraphEdge[],
  sides: { from: Side; to: Side },
): Map<string, number> {
  const leaves = (box: RouteBox) => {
    if (sides.from === "bottom") return box.y + box.height;
    if (sides.from === "top") return box.y;
    if (sides.from === "right") return box.x + box.width;
    return box.x;
  };
  const arrives = (box: RouteBox) => {
    if (sides.to === "top") return box.y;
    if (sides.to === "bottom") return box.y + box.height;
    if (sides.to === "left") return box.x;
    return box.x + box.width;
  };
  const children = new Map<string, RouteBox[]>();
  for (const edge of edges) {
    const child = boxes.get(edge.to);
    if (!boxes.has(edge.from) || !child) continue;
    children.set(edge.from, [...(children.get(edge.from) ?? []), child]);
  }
  const lines = new Map<string, number>();
  for (const [parent, kids] of children) {
    const exit = leaves(boxes.get(parent)!);
    const nearest = kids
      .map(arrives)
      .reduce((best, at) => (Math.abs(at - exit) < Math.abs(best - exit) ? at : best));
    // Half a rank gap is not always a whole grid cell, and a bus off the grid
    // draws the one connector on the board that does not line up with the
    // rest. Both ends of the gap are on the grid, so the middle is on it or
    // on its half; taking the nearer cell keeps every fan on one line.
    const line = snapModelCoordinate((exit + nearest) / 2);
    if ((line - exit) * (nearest - exit) > 0 && Math.abs(line - exit) < Math.abs(nearest - exit)) {
      lines.set(parent, line);
    }
  }
  return lines;
}

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
/**
 * The hub of a star, or nothing.
 *
 * A star is the shape a hub-and-spoke request actually asks for: one node
 * every other node hangs off, and no other edges at all. Anything with a
 * second level or a spoke-to-spoke link is a tree, and a tree is what the
 * radial algorithm is for.
 */
export function starHub(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string | null {
  const ids = nodes.map((node) => node.id);
  if (ids.length < 3 || edges.length !== ids.length - 1) return null;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.from === edge.to) return null;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const hub = ids.find((id) => degree.get(id) === ids.length - 1);
  if (!hub) return null;
  return ids.every((id) => id === hub || degree.get(id) === 1) ? hub : null;
}

/** The bearing the first spoke takes: straight up, the way a clock starts. */
const RING_START_BEARING = -Math.PI / 2;

/** How many times the ring is widened before the widest answer is taken. */
const MAX_RING_STEPS = 40;
/** How far around the ideal seat the grid is searched, in cells. */
const RING_SEAT_SEARCH = 2;
/** What a step across the bearing costs against a step along it. */
const RING_BEARING_WEIGHT = 2;

/** Half a box's extent along a bearing: where its outline stands. */
function reachAlong(size: { width: number; height: number }, bearing: number): number {
  const across = Math.abs(Math.cos(bearing));
  const along = Math.abs(Math.sin(bearing));
  return Math.min(
    across > 1e-9 ? size.width / 2 / across : Number.POSITIVE_INFINITY,
    along > 1e-9 ? size.height / 2 / along : Number.POSITIVE_INFINITY,
  );
}

/**
 * Rings a star's spokes at even bearings, one daylight apart from the hub.
 *
 * The radial algorithm places a general tree and its answer for a plain star
 * is a ring at whatever angles fall out of the order the spokes arrived in:
 * three of them bunched across the top and two corners left empty. A star has
 * one honest arrangement, which is every spoke a turn of the circle apart.
 *
 * What a reader measures is not the radius but the daylight: how far each
 * spoke stands off the hub, which is the length of the connector between them.
 * A ring of one radius around a hub half as tall as it is wide leaves the two
 * spokes beside it a hundred pixels of it and the one above it two hundred and
 * twenty, and the ring reads as buckled. Each spoke is seated the same
 * daylight off the hub's own outline instead, and the ring widens until no two
 * spokes stand closer than anything else on the board does.
 */
function starRing(input: GeometryInput, hub: string): Map<string, RoutePoint> {
  const sizeOf = (id: string) => input.sizes.get(id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
  const spokes = input.params.nodes.map((node) => node.id).filter((id) => id !== hub);
  const bearings = spokes.map((_, index) => RING_START_BEARING + (2 * Math.PI * index) / spokes.length);
  // Every centre lands on the grid downstream, and the nearest grid point to
  // the one the bearing asked for is up to half a cell off it in any
  // direction. Off along the spoke that costs a few pixels of daylight; off
  // across it that is the bearing itself, which at this radius is two degrees
  // of a turn a reader is being asked to read as even. So the seat is chosen
  // from the grid points around the ideal one, counting a step across the
  // bearing for several times a step along it.
  const seat = (ideal: RoutePoint, bearing: number): RoutePoint => {
    const origin = { x: snapModelCoordinate(ideal.x), y: snapModelCoordinate(ideal.y) };
    let best = origin;
    let cost = Number.POSITIVE_INFINITY;
    for (let dx = -RING_SEAT_SEARCH; dx <= RING_SEAT_SEARCH; dx++) {
      for (let dy = -RING_SEAT_SEARCH; dy <= RING_SEAT_SEARCH; dy++) {
        const point = { x: origin.x + dx * MODEL_GRID_SIZE, y: origin.y + dy * MODEL_GRID_SIZE };
        const offX = point.x - ideal.x;
        const offY = point.y - ideal.y;
        const across = Math.abs(offX * -Math.sin(bearing) + offY * Math.cos(bearing));
        const along = Math.abs(offX * Math.cos(bearing) + offY * Math.sin(bearing));
        const score = across * RING_BEARING_WEIGHT + along;
        if (score < cost) {
          cost = score;
          best = point;
        }
      }
    }
    return best;
  };
  const ring = (daylight: number) => {
    const centers = new Map<string, RoutePoint>([[hub, { x: 0, y: 0 }]]);
    for (const [index, id] of spokes.entries()) {
      const bearing = bearings[index];
      const radius = reachAlong(sizeOf(hub), bearing) + daylight + reachAlong(sizeOf(id), bearing);
      centers.set(id, seat({ x: Math.cos(bearing) * radius, y: Math.sin(bearing) * radius }, bearing));
    }
    return centers;
  };
  const clears = (centers: ReadonlyMap<string, RoutePoint>) => {
    const ids = [...centers.keys()];
    return ids.every((first, index) => ids.slice(index + 1).every((second) => {
      const here = centers.get(first)!;
      const there = centers.get(second)!;
      const gapX = Math.abs(here.x - there.x) - (sizeOf(first).width + sizeOf(second).width) / 2;
      const gapY = Math.abs(here.y - there.y) - (sizeOf(first).height + sizeOf(second).height) / 2;
      return Math.max(gapX, gapY) >= input.nodeSpacing;
    }));
  };
  let centers = ring(input.nodeSpacing);
  for (let step = 1; step <= MAX_RING_STEPS && !clears(centers); step++) {
    centers = ring(input.nodeSpacing + step * MODEL_GRID_SIZE);
  }
  return centers;
}

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
  const hub = algorithm === "radial" ? starHub(input.params.nodes, input.edges) : null;
  const rawCenters = hub
    ? starRing(input, hub)
    : new Map<string, RoutePoint>((result.children ?? []).map((node: ElkNode) => {
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
  const spread = new Map<string, RoutePoint>([...rawCenters].map(([id, center]) => {
    const size = sizeOf(id);
    return [id, {
      x: snapModelCoordinate(anchor.x + (center.x - anchor.x) * scale - size.width / 2),
      y: snapModelCoordinate(anchor.y + (center.y - anchor.y) * scale - size.height / 2),
    }];
  }));
  // mrtree spaces every neighbour alike; a hierarchy is read from the space
  // between its parts, so the tree is re-seated across the axis it stacks on
  // and every rank is drawn one width.
  const tidied = algorithm === "tree" ? tidyTree(input, spread) : null;
  const positions = tidied?.positions ?? spread;
  const sizes = tidied?.sizes ?? input.sizes;
  const drawnSize = (id: string) => sizes.get(id) ?? sizeOf(id);
  const snapDeltas = new Map<string, SnapDelta>();
  // A ring is our own placement, so ELK's routes and the deltas that would
  // carry them across no longer describe anything on the board.
  for (const node of hub ? [] : result.children ?? []) {
    const snapped = positions.get(node.id);
    if (!snapped) continue;
    snapDeltas.set(node.id, { dx: snapped.x - finiteNumber(node.x), dy: snapped.y - finiteNumber(node.y) });
  }
  const boxes = new Map<string, RouteBox>(input.params.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    return [node.id, { id: node.id, x: position.x, y: position.y, ...drawnSize(node.id) }];
  }));
  const placedBoxes = [...boxes.values()];
  for (let a = 0; a < placedBoxes.length; a++) {
    for (let b = a + 1; b < placedBoxes.length; b++) {
      if (boxesTouch(placedBoxes[a], placedBoxes[b])) {
        return { reason: `${algorithm} left nodes overlapping even after spreading` };
      }
    }
  }
  // A hierarchy reads as one when every child is entered from the parent's
  // side of it. Letting each edge pick the nearest border instead lands the
  // arrow on a child's flank and the chart reads as a web.
  const flowSides = algorithm === "tree" ? TREE_PORT_SIDES[input.direction] : undefined;
  const trunkAt = flowSides ? trunkLines(boxes, input.edges, flowSides) : null;
  const requests: RouteRequest[] = input.edges.map((edge, index) => {
    const { section } = elkSection(result, index);
    const raw = section && !hub
      ? dedupeNearPoints([section.startPoint, ...(section.bendPoints ?? []), section.endPoint])
      : undefined;
    const trunk = trunkAt?.get(edge.from);
    return {
      id: `edge-${index}`,
      from: edge.from,
      to: edge.to,
      ...(flowSides ? { sides: flowSides } : {}),
      ...(trunk !== undefined ? { trunk } : {}),
      // A trunk is drawn against the bus, not re-anchored off ELK's channel.
      ...(raw && trunk === undefined ? { route: raw } : {}),
    };
  });
  const attachments = new Map(requests.map((request) => [
    request.id,
    { from: request.from, to: request.to, ...(request.trunk !== undefined ? { trunk: true } : {}) },
  ]));

  const minSteps = new Map<string, number>();
  // A ringed hub attaches on bearings, not on side slots, so the fan of
  // spokes is as evenly spread as the ring the algorithm placed.
  const radialPorts = algorithm === "radial";
  let routes = planRoutes(boxes, requests, { snapDeltas, minSteps, radialPorts });
  for (let round = 0; round < MAX_ROUTE_REPAIR_ITERATIONS; round++) {
    const guilty = routeDefects(boxes, routes, attachments);
    if (guilty.size === 0) break;
    if (round === MAX_ROUTE_REPAIR_ITERATIONS - 1) {
      return { reason: `${algorithm} routes still crossed nodes after ${MAX_ROUTE_REPAIR_ITERATIONS} repair rounds` };
    }
    // Push each still-guilty edge onto a wider arc so the next round cannot
    // reproduce the answer that failed.
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(boxes, requests, { snapDeltas, minSteps, radialPorts });
  }

  const placed: RouteBox[] = [...boxes.values()];
  const edgeGeometry: EdgeGeometry[] = input.edges.map((edge, index) => {
    const route = routes[index];
    const trunk = trunkAt?.has(edge.from) ? { trunk: edge.from } : {};
    const text = edge.label?.trim();
    if (!text) return { points: route.points, rounded: route.rounded, ...trunk };
    // ELK hands back (0,0) for every edge label under mrtree and radial, so
    // the label is placed against the route we actually drew.
    const size = measureText(text, EDGE_LABEL_FONT_SIZE);
    const label = placeEdgeLabel(route.points, size, placed);
    placed.push({ id: `label-${index}`, x: label.x, y: label.y, ...size });
    return { points: route.points, rounded: route.rounded, label, ...trunk };
  });

  return {
    geometry: {
      positions,
      sizes,
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
  // A layer gap reads against the side of the node it separates. Nodes are
  // wide and short, so the same number that looks right between two columns
  // leaves a vertical flow strung out down the page: curated flow charts run
  // roughly one node height between rows and one node width between columns.
  const defaultLayerSpacing = portsSpreadAlongWidth(direction) ? 100 : 140;
  const layerSpacing = Math.min(
    360,
    Math.max(80, snapModelCoordinate(params.layout?.layerSpacing, defaultLayerSpacing)),
  );

  const degreeIn = new Map<string, number>();
  const degreeOut = new Map<string, number>();
  for (const edge of edges) {
    degreeOut.set(edge.from, (degreeOut.get(edge.from) ?? 0) + 1);
    degreeIn.set(edge.to, (degreeIn.get(edge.to) ?? 0) + 1);
  }
  // A star's spokes leave the hub on bearings around its outline, not through
  // slots down one side, so the hub owes its connectors no room along an edge:
  // paying for it anyway drew the centre of a seven-spoke map as a rectangle
  // three times taller than it was wide, which reads as a column, not a hub.
  // What the centre does owe the reader is weight, so it is drawn a size up
  // from the things hanging off it.
  const ringHub = (params.layout?.algorithm ?? "layered") === "radial"
    ? starHub(params.nodes, edges)
    : null;
  const sizes = new Map(params.nodes.map((node) => [
    node.id,
    node.size
      ? { width: snapUpSize(node.size.width), height: snapUpSize(node.size.height) }
      : node.id === ringHub
        ? hubDimensions(node, direction)
        : nodeDimensions(node, Math.max(degreeIn.get(node.id) ?? 0, degreeOut.get(node.id) ?? 0), direction),
  ]));
  const containers = planContainers(params);
  const input: GeometryInput = {
    params,
    edges,
    direction,
    sizes,
    nodeSpacing,
    layerSpacing,
    containers,
    containerLabelWidths: containerLabelWidths(params),
  };

  let geometry: LayoutGeometry | null = null;
  let reason: string | undefined;
  // Only the layered engine keeps a nested graph nested; the rest place nodes
  // as free points and would scatter a container's members across the canvas.
  if (requested !== "layered" && containers) {
    reason = `${requested} cannot lay out containers`;
  } else if (requested !== "layered") {
    const attempt = await nonLayeredGeometry(input, requested);
    if ("geometry" in attempt) geometry = attempt.geometry;
    else reason = attempt.reason;
  }
  geometry ??= await layeredGeometry(input, {
    requested,
    used: "layered",
    ...(reason ? { reason } : {}),
  });

  return assemblePlan(params, edges, geometry, origin, diagramId, containers);
}

function assemblePlan(
  params: LayoutParams,
  edges: GraphEdge[],
  geometry: LayoutGeometry,
  origin: { x: number; y: number },
  diagramId: string,
  containerPlan: ContainerPlan | null,
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
  // Every element carries its own identity and its place in the container
  // tree, so a later call can find, restyle, or rebuild exactly this diagram's
  // parts from the live scene alone.
  const stamp = (role: DiagramElementRole, key?: string, container?: string) => ({
    customData: {
      wiley: {
        diagram: diagramId,
        role,
        theme: theme.name,
        ...(key ? { key } : {}),
        ...(container ? { container } : {}),
      },
    },
  });
  const boxes = geometry.containers ?? new Map<string, RouteBox>();
  const drawnContainers = containerPlan
    ? containerPlan.order.filter((id) => boxes.has(id))
    : [];
  const framed = new Set(
    drawnContainers.filter((id) => containerPlan?.byId.get(id)?.render === "frame"),
  );
  /** Innermost group first, matching Excalidraw's own nesting order. */
  const groupsFor = (id: string): string[] => {
    if (!containerPlan) return [];
    const chain = [id, ...containerChain(containerPlan, id)]
      .filter((entry) => boxes.has(entry) && !framed.has(entry));
    return chain.map((entry) => containerGroupId(diagramId, entry));
  };
  const memberGroups = (id: string): JsonObject => {
    if (!containerPlan) return {};
    const owner = containerPlan.ownerOf.get(id);
    const groupIds = owner ? groupsFor(owner) : [];
    return groupIds.length ? { groupIds } : {};
  };

  // A neutral-forward theme leaves an unroled node unfilled. Which way that
  // reads depends on which side the board is mostly on. One filled box among
  // nine bare ones is the focal point the request asked for; two bare boxes
  // among six fills is an oversight, and they take the theme's quiet register
  // instead, which says "no emphasis" in the language the rest of the drawing
  // is already speaking.
  const themeAnswersForUnroled = theme.entries[theme.defaultRole].fill !== "transparent";
  const colored = params.nodes.filter((node) =>
    node.role !== undefined && theme.entries[node.role].fill !== "transparent").length;
  const mostlyColored = colored * 2 > params.nodes.length;
  const unroled: NodeRole | undefined = !themeAnswersForUnroled && mostlyColored ? "muted" : undefined;

  const nodeSkeletons: JsonObject[] = params.nodes.map((node) => {
    const position = geometry.positions.get(node.id) ?? { x: 0, y: 0 };
    const size = geometry.sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const type = nodeToType(node);
    const id = elementIdByNode.get(node.id)!;
    const style = resolveNodeStyle(theme, node.role ?? unroled, node.emphasis, {
      backgroundColor: node.backgroundColor,
      strokeColor: node.strokeColor,
    });
    roles.set(id, { role: "node", key: node.id, ...(node.container ? { container: node.container } : {}) });
    const x = snapModelCoordinate(origin.x + position.x);
    const y = snapModelCoordinate(origin.y + position.y);
    if (type === "text") {
      return {
        id,
        type,
        ...stamp("node", node.id, node.container),
        ...memberGroups(node.id),
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
      ...stamp("node", node.id, node.container),
      ...memberGroups(node.id),
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

  const nodeBoxes: RouteBox[] = params.nodes.map((node) => {
    const position = geometry.positions.get(node.id) ?? { x: 0, y: 0 };
    const size = geometry.sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    return {
      id: node.id,
      x: snapModelCoordinate(origin.x + position.x),
      y: snapModelCoordinate(origin.y + position.y),
      ...size,
    };
  });
  const boxByNode = new Map(nodeBoxes.map((box) => [box.id, box]));
  const outlineByNode = new Map(params.nodes.map((node) => {
    const type = nodeToType(node);
    return [node.id, type === "text" ? "rectangle" : type] as const;
  }));
  const captionNodes = new Set(
    params.nodes.filter((node) => nodeToType(node) === "text").map((node) => node.id),
  );
  /**
   * The route as drawn: shifted to the board's origin, pulled back from a
   * caption's own text, and seated on the shape each end is drawn as rather
   * than on the box the layout reasoned about.
   */
  const seatRoute = (routed: EdgeGeometry, edge: GraphEdge): RoutePoint[] => {
    let points = dedupePoints(routed.points.map((point) => ({
      x: origin.x + point.x,
      y: origin.y + point.y,
    })));
    if (captionNodes.has(edge.from)) points = shortenRouteEnd(points, "start");
    if (captionNodes.has(edge.to)) points = shortenRouteEnd(points, "end");
    if (points.length < 2) return points;
    const meet = (nodeId: string, index: number, neighbour: number) => {
      const box = boxByNode.get(nodeId);
      const outline = outlineByNode.get(nodeId);
      if (!box || !outline || outline === "rectangle") return;
      points[index] = meetOutline(box, outline, points[index], points[neighbour]);
    };
    meet(edge.from, 0, 1);
    meet(edge.to, points.length - 1, points.length - 2);
    return points;
  };
  // Every route is known before any label is placed, so a label can be judged
  // against the lines it does not own as well as the boxes.
  const absoluteRoutes = geometry.edges.map((routed, index) => seatRoute(routed, edges[index]));
  /**
   * Everything the drawing already occupies, before a single caption is put
   * down. A bound label sits centred on its own route, so one riding the run
   * that wraps the outside of the drawing hangs half of itself past the last
   * line on the board, and the whole diagram reads as jammed into the corner
   * of whatever frame it is shown in. That one stands beside its route
   * instead.
   */
  const drawnExtent = (() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const box of [...nodeBoxes, ...boxes.values()]) {
      xs.push(box.x, box.x + box.width);
      ys.push(box.y, box.y + box.height);
    }
    for (const route of absoluteRoutes) {
      for (const point of route) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
    if (xs.length === 0) return null;
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  })();
  const insideDrawing = (box: RouteBox): boolean => drawnExtent === null
    || (box.x >= drawnExtent.left && box.x + box.width <= drawnExtent.right
      && box.y >= drawnExtent.top && box.y + box.height <= drawnExtent.bottom);
  // Laid out as a ring around one centre: every connector on the board is a
  // spoke, and every caption on it names a spoke.
  const ringSpokes = geometry.outcome.used === "radial"
    && starHub(params.nodes, edges) !== null;
  const edgeSkeletons: JsonObject[] = [];
  const edgeLabelSkeletons: JsonObject[] = [];
  // A bound label has no skeleton, so its box exists nowhere else. Anything
  // that places more labels against this plan later needs to see them.
  const boundLabelBoxes: RouteBox[] = [];
  /** Standalone label boxes, in the order they were put down. */
  const placedLabelBoxes: RouteBox[] = [];
  let boundLabelCount = 0;
  for (const [index, edge] of edges.entries()) {
    const routed = geometry.edges[index];
    const absoluteRoute = absoluteRoutes[index];
    const routeOrigin = absoluteRoute[0];
    const key = edgeKeys[index];
    const edgeId = edgeElementId(diagramId, key);
    const edgeStyle = resolveEdgeStyle(theme, edge);
    // An edge belongs to the deepest container holding both of its ends, so a
    // connector inside a region moves and reads with that region.
    const owner = containerPlan ? lowestCommonContainer(containerPlan, edge.from, edge.to) : undefined;
    const ownerChain: string[] = [];
    for (let ancestor = owner; ancestor; ancestor = containerPlan?.ownerOf.get(ancestor)) {
      ownerChain.push(ancestor);
    }
    const ownerGroups = owner && boxes.has(owner) ? groupsFor(owner) : [];
    const edgeGroups: JsonObject = ownerGroups.length ? { groupIds: ownerGroups } : {};
    roles.set(edgeId, {
      role: "edge",
      key,
      edgeIndex: index,
      ...(owner ? { container: owner } : {}),
      ...(routed?.trunk ? { trunk: routed.trunk } : {}),
    });
    const text = edge.label?.trim();
    const labelSize = text ? measureText(text, EDGE_LABEL_FONT_SIZE) : { width: 0, height: 0 };
    // A label rides the arrow when the middle of the route is long enough to
    // carry it, and stands beside the route when it is not. A label the
    // layout never found a place for rides the arrow rather than vanishing.
    const labelMode = edge.labelMode ?? "auto";
    // Labels are placed one after another, so each one has to clear the boxes
    // and every label already put down, not just the nodes.
    const labelGround = [...boundLabelBoxes, ...placedLabelBoxes];
    const anchor = boundLabelAnchor(absoluteRoute);
    const labelBox = {
      id: `${edgeId}:label`,
      x: anchor.x - labelSize.width / 2,
      y: anchor.y - labelSize.height / 2,
      ...labelSize,
    };
    const roomOnTheArrow = boundLabelRoom(absoluteRoute) >= labelSize.width + BOUND_LABEL_CLEARANCE
      // On a star the spokes are the drawing. A bound caption is seated in a
      // gap cut out of the line it names, and a board that does that to every
      // spoke has no spoke drawn whole: seven words, each between two stubs.
      && !ringSpokes
      && insideDrawing(labelBox)
      && boundLabelClears(absoluteRoute, labelSize, nodeBoxes)
      && boundLabelClears(absoluteRoute, labelSize, labelGround, LABEL_MIN_GAP)
      // A label rides its own arrow by construction; landing on somebody
      // else's line is the same kind of mess as landing on a box.
      && absoluteRoutes.every((other, otherIndex) => otherIndex === index
        || !geometryIntersectsBox(routeGeometry(other, geometry.edges[otherIndex].rounded), labelBox, 0));
    const bound = Boolean(text) && (labelMode === "bound" || (labelMode === "auto" && (
      // No spot back from the layout and none withheld means the layout could
      // not place this label at all; riding the arrow beats vanishing.
      (routed.label === undefined && !routed.placeLabel)
      || roomOnTheArrow
    )));
    edgeSkeletons.push({
      id: edgeId,
      type: "arrow",
      ...stamp("edge", key, owner),
      ...edgeGroups,
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
      ...(bound && text ? { label: { text, strokeColor: edgeStyle.labelColor, fontSize: EDGE_LABEL_FONT_SIZE, fontFamily: 5 } } : {}),
    });
    if (!text) continue;
    // A bound label has no skeleton of its own; the converter makes it. It
    // still gets an identity so every check and every later edit can name it.
    const edgeLabelId = edgeLabelElementId(diagramId, key);
    if (bound) {
      boundLabelCount += 1;
      boundLabelBoxes.push({ ...labelBox, id: edgeLabelId });
      roles.set(edgeLabelId, {
        role: "edgeLabel",
        key,
        edgeIndex: index,
        bound: true,
        ...(owner ? { container: owner } : {}),
      });
      continue;
    }
    // The room the layout reserved is room beside the route in principle, but
    // it reserves it before it knows where the route finally went, so the spot
    // it hands back sometimes sits astride a line. A caption with a connector
    // ruled through it reads as struck out, so it is only taken when it is
    // clear of every line on the board.
    const reserved = routed.label
      ? { x: origin.x + routed.label.x, y: origin.y + routed.label.y }
      : undefined;
    // Judged against the caption's own box: a line that clips a glyph reads
    // as a strike-through, and one that runs alongside it does not.
    const onALine = (box: RouteBox): boolean => absoluteRoutes.some((other, otherIndex) =>
      geometryIntersectsBox(
        routeGeometry(other, geometry.edges[otherIndex].rounded),
        box,
        0,
      ));
    const struckThrough = reserved !== undefined
      && onALine({ id: edgeLabelId, x: reserved.x, y: reserved.y, ...labelSize });
    // A label the layout kept no room for, or put on a line, still has to go
    // somewhere: beside the route, clear of the boxes, the way every unlayered
    // algorithm places one.
    const spot = reserved && !struckThrough
      ? reserved
      : placeEdgeLabel(absoluteRoute, labelSize, [
        // A region the edge is not a member of is not a place its label may
        // land: inside one, it reads as belonging to that region.
        ...[...boxes.entries()]
          .filter(([id]) => !ownerChain.includes(id))
          .map(([, box]) => box),
        ...nodeBoxes,
        // Only the labels claim clear space around themselves; a caption may
        // sit right against a box, but never right against another caption.
        ...labelGround.map((box) => ({
          id: box.id,
          x: box.x - LABEL_MIN_GAP,
          y: box.y - LABEL_MIN_GAP,
          width: box.width + LABEL_MIN_GAP * 2,
          height: box.height + LABEL_MIN_GAP * 2,
        })),
      ], onALine);
    placedLabelBoxes.push({ id: edgeLabelId, x: spot.x, y: spot.y, ...labelSize });
    roles.set(edgeLabelId, { role: "edgeLabel", key, edgeIndex: index, ...(owner ? { container: owner } : {}) });
    edgeLabelSkeletons.push({
      id: edgeLabelId,
      type: "text",
      ...stamp("edgeLabel", key, owner),
      ...edgeGroups,
      x: spot.x,
      y: spot.y,
      width: labelSize.width,
      height: labelSize.height,
      text,
      fontSize: EDGE_LABEL_FONT_SIZE,
      fontFamily: 5,
      strokeColor: edgeStyle.labelColor,
      backgroundColor: "transparent",
    });
  }

  const regionSkeletons: JsonObject[] = [];
  const frameSkeletons: JsonObject[] = [];
  const containerEntries = new Map<string, DiagramContainerEntry>();
  for (const containerId of drawnContainers) {
    const container = containerPlan!.byId.get(containerId)!;
    const box = boxes.get(containerId)!;
    const role = container.role ?? "muted";
    const entry = theme.entries[role];
    const elementId = containerElementId(diagramId, containerId);
    const parent = containerPlan!.ownerOf.get(containerId);
    const label = container.label?.trim();
    const x = snapModelCoordinate(origin.x + box.x);
    const y = snapModelCoordinate(origin.y + box.y);
    containerEntries.set(containerId, {
      id: containerId,
      elementId,
      render: container.render ?? "group",
      ...(parent ? { parent } : {}),
      ...(label ? { label } : {}),
    });
    roles.set(elementId, { role: "container", key: containerId, ...(parent ? { container: parent } : {}) });
    if (framed.has(containerId)) {
      frameSkeletons.push({
        id: elementId,
        type: "frame",
        ...stamp("container", containerId, parent),
        // Never rely on the converter's auto-fit: it falls back to the
        // children's own bounds the moment a coordinate reads as falsy.
        x,
        y,
        width: box.width,
        height: box.height,
        ...(label ? { name: label } : {}),
        children: (containerPlan!.memberNodes.get(containerId) ?? [])
          .map((nodeId) => elementIdByNode.get(nodeId)!),
      });
      continue;
    }
    regionSkeletons.push({
      id: elementId,
      type: "rectangle",
      ...stamp("container", containerId, parent),
      ...(groupsFor(containerId).length ? { groupIds: groupsFor(containerId) } : {}),
      x,
      y,
      width: box.width,
      height: box.height,
      strokeColor: entry.stroke,
      backgroundColor: resolveContainerTint(theme, role),
      strokeWidth: 1,
      opacity: 100,
      fillStyle: "solid",
      roundness: { type: 3 },
    });
    if (!label) continue;
    const labelId = containerLabelElementId(diagramId, containerId);
    const labelSize = measureText(label, CONTAINER_LABEL_FONT_SIZE);
    roles.set(labelId, { role: "containerLabel", key: containerId, container: containerId });
    regionSkeletons.push({
      id: labelId,
      type: "text",
      ...stamp("containerLabel", containerId, containerId),
      ...(groupsFor(containerId).length ? { groupIds: groupsFor(containerId) } : {}),
      x: x + CONTAINER_LABEL_INSET.x,
      y: y + CONTAINER_LABEL_INSET.y,
      width: labelSize.width,
      height: labelSize.height,
      text: label,
      fontSize: CONTAINER_LABEL_FONT_SIZE,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: entry.stroke,
      backgroundColor: "transparent",
    });
  }
  // A frame owns its members through the array, so they are moved to sit
  // immediately in front of it and nothing else may come between.
  const framedNodeIds = new Set(
    [...framed].flatMap((id) => (containerPlan?.memberNodes.get(id) ?? [])
      .map((nodeId) => elementIdByNode.get(nodeId)!)),
  );
  const framedGroups = frameSkeletons.map((frame) => [
    ...nodeSkeletons.filter(
      (skeleton) => (frame.children as string[]).includes(String(skeleton.id)),
    ),
    frame,
  ]);

  const title = params.title?.trim();
  // A title names the drawing, so it is measured against the drawing and not
  // against the origin the layout happened to start from. Centred over what
  // was actually drawn, with one clear band of headroom above the topmost
  // thing on the board: a title pinned to the origin of a tree ends up in the
  // far corner with the apex it names a third of the board away, which is the
  // marooned caption a reader notices before they read anything else.
  const titleSize = title ? measureText(title, TITLE_FONT_SIZE) : { width: 0, height: 0 };
  // Measured over the ink and nothing else. The origin is where the layout was
  // asked to start, not something anybody can see, and a radial board leaves
  // it hundreds of pixels above and to the left of the first thing drawn:
  // including it hangs the title in empty space off one corner of the board.
  const drawnBoxes = [
    ...[...regionSkeletons, ...nodeSkeletons, ...edgeLabelSkeletons].map((skeleton) => ({
      x: finiteNumber(skeleton.x, origin.x),
      y: finiteNumber(skeleton.y, origin.y),
      width: finiteNumber(skeleton.width),
    })),
    ...absoluteRoutes.flat().map((point) => ({ x: point.x, y: point.y, width: 0 })),
  ];
  const drawnTop = Math.min(...drawnBoxes.map((box) => box.y));
  const drawnLeft = Math.min(...drawnBoxes.map((box) => box.x));
  const drawnRight = Math.max(...drawnBoxes.map((box) => box.x + box.width));
  const titleLeft = (drawnLeft + drawnRight - titleSize.width) / 2;
  // Headroom is the band a reader sees between the title and the drawing, so
  // it is measured against what actually stands under the title. A board whose
  // topmost ink is a leaf off in one corner would otherwise push the title a
  // corner's height clear of everything it names, and the caption reads as
  // marooned even though it is centred correctly.
  const beneathTitle = drawnBoxes.filter((box) => box.x + box.width >= titleLeft - TITLE_HEADROOM
    && box.x <= titleLeft + titleSize.width + TITLE_HEADROOM);
  const headroomFrom = beneathTitle.length > 0
    ? Math.min(...beneathTitle.map((box) => box.y))
    : drawnTop;
  // Still above every last thing on the board: a title level with a corner of
  // the drawing reads as one more caption on it.
  const titleBottom = Math.min(headroomFrom - TITLE_HEADROOM, drawnTop - LABEL_MIN_GAP);
  const titleId = titleElementId(diagramId);
  if (title) roles.set(titleId, { role: "title" });
  const skeletons: JsonObject[] = [
    ...(title ? [{
      id: titleId,
      type: "text",
      ...stamp("title"),
      x: snapModelCoordinate(titleLeft),
      y: snapModelCoordinate(titleBottom - titleSize.height),
      width: titleSize.width,
      height: titleSize.height,
      text: title,
      fontSize: TITLE_FONT_SIZE,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "middle",
      strokeColor: theme.titleColor,
      backgroundColor: "transparent",
    }] : []),
    // Regions sit behind everything they hold; frames come last, each one
    // directly behind the members it owns.
    ...regionSkeletons,
    ...nodeSkeletons.filter((skeleton) => !framedNodeIds.has(String(skeleton.id))),
    ...edgeSkeletons,
    ...edgeLabelSkeletons,
    ...framedGroups.flat(),
  ];

  return {
    skeletons,
    nodeCount: params.nodes.length,
    edgeCount: edges.length,
    edgeLabelCount: edgeLabelSkeletons.length + boundLabelCount,
    elementIdByNode,
    diagramId,
    roles,
    containers: containerEntries,
    theme: theme.name,
    explicitColors,
    boundLabelBoxes,
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

/**
 * The skeleton converter reads a frame's geometry as `frame.x || minX`, so a
 * coordinate of exactly zero silently hands the frame back to auto-fit around
 * its children. Growing the box by one grid cell instead of moving it keeps
 * every member where the layout put it.
 */
export function guardFrameAutoFit(plan: DiagramPlan): void {
  for (const skeleton of plan.skeletons) {
    if (skeleton.type !== "frame") continue;
    if (skeleton.x === 0) {
      skeleton.x = -MODEL_GRID_SIZE;
      skeleton.width = finiteNumber(skeleton.width) + MODEL_GRID_SIZE;
    }
    if (skeleton.y === 0) {
      skeleton.y = -MODEL_GRID_SIZE;
      skeleton.height = finiteNumber(skeleton.height) + MODEL_GRID_SIZE;
    }
  }
}

/** The smallest shape a converted element has to expose to be re-seated. */
type PlacedElement = { id: string; type: string; x: number; y: number; height: number };

/**
 * The converter drags a standalone text element that an arrow binds to onto
 * that arrow's far endpoint, so a text-shaped node lands nowhere near the
 * caption position the layout measured and routed to. Nothing else in the
 * scene moves, so putting the text back on its planned centre is enough: the
 * arrow already ends exactly there.
 */
export function restoreTextNodeGeometry(plan: DiagramPlan, created: readonly PlacedElement[]): void {
  const planned = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
  for (const element of created) {
    if (element.type !== "text") continue;
    if (plan.roles.get(element.id)?.role !== "node") continue;
    const skeleton = planned.get(element.id);
    if (!skeleton) continue;
    // The converter re-measures the line box against the real font; keep its
    // height and re-centre on the planned one so the caption sits where the
    // arrow points.
    const plannedCentre = finiteNumber(skeleton.y) + finiteNumber(skeleton.height) / 2;
    element.x = finiteNumber(skeleton.x);
    element.y = plannedCentre - element.height / 2;
  }
}

/** Shifts a plan wholesale; arrow points are relative and move with x/y. */
export function translatePlan(plan: DiagramPlan, dx: number, dy: number): void {
  for (const skeleton of plan.skeletons) {
    if (typeof skeleton.x === "number") skeleton.x += dx;
    if (typeof skeleton.y === "number") skeleton.y += dy;
  }
}
