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
export type DiagramLayoutOptions = {
  direction?: "RIGHT" | "DOWN";
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
// Ports separated by more than one grid cell can never snap onto each other.
const PORT_SPACING = 28;

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
  direction: "RIGHT" | "DOWN" = "RIGHT",
): { width: number; height: number } {
  if (nodeToType(node) === "text") return textNodeDimensions(node);
  const factor = shapeFactor(nodeToType(node));
  const lines = wrapLabel(node.label, NODE_FONT_SIZE, NODE_TEXT_WRAP_WIDTH / factor);
  const textWidth = lines.reduce((max, line) => Math.max(max, measureText(line, NODE_FONT_SIZE).width), 1);
  const textHeight = lines.length * NODE_FONT_SIZE * LINE_HEIGHT_RATIO;
  // Ports land on the side facing the previous layer: vertical sides in a
  // RIGHT layout, horizontal sides in a DOWN layout. That side needs room
  // for every connector to stay more than one grid cell apart.
  const portSide = (portDemand + 1) * PORT_SPACING;
  const width = Math.max(
    Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, textWidth * factor + NODE_PADDING_X)),
    direction === "DOWN" ? portSide : 0,
  );
  const height = Math.max(
    NODE_MIN_HEIGHT,
    textHeight * factor + NODE_PADDING_Y,
    direction === "RIGHT" ? portSide : 0,
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

function dedupePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.filter((point, index) => index === 0
    || point.x !== points[index - 1].x
    || point.y !== points[index - 1].y);
}

export async function planDiagramLayout(
  params: LayoutParams,
  origin: { x: number; y: number },
  diagramId = deriveDiagramId(params),
): Promise<DiagramPlan> {
  validateGraph(params);
  const edges = params.edges ?? [];
  const ordinals = edgeOrdinals(edges);
  const edgeKeys = edges.map((edge, index) => edgeKey(edge, ordinals[index]));
  const direction = params.layout?.direction ?? "RIGHT";
  const theme = resolveTheme(params.theme);
  const explicitColors = new Set<string>();
  for (const node of params.nodes) {
    if (isHexColor(node.backgroundColor)) explicitColors.add(node.backgroundColor.trim());
    if (isHexColor(node.strokeColor)) explicitColors.add(node.strokeColor.trim());
  }
  for (const edge of edges) {
    if (isHexColor(edge.color)) explicitColors.add(edge.color.trim());
  }
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

  const layoutResult = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
      // Channel spacing stays above one grid cell so snapping can never merge
      // two parallel routes or a route into a node border.
      "elk.spacing.edgeNode": "40",
      "elk.spacing.edgeEdge": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "32",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
      "elk.spacing.edgeLabel": "10",
    },
    children: params.nodes.map((node) => ({
      id: node.id,
      width: sizes.get(node.id)?.width ?? NODE_MIN_WIDTH,
      height: sizes.get(node.id)?.height ?? NODE_MIN_HEIGHT,
    })),
    edges: edges.map((edge, index) => ({
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
  });

  const positions = new Map<string, { x: number; y: number }>(
    (layoutResult.children ?? []).map((node: ElkNode) => [node.id, {
      x: snapModelCoordinate(node.x),
      y: snapModelCoordinate(node.y),
    }]),
  );
  const elkEdges = (layoutResult.edges ?? []) as ElkExtendedEdge[];
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
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const size = sizes.get(node.id) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
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
    const elkEdge = elkEdges.find((candidate) => candidate.id === `edge-${index}`);
    const section = elkEdge?.sections?.[0];
    const fromPosition = positions.get(edge.from) ?? { x: 0, y: 0 };
    const toPosition = positions.get(edge.to) ?? { x: 0, y: 0 };
    const fromSize = sizes.get(edge.from) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    const toSize = sizes.get(edge.to) ?? { width: NODE_MIN_WIDTH, height: NODE_MIN_HEIGHT };
    // ELK routes to distributed border points; fall back to side midpoints
    // only if a section is missing entirely.
    const fallbackStart = {
      x: fromPosition.x + fromSize.width,
      y: fromPosition.y + fromSize.height / 2,
    };
    const fallbackEnd = { x: toPosition.x, y: toPosition.y + toSize.height / 2 };
    // Routes stay unsnapped: ELK separates parallel runs by as little as
    // 16 px, and snapping those channels onto the 20 px grid is exactly what
    // merges arrows into one overlapping line.
    const absoluteRoute = dedupePoints([
      section?.startPoint ?? fallbackStart,
      ...(section?.bendPoints ?? []),
      section?.endPoint ?? fallbackEnd,
    ].map((point) => ({
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
    });
    const label = elkEdge?.labels?.[0];
    if (label?.text) {
      const size = measureText(label.text, EDGE_LABEL_FONT_SIZE);
      const edgeLabelId = edgeLabelElementId(diagramId, key);
      roles.set(edgeLabelId, { role: "edgeLabel", key, edgeIndex: index });
      edgeLabelSkeletons.push({
        id: edgeLabelId,
        type: "text",
        ...stamp("edgeLabel", key),
        x: origin.x + finiteNumber(label.x),
        y: origin.y + finiteNumber(label.y),
        width: size.width,
        height: size.height,
        text: label.text,
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
