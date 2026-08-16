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
/** Clear space a bound label needs on either side before auto mode uses one. */
export const BOUND_LABEL_CLEARANCE = 24;
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

function snapUpSize(value: number): number {
  return Math.max(MODEL_GRID_SIZE, Math.ceil(value / MODEL_GRID_SIZE) * MODEL_GRID_SIZE);
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
    layoutOptions: { "elk.padding": CONTAINER_PADDING_OPTION },
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
 * Longest side over shortest, over the whole graph ELK reports: the boxes plus
 * the channels and label room it reserved around them. That is the drawing a
 * reader is handed, and a flow whose connectors need as much room as its boxes
 * is not a ribbon however narrow the boxes are.
 */
function aspect(node: ElkNode): number {
  const width = finiteNumber(node.width);
  const height = finiteNumber(node.height);
  if (width <= 0 || height <= 0) return 1;
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
/** The shape a folded flow aims for; ELK treats it as a hint, not a promise. */
const TARGET_ASPECT = "1.6";

/** How many ranks the flow advanced through, read off the placed children. */
function layerCount(node: ElkNode, direction: DiagramDirection): number {
  const alongY = portsSpreadAlongWidth(direction);
  return new Set((node.children ?? [])
    .map((child) => Math.round(finiteNumber(alongY ? child.y : child.x)))).size;
}

/**
 * Folds a flow that came out as a ribbon onto more than one row.
 *
 * A twelve-stage pipeline laid out RIGHT is fifteen times wider than it is
 * tall, and nothing about the drawing survives being scaled to fit a page.
 * ELK's wrapping splits the chain into rows that still read in order, which
 * is exactly what a person drawing the same pipeline by hand would do. It
 * only runs when the first attempt really is a ribbon, and the fold is kept
 * only if it actually made the drawing squarer: on some graphs wrapping
 * leaves a single node stranded on a row of its own, which is worse than the
 * ribbon it replaced.
 */
async function foldLongFlow(
  graph: GeometryInput,
  laid: ElkNode,
  options: Record<string, string>,
): Promise<ElkNode> {
  // A region is a column of the drawing and folding one is not a fold, it is
  // a scramble, so a nested graph keeps the shape it was given.
  if (graph.containers) return laid;
  if (aspect(laid) <= RIBBON_ASPECT || layerCount(laid, graph.direction) < MIN_FOLD_LAYERS) return laid;
  try {
    const folded = await elk.layout(elkGraph(graph, {
      ...options,
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
      "elk.aspectRatio": TARGET_ASPECT,
    }));
    return aspect(folded) < aspect(laid) ? folded : laid;
  } catch {
    // Wrapping refuses some graphs outright. The ribbon is still a drawing.
    return laid;
  }
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
  const result = await foldLongFlow(graph, await elk.layout(elkGraph(graph, options)), options);
  const absolute = resolveAbsolute(result);
  const positions = new Map<string, RoutePoint>(input.params.nodes.map((node) => {
    const box = absolute.boxes.get(node.id);
    return [node.id, { x: snapModelCoordinate(box?.x), y: snapModelCoordinate(box?.y) }];
  }));
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
  // A hierarchy reads as one when every child is entered from the parent's
  // side of it. Letting each edge pick the nearest border instead lands the
  // arrow on a child's flank and the chart reads as a web.
  const flowSides = algorithm === "tree" ? TREE_PORT_SIDES[input.direction] : undefined;
  const requests: RouteRequest[] = input.edges.map((edge, index) => {
    const { section } = elkSection(result, index);
    const raw = section
      ? dedupeNearPoints([section.startPoint, ...(section.bendPoints ?? []), section.endPoint])
      : undefined;
    return {
      id: `edge-${index}`,
      from: edge.from,
      to: edge.to,
      ...(flowSides ? { sides: flowSides } : {}),
      ...(raw ? { route: raw } : {}),
    };
  });
  const attachments = new Map(requests.map((request) => [request.id, { from: request.from, to: request.to }]));

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
  const sizes = new Map(params.nodes.map((node) => [
    node.id,
    node.size
      ? { width: snapUpSize(node.size.width), height: snapUpSize(node.size.height) }
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

  // A neutral-forward theme leaves an unroled node unfilled, which is right on
  // a board where nothing is coloured and wrong on one where most things are:
  // beside six fills the two bare boxes read as an oversight rather than as a
  // decision. On a board that has already committed to colour they take the
  // theme's quiet register, which says "no emphasis" in the language the rest
  // of the drawing is speaking.
  const themeAnswersForUnroled = theme.entries[theme.defaultRole].fill !== "transparent";
  const boardUsesColor = params.nodes.some((node) =>
    node.role !== undefined && theme.entries[node.role].fill !== "transparent");
  const unroled: NodeRole | undefined = !themeAnswersForUnroled && boardUsesColor ? "muted" : undefined;

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
    roles.set(edgeId, { role: "edge", key, edgeIndex: index, ...(owner ? { container: owner } : {}) });
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
    // A label the layout kept no room for still has to go somewhere: beside
    // the route, clear of the boxes, the way every unlayered algorithm places
    // one.
    const spot = routed.label
      ? { x: origin.x + routed.label.x, y: origin.y + routed.label.y }
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
      ]);
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
  // Top-left, its own measured width, and one clear band of headroom: a title
  // centered across the graph sits exactly where inbound arrows and
  // neighboring clusters land. The band is measured from the top of what was
  // actually drawn rather than from the origin, so a graph whose first row
  // starts low does not leave the title stranded in white space.
  const titleSize = title ? measureText(title, TITLE_FONT_SIZE) : { width: 0, height: 0 };
  const drawnTop = Math.min(origin.y, ...[...regionSkeletons, ...nodeSkeletons, ...edgeLabelSkeletons]
    .map((skeleton) => finiteNumber(skeleton.y, origin.y)));
  const titleId = titleElementId(diagramId);
  if (title) roles.set(titleId, { role: "title" });
  const skeletons: JsonObject[] = [
    ...(title ? [{
      id: titleId,
      type: "text",
      ...stamp("title"),
      x: origin.x,
      y: snapModelCoordinate(drawnTop - TITLE_HEADROOM - titleSize.height),
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
