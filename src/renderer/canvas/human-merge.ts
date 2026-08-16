/**
 * Wiring an agent diagram into the human's sketch.
 *
 * A spec node may name a human element instead of describing a new one, by
 * using the id `human:<elementId>`. Such a node is never drawn: the person
 * already drew it. It is a fixed obstacle the layout works around and a real
 * binding target for the arrows the agent adds, so extending a sketch means
 * attaching to it rather than drawing a parallel copy beside it.
 *
 * Human nodes therefore never reach ELK. They sit at absolute coordinates the
 * layout has no say over, whereas a plan is laid out at the origin and
 * translated into place afterwards; feeding fixed absolute positions into a
 * pipeline that is going to move everything is a contradiction, and ELK's own
 * fixed-position support only holds under `layered` with none of the spacing
 * and port machinery this codebase relies on. Excluding them and treating
 * their boxes as forbidden regions keeps every existing layout byte-identical
 * and makes the connecting arrows exact rather than approximately routed.
 */

import {
  BOUND_LABEL_CLEARANCE,
  EDGE_LABEL_FONT_SIZE,
  boundLabelClears,
  boundLabelRoom,
  measureText,
  validateGraphEdges,
  type DiagramPlan,
  type GraphEdge,
  type GraphNode,
  type LayoutParams,
} from "../diagram-layout";
import {
  MAX_ROUTE_REPAIR_ITERATIONS,
  placeEdgeLabel,
  planRoutes,
  routeDefects,
  type Box,
  type RouteRequest,
} from "../diagram-routes";
import type { DiagramObstacle } from "../diagram-quality";
import { edgeElementId, edgeKey, edgeLabelElementId, edgeOrdinals } from "../diagram-spec";
import { resolveEdgeStyle, resolveTheme } from "../diagram-theme";
import { humanElements, type HumanGraph, type HumanNode, type SketchElement } from "./human-graph";

/** Types whose box is worth keeping the agent's drawing out of. */
const OBSTACLE_TYPES = new Set([
  "rectangle", "diamond", "ellipse", "image", "embeddable", "iframe", "text",
]);

/**
 * The person's work, as regions the agent's drawing has to respect. Their
 * connectors and scribbles are deliberately absent: a long diagonal arrow's
 * bounding box covers a whole quadrant of the canvas, and reserving that
 * would push every new diagram off the board.
 */
export function humanObstacles(elements: readonly SketchElement[]): DiagramObstacle[] {
  const obstacles: DiagramObstacle[] = [];
  for (const element of humanElements(elements)) {
    if (!OBSTACLE_TYPES.has(element.type)) continue;
    const bounds = {
      x: Number(element.x ?? Number.NaN),
      y: Number(element.y ?? Number.NaN),
      width: Number(element.width ?? Number.NaN),
      height: Number(element.height ?? Number.NaN),
    };
    if (Object.values(bounds).some((value) => !Number.isFinite(value))) continue;
    obstacles.push({
      id: element.id,
      bounds,
      kind: element.type === "text" ? "text" : "shape",
    });
  }
  return obstacles;
}

/** How a spec names one of the person's own elements. */
export const HUMAN_NODE_PREFIX = "human:";

export function humanNodeId(elementId: string): string {
  return `${HUMAN_NODE_PREFIX}${elementId}`;
}

export function humanElementIdOf(nodeId: string): string | undefined {
  return nodeId.startsWith(HUMAN_NODE_PREFIX)
    ? nodeId.slice(HUMAN_NODE_PREFIX.length)
    : undefined;
}

export function isHumanNode(node: GraphNode): boolean {
  return node.origin === "human";
}

/** The spec node standing for one of the person's shapes. */
export function humanGraphNode(node: HumanNode): GraphNode {
  return {
    id: humanNodeId(node.elementId),
    label: node.label ?? node.elementId,
    origin: "human",
    elementId: node.elementId,
    ...(node.shape === "diamond" || node.shape === "ellipse"
      ? { shape: node.shape as GraphNode["shape"] }
      : {}),
  };
}

/**
 * The one spelling an endpoint has. A bare element id from the scene listing
 * and the prefixed `human:` form mean the same shape, so they have to become
 * the same string before anything matches edges by their endpoints; otherwise
 * asking for the same connection twice draws it twice.
 */
export function canonicalHumanEndpoint(
  endpoint: string,
  graph: HumanGraph,
  declared: ReadonlySet<string>,
): string {
  if (declared.has(endpoint)) return endpoint;
  if (humanElementIdOf(endpoint)) return endpoint;
  return graph.nodes.some((node) => node.elementId === endpoint)
    ? humanNodeId(endpoint)
    : endpoint;
}

/** The same spelling, applied across a set of edges before they are merged. */
export function canonicalHumanEdges(
  edges: readonly GraphEdge[],
  graph: HumanGraph,
  declared: ReadonlySet<string>,
): GraphEdge[] {
  return edges.map((edge) => ({
    ...edge,
    from: canonicalHumanEndpoint(edge.from, graph, declared),
    to: canonicalHumanEndpoint(edge.to, graph, declared),
  }));
}

/**
 * Fills in every node an edge names against the person's sketch, so the agent
 * can write `{from: "api", to: "human:abc"}` and nothing else. A bare element
 * id means the same thing: that is what the scene listing shows, so refusing
 * it would only punish the agent for reading the context it was given. An id
 * that matches nothing at all fails loudly rather than quietly dropping the
 * connection the user asked for.
 */
export function materializeHumanNodes(spec: LayoutParams, graph: HumanGraph): LayoutParams {
  const byElementId = new Map(graph.nodes.map((node) => [node.elementId, node]));
  const declared = new Set(spec.nodes.map((node) => node.id));
  const added = new Map<string, GraphNode>();
  const resolveEndpoint = (endpoint: string): string => {
    const id = canonicalHumanEndpoint(endpoint, graph, declared);
    const named = humanElementIdOf(id);
    if (!named) return id;
    const human = byElementId.get(named);
    if (!human) throw new Error(`No shape of the user's on the board matches ${endpoint}`);
    added.set(id, humanGraphNode(human));
    return id;
  };
  const edges = (spec.edges ?? []).map((edge) => ({
    ...edge,
    from: resolveEndpoint(edge.from),
    to: resolveEndpoint(edge.to),
  }));
  // A declared human node still needs its real geometry and label attached.
  const nodes = spec.nodes.map((node) => {
    const elementId = humanElementIdOf(node.id);
    if (!elementId) return node;
    const human = byElementId.get(elementId);
    if (!human) throw new Error(`No shape of the user's on the board matches ${node.id}`);
    return { ...humanGraphNode(human), ...(node.label ? { label: node.label } : {}) };
  });
  return { ...spec, nodes: [...nodes, ...added.values()], edges };
}

export type HumanSpecSplit = {
  /** What ELK actually lays out: the agent's own nodes and their own edges. */
  agentSpec: LayoutParams;
  /** The person's shapes this diagram touches, by spec node id. */
  humanNodes: Map<string, GraphNode>;
  /** Edges with at least one end on a human shape, drawn after placement. */
  crossEdges: Array<{ edge: GraphEdge; key: string }>;
};

export function splitHumanSpec(spec: LayoutParams): HumanSpecSplit {
  const humanNodes = new Map<string, GraphNode>();
  const agentNodes: GraphNode[] = [];
  for (const node of spec.nodes) {
    if (!isHumanNode(node)) {
      agentNodes.push(node);
      continue;
    }
    // Checked here rather than in validateGraph, which only ever sees the
    // agent's half of the split and so could never reach a human node.
    if (!node.elementId) {
      throw new Error(`Diagram node ${node.id} claims a shape of the user's without naming one`);
    }
    if (node.container !== undefined) {
      throw new Error(`Diagram node ${node.id} is the user's own and cannot join a container`);
    }
    humanNodes.set(node.id, node);
  }
  const edges = spec.edges ?? [];
  // Cross edges never reach ELK, so this is the only place they are checked.
  validateGraphEdges(edges, new Set(spec.nodes.map((node) => node.id)));
  const ordinals = edgeOrdinals(edges);
  const agentEdges: GraphEdge[] = [];
  const crossEdges: HumanSpecSplit["crossEdges"] = [];
  for (const [index, edge] of edges.entries()) {
    if (humanNodes.has(edge.from) || humanNodes.has(edge.to)) {
      crossEdges.push({ edge, key: edgeKey(edge, ordinals[index]) });
      continue;
    }
    agentEdges.push(edge);
  }
  return {
    agentSpec: { ...spec, nodes: agentNodes, edges: agentEdges },
    humanNodes,
    crossEdges,
  };
}

export type HumanEdgeBinding = {
  arrowId: string;
  /** Element ids of the person's shapes this arrow attaches to. */
  startElementId?: string;
  endElementId?: string;
};

type BoxSource = {
  /** Final absolute box of every agent node, by spec node id. */
  agentBoxes: ReadonlyMap<string, Box>;
  /** Final absolute box of every human node, by spec node id. */
  humanBoxes: ReadonlyMap<string, Box>;
  /** Everything else on the board a route has to stay out of. */
  blockers: readonly Box[];
};

/**
 * The arrows that reach into the sketch. They are the agent's own elements:
 * stamped, themed, routed around whatever is in the way, and judged by the
 * evaluator exactly like any other connector it draws.
 */
export function planHumanEdges(
  plan: DiagramPlan,
  crossEdges: HumanSpecSplit["crossEdges"],
  source: BoxSource,
): { skeletons: Record<string, unknown>[]; bindings: HumanEdgeBinding[] } {
  if (crossEdges.length === 0) return { skeletons: [], bindings: [] };
  const theme = resolveTheme(plan.theme);
  const boxes = new Map<string, Box>();
  for (const [id, box] of source.agentBoxes) boxes.set(id, box);
  for (const [id, box] of source.humanBoxes) boxes.set(id, box);
  for (const box of source.blockers) if (!boxes.has(box.id)) boxes.set(box.id, box);

  const requests: RouteRequest[] = crossEdges.map(({ edge, key }) => ({
    id: key,
    from: edge.from,
    to: edge.to,
  }));
  const attachments = new Map(requests.map((request) => [
    request.id,
    { from: request.from, to: request.to },
  ]));
  const minSteps = new Map<string, number>();
  let routes = planRoutes(boxes, requests, { minSteps });
  for (let round = 0; round < MAX_ROUTE_REPAIR_ITERATIONS; round++) {
    const guilty = routeDefects(boxes, routes, attachments);
    if (guilty.size === 0) break;
    for (const id of guilty) minSteps.set(id, (minSteps.get(id) ?? 1) + 2);
    routes = planRoutes(boxes, requests, { minSteps });
  }

  const stamp = (key: string) => ({
    customData: { wiley: { diagram: plan.diagramId, role: "edge", theme: theme.name, key } },
  });
  const placed: Box[] = [...boxes.values()];
  const skeletons: Record<string, unknown>[] = [];
  const labelSkeletons: Record<string, unknown>[] = [];
  const bindings: HumanEdgeBinding[] = [];

  for (const [index, { edge, key }] of crossEdges.entries()) {
    const route = routes[index];
    const origin = route.points[0];
    const id = edgeElementId(plan.diagramId, key);
    const style = resolveEdgeStyle(theme, edge);
    const text = edge.label?.trim();
    const size = text ? measureText(text, EDGE_LABEL_FONT_SIZE) : { width: 0, height: 0 };
    const mode = edge.labelMode ?? "auto";
    const bound = Boolean(text) && (mode === "bound" || (mode === "auto"
      && boundLabelRoom(route.points) >= size.width + BOUND_LABEL_CLEARANCE
      && boundLabelClears(route.points, size, placed)));
    plan.roles.set(id, { role: "edge", key });
    skeletons.push({
      id,
      type: "arrow",
      ...stamp(key),
      x: origin.x,
      y: origin.y,
      points: route.points.map((point) => [point.x - origin.x, point.y - origin.y]),
      // Only an agent-side end can be bound by the converter; a human element
      // is not in the batch, so its binding is written on afterwards.
      ...(source.agentBoxes.has(edge.from)
        ? { start: { id: plan.elementIdByNode.get(edge.from) } }
        : {}),
      ...(source.agentBoxes.has(edge.to)
        ? { end: { id: plan.elementIdByNode.get(edge.to) } }
        : {}),
      strokeColor: style.strokeColor,
      strokeStyle: style.strokeStyle,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      startArrowhead: style.startArrowhead,
      endArrowhead: style.endArrowhead,
      ...(route.rounded ? { roundness: { type: 2 } } : {}),
      ...(bound && text
        ? { label: { text, strokeColor: style.labelColor, fontSize: EDGE_LABEL_FONT_SIZE, fontFamily: 5 } }
        : {}),
    });
    bindings.push({
      arrowId: id,
      ...(humanElementIdOf(edge.from) ? { startElementId: humanElementIdOf(edge.from) } : {}),
      ...(humanElementIdOf(edge.to) ? { endElementId: humanElementIdOf(edge.to) } : {}),
    });
    if (!text) continue;
    const labelId = edgeLabelElementId(plan.diagramId, key);
    if (bound) {
      plan.roles.set(labelId, { role: "edgeLabel", key, bound: true });
      continue;
    }
    const spot = placeEdgeLabel(route.points, size, placed);
    placed.push({ id: labelId, x: spot.x, y: spot.y, ...size });
    plan.roles.set(labelId, { role: "edgeLabel", key });
    labelSkeletons.push({
      id: labelId,
      type: "text",
      customData: { wiley: { diagram: plan.diagramId, role: "edgeLabel", theme: theme.name, key } },
      x: spot.x,
      y: spot.y,
      width: size.width,
      height: size.height,
      text,
      fontSize: EDGE_LABEL_FONT_SIZE,
      fontFamily: 5,
      strokeColor: style.labelColor,
      backgroundColor: "transparent",
    });
  }
  return { skeletons: [...skeletons, ...labelSkeletons], bindings };
}
