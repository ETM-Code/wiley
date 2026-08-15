import ELK from "elkjs/lib/elk.bundled";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import {
  DIAGRAM_CONTAINER_RENDERS,
  type DiagramContainerRender,
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
  placeEdgeLabel,
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
  return boxes;
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
    ...(edge.label?.trim()
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
      ? { containers: containerBoxes(input.containers, positions, input.sizes, input.containerLabelWidths) }
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
      return { points, rounded: false, ...(label ? { label } : {}) };
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

  const nodeSkeletons: JsonObject[] = params.nodes.map((node) => {
    const position = geometry.positions.get(node.id) ?? { x: 0, y: 0 };
    const size = geometry.sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const type = nodeToType(node);
    const id = elementIdByNode.get(node.id)!;
    const style = resolveNodeStyle(theme, node.role, node.emphasis, {
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
    // An edge belongs to the deepest container holding both of its ends, so a
    // connector inside a region moves and reads with that region.
    const owner = containerPlan ? lowestCommonContainer(containerPlan, edge.from, edge.to) : undefined;
    const ownerGroups = owner && boxes.has(owner) ? groupsFor(owner) : [];
    const edgeGroups: JsonObject = ownerGroups.length ? { groupIds: ownerGroups } : {};
    roles.set(edgeId, { role: "edge", key, edgeIndex: index, ...(owner ? { container: owner } : {}) });
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
    });
    const text = edge.label?.trim();
    if (text && routed.label) {
      const size = measureText(text, EDGE_LABEL_FONT_SIZE);
      const edgeLabelId = edgeLabelElementId(diagramId, key);
      roles.set(edgeLabelId, { role: "edgeLabel", key, edgeIndex: index, ...(owner ? { container: owner } : {}) });
      edgeLabelSkeletons.push({
        id: edgeLabelId,
        type: "text",
        ...stamp("edgeLabel", key, owner),
        ...edgeGroups,
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
    edgeLabelCount: edgeLabelSkeletons.length,
    elementIdByNode,
    diagramId,
    roles,
    containers: containerEntries,
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
