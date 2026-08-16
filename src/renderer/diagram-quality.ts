import {
  CURVED_LABEL_SLACK,
  EDGE_LABEL_FONT_SIZE,
  MODEL_GRID_SIZE,
  boundLabelAnchor,
  finiteNumber,
  measureText,
  type DiagramPlan,
} from "./diagram-layout";
import {
  absoluteArrowPoints,
  arrowGeometry,
  geometryIntersectsBox,
  pointsToSegments,
  segmentsVisuallyMerge,
  type Box,
  type Point,
  type Segment,
} from "./diagram-routes";
import { contrastRatio, resolveTheme, themeColors } from "./diagram-theme";

export { absoluteArrowPoints, arrowGeometry, segmentsVisuallyMerge } from "./diagram-routes";

type JsonObject = Record<string, unknown>;

export interface DiagramQualityReport {
  nodeOverlaps: string[];
  labelCollisions: string[];
  edgesThroughNodes: string[];
  sharedPorts: string[];
  crowdedPorts: string[];
  overlappingParallelSegments: string[];
  offGrid: string[];
  styleCoherence: string[];
  containerContainment: string[];
  containerIntrusion: string[];
  edgesThroughContainers: string[];
}

/**
 * Something on the board the agent did not draw and may not touch: one of the
 * person's shapes or captions. Obstacles are judged in one direction only.
 * The agent's work has to keep clear of them; a messy sketch overlapping
 * itself is the person's business and never a defect in the agent's drawing.
 */
export type DiagramObstacle = {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  kind: "shape" | "text";
};

/**
 * How a finding says it is about somebody else's drawing. The report is eight
 * arrays of strings that a dozen callers already read, summarize, and merge,
 * so the marker rides in the string rather than splitting the shape.
 */
export const OBSTACLE_MARKER = " [obstacle]";

export function isObstacleFinding(finding: string): boolean {
  return finding.endsWith(OBSTACLE_MARKER);
}

/** How far inside a container's border its members have to stay. */
export const CONTAINER_INSET = 12;

/** Two ports nearer than this on one node read as a single attachment. */
const MIN_PORT_SEPARATION = 14;

/** WCAG large-text minimum: below this a label stops being legible on its fill. */
const MIN_LABEL_CONTRAST = 3;
/**
 * How wide a palette still reads as designed. Measured against the curated
 * reference boards: they run about one fill per one and a half to two nodes,
 * and small ones routinely give every node its own colour, so the old one
 * fill per three nodes flagged perfectly ordinary work. The floor is what
 * keeps a two-node diagram from being told its start and its end may not
 * differ; the ceiling is that no board on the reference shelf needs more than
 * eight fills to say what it means.
 */
const MAX_DISTINCT_FILLS = 8;
const MIN_DISTINCT_FILLS = 5;
const FILLS_PER_NODE = 1.5;
const MAX_DISTINCT_NODE_STROKE_WIDTHS = 2;

function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.width + margin
    && b.x < a.x + a.width + margin
    && a.y < b.y + b.height + margin
    && b.y < a.y + a.height + margin;
}

function arrowSegments(arrow: JsonObject): Segment[] {
  return pointsToSegments(absoluteArrowPoints(arrow));
}

function labelStroke(skeleton: JsonObject): string | undefined {
  const label = skeleton.label as { strokeColor?: unknown } | undefined;
  return typeof label?.strokeColor === "string" ? label.strokeColor : undefined;
}

/**
 * Colour discipline. A themed diagram may only use colours the theme owns or
 * ones the request asked for by name, every label has to read on the fill it
 * sits on, and the palette has to stay small enough to mean something.
 */
function evaluateStyleCoherence(plan: DiagramPlan, report: DiagramQualityReport): void {
  const theme = resolveTheme(plan.theme);
  const allowed = themeColors(theme);
  const fills = new Set<string>();
  const strokeWidths = new Set<number>();
  let nodeCount = 0;

  for (const skeleton of plan.skeletons) {
    const id = String(skeleton.id ?? "");
    const role = plan.roles.get(id)?.role;
    if (!role) continue;
    const colors: Array<[string, unknown]> = [
      ["strokeColor", skeleton.strokeColor],
      ["backgroundColor", skeleton.backgroundColor],
      ["label.strokeColor", labelStroke(skeleton)],
    ];
    for (const [field, value] of colors) {
      if (typeof value !== "string") continue;
      if (allowed.has(value) || plan.explicitColors.has(value)) continue;
      report.styleCoherence.push(`${id}.${field}=${value} is neither theme-derived nor requested`);
    }
    if (role !== "node") continue;
    nodeCount += 1;
    const fill = typeof skeleton.backgroundColor === "string" ? skeleton.backgroundColor : "transparent";
    // Transparent is the absence of a fill, not one more colour in the mix.
    if (fill !== "transparent") fills.add(fill);
    if (typeof skeleton.strokeWidth === "number") strokeWidths.add(skeleton.strokeWidth);
    // A boxed node carries a bound label; a text node is its own label.
    const ink = labelStroke(skeleton)
      ?? (skeleton.type === "text" ? skeleton.strokeColor : undefined)
      ?? theme.inkColor;
    const surface = fill === "transparent" ? theme.paperColor : fill;
    const ratio = contrastRatio(String(ink), surface);
    if (ratio < MIN_LABEL_CONTRAST) {
      report.styleCoherence.push(`${id} label ${String(ink)} on ${surface} contrasts ${ratio.toFixed(2)}:1`);
    }
  }

  const fillBudget = Math.min(
    MAX_DISTINCT_FILLS,
    Math.max(MIN_DISTINCT_FILLS, Math.ceil(nodeCount / FILLS_PER_NODE)),
  );
  if (fills.size > fillBudget) {
    report.styleCoherence.push(`${fills.size} distinct fills across ${nodeCount} nodes exceeds ${fillBudget}`);
  }
  if (strokeWidths.size > MAX_DISTINCT_NODE_STROKE_WIDTHS) {
    report.styleCoherence.push(`${strokeWidths.size} distinct node stroke widths exceeds ${MAX_DISTINCT_NODE_STROKE_WIDTHS}`);
  }
}

/** A label box tagged with the arrow it rides, so it never accuses its own. */
type LabelBox = Box & { owner?: string };

/**
 * The box Excalidraw will give a label bound to this arrow. The anchor rule
 * is the editor's own; the slack covers a curved arrow, whose midpoint sits
 * off the polyline the anchor is computed from.
 */
export function boundLabelBox(arrow: JsonObject, override?: Box): LabelBox | undefined {
  const id = String(arrow.id ?? "");
  const text = (arrow.label as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim()) return undefined;
  if (override) return { ...override, id: `${id}:label`, owner: id };
  const points = absoluteArrowPoints(arrow);
  if (points.length < 2) return undefined;
  const size = measureText(text.trim(), EDGE_LABEL_FONT_SIZE);
  const anchor = boundLabelAnchor(points);
  const slack = arrow.roundness ? CURVED_LABEL_SLACK : 0;
  return {
    id: `${id}:label`,
    owner: id,
    x: anchor.x - size.width / 2 - slack,
    y: anchor.y - size.height / 2 - slack,
    width: size.width + slack * 2,
    height: size.height + slack * 2,
  };
}

function pointsBounds(points: readonly Point[], id: string): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { id, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function inset(box: Box, amount: number): Box {
  return {
    id: box.id,
    x: box.x + amount,
    y: box.y + amount,
    width: box.width - amount * 2,
    height: box.height - amount * 2,
  };
}

/** Which side, and by how much, a box pokes out of another. */
function overflows(inner: Box, outer: Box): string[] {
  const found: string[] = [];
  if (inner.x < outer.x) found.push(`left ${Math.round(outer.x - inner.x)}`);
  if (inner.y < outer.y) found.push(`top ${Math.round(outer.y - inner.y)}`);
  const right = inner.x + inner.width - (outer.x + outer.width);
  const bottom = inner.y + inner.height - (outer.y + outer.height);
  if (right > 0) found.push(`right ${Math.round(right)}`);
  if (bottom > 0) found.push(`bottom ${Math.round(bottom)}`);
  return found;
}

/** The four thin bands an arrow has to cross to get in or out of a region. */
function borderBands(box: Box): Box[] {
  const thickness = 2;
  return [
    { id: `${box.id}:top`, x: box.x, y: box.y - thickness / 2, width: box.width, height: thickness },
    { id: `${box.id}:bottom`, x: box.x, y: box.y + box.height - thickness / 2, width: box.width, height: thickness },
    { id: `${box.id}:left`, x: box.x - thickness / 2, y: box.y, width: thickness, height: box.height },
    { id: `${box.id}:right`, x: box.x + box.width - thickness / 2, y: box.y, width: thickness, height: box.height },
  ];
}

/**
 * The container tree as the checks need it: every drawn region by its
 * semantic id, and the chain of regions any element sits inside.
 */
type ContainerView = {
  boxes: Map<string, Box>;
  chainOf: (elementId: string) => string[];
  semanticOf: Map<string, string>;
};

function containerView(plan: DiagramPlan, boxById: ReadonlyMap<string, Box>): ContainerView {
  const boxes = new Map<string, Box>();
  const semanticOf = new Map<string, string>();
  for (const [semantic, entry] of plan.containers) {
    const box = boxById.get(entry.elementId);
    if (!box) continue;
    boxes.set(semantic, box);
    semanticOf.set(entry.elementId, semantic);
  }
  const chainOf = (elementId: string): string[] => {
    const chain: string[] = [];
    let cursor = plan.roles.get(elementId)?.container;
    while (cursor && boxes.has(cursor) && !chain.includes(cursor)) {
      chain.push(cursor);
      cursor = plan.containers.get(cursor)?.parent;
    }
    return chain;
  };
  return { boxes, chainOf, semanticOf };
}

function evaluateContainers(
  view: ContainerView,
  boxById: ReadonlyMap<string, Box>,
  arrows: readonly JsonObject[],
  report: DiagramQualityReport,
): void {
  if (view.boxes.size === 0) return;
  const arrowIds = new Set(arrows.map((arrow) => String(arrow.id)));

  for (const [semantic, container] of view.boxes) {
    const room = inset(container, CONTAINER_INSET);
    for (const [elementId, box] of boxById) {
      if (elementId === container.id) continue;
      const chain = view.chainOf(elementId);
      if (chain.includes(semantic)) {
        const found = overflows(box, room);
        if (found.length > 0) {
          report.containerContainment.push(`${container.id} > ${elementId} overflows ${found.join(", ")}`);
        }
        continue;
      }
      // An arrow is judged by where it crosses, not by the box its route
      // happens to span, and two regions on top of each other are already a
      // node overlap rather than an intrusion.
      if (arrowIds.has(elementId) || view.semanticOf.has(elementId)) continue;
      if (boxesOverlap(box, container)) {
        report.containerIntrusion.push(`${container.id} x ${elementId}`);
      }
    }
  }

  for (const arrow of arrows) {
    const id = String(arrow.id);
    const geometry = arrowGeometry(arrow);
    const startNode = String((arrow.start as { id?: string } | undefined)?.id ?? "");
    const endNode = String((arrow.end as { id?: string } | undefined)?.id ?? "");
    const allowed = new Set([
      ...view.chainOf(startNode),
      ...view.chainOf(endNode),
      ...view.chainOf(id),
    ]);
    for (const [semantic, container] of view.boxes) {
      if (allowed.has(semantic)) continue;
      const crossings = borderBands(container)
        .filter((band) => geometryIntersectsBox(geometry, band, 0)).length;
      if (crossings > 0) {
        report.edgesThroughContainers.push(`${id} x ${container.id} (${crossings} crossings)`);
      }
    }
  }

  // Two regions may share space only where one genuinely holds the other.
  const semantics = [...view.boxes.keys()];
  for (let a = 0; a < semantics.length; a++) {
    for (let b = a + 1; b < semantics.length; b++) {
      const first = view.boxes.get(semantics[a])!;
      const second = view.boxes.get(semantics[b])!;
      if (view.chainOf(first.id).includes(semantics[b])) continue;
      if (view.chainOf(second.id).includes(semantics[a])) continue;
      if (boxesOverlap(first, second)) report.nodeOverlaps.push(`${first.id} x ${second.id}`);
    }
  }
}

export type EvaluationOptions = {
  /** The person's shapes and captions, which the agent's work must clear. */
  obstacles?: readonly DiagramObstacle[];
};

export function evaluateDiagramPlan(
  plan: DiagramPlan,
  /** Measured bound-label boxes, when the caller has the real ones to hand. */
  boundLabelBoxes?: ReadonlyMap<string, Box>,
  options: EvaluationOptions = {},
): DiagramQualityReport {
  const report: DiagramQualityReport = {
    nodeOverlaps: [],
    labelCollisions: [],
    edgesThroughNodes: [],
    sharedPorts: [],
    crowdedPorts: [],
    overlappingParallelSegments: [],
    offGrid: [],
    styleCoherence: [],
    containerContainment: [],
    containerIntrusion: [],
    edgesThroughContainers: [],
  };
  const nodes: Box[] = [];
  const labels: LabelBox[] = [];
  const arrows: JsonObject[] = [];
  const boxById = new Map<string, Box>();
  for (const skeleton of plan.skeletons) {
    const id = String(skeleton.id ?? "");
    const box: Box = {
      id,
      x: finiteNumber(skeleton.x),
      y: finiteNumber(skeleton.y),
      width: finiteNumber(skeleton.width),
      height: finiteNumber(skeleton.height),
    };
    const role = plan.roles.get(id)?.role;
    if (role === "edge") {
      arrows.push(skeleton);
      const points = absoluteArrowPoints(skeleton);
      boxById.set(id, points.length > 0 ? pointsBounds(points, id) : box);
      // A bound label lives on its arrow, so the arrow's own containment and
      // trespass verdict already covers it; only collisions are its own.
      const bound = boundLabelBox(skeleton, boundLabelBoxes?.get(id));
      if (bound) labels.push(bound);
      continue;
    }
    boxById.set(id, box);
    if (role === "node") nodes.push(box);
    // The title competes for the same space as edge labels; hold it to the
    // same collision standard, and a region's own caption with it.
    else if (role === "edgeLabel" || role === "title" || role === "containerLabel") labels.push(box);
  }

  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (boxesOverlap(nodes[a], nodes[b])) report.nodeOverlaps.push(`${nodes[a].id} x ${nodes[b].id}`);
    }
  }

  for (const label of labels) {
    for (const node of nodes) {
      if (boxesOverlap(label, node)) report.labelCollisions.push(`${label.id} x ${node.id}`);
    }
    for (const other of labels) {
      if (other.id <= label.id) continue;
      if (boxesOverlap(label, other)) report.labelCollisions.push(`${label.id} x ${other.id}`);
    }
    // A bound label sits on its own arrow by construction; landing on anyone
    // else's is a genuine collision.
    if (!label.owner) continue;
    for (const arrow of arrows) {
      if (String(arrow.id) === label.owner) continue;
      if (geometryIntersectsBox(arrowGeometry(arrow), label, 0)) {
        report.labelCollisions.push(`${label.id} x ${String(arrow.id)}`);
      }
    }
  }

  const portsByNode = new Map<string, Array<{ owner: string; point: Point }>>();
  for (const arrow of arrows) {
    const geometry = arrowGeometry(arrow);
    const startNode = String((arrow.start as { id?: string } | undefined)?.id ?? "");
    const endNode = String((arrow.end as { id?: string } | undefined)?.id ?? "");
    for (const node of nodes) {
      if (node.id === startNode || node.id === endNode) continue;
      if (geometryIntersectsBox(geometry, node, 4)) {
        report.edgesThroughNodes.push(`${String(arrow.id)} x ${node.id}`);
      }
    }
    const points = absoluteArrowPoints(arrow);
    if (points.length >= 2) {
      const endpoints: Array<[string, Point]> = [
        [startNode, points[0]],
        [endNode, points[points.length - 1]],
      ];
      for (const [nodeId, point] of endpoints) {
        if (!nodeId) continue;
        const ports = portsByNode.get(nodeId) ?? [];
        for (const existing of ports) {
          if (existing.owner === String(arrow.id) && existing.point.x === point.x && existing.point.y === point.y) {
            continue;
          }
          const gap = Math.max(Math.abs(existing.point.x - point.x), Math.abs(existing.point.y - point.y));
          if (gap === 0) {
            report.sharedPorts.push(
              `${nodeId} @ ${point.x},${point.y} (${existing.owner}, ${String(arrow.id)})`,
            );
          } else if (gap < MIN_PORT_SEPARATION) {
            report.crowdedPorts.push(
              `${nodeId} @ ${gap.toFixed(1)}px (${existing.owner}, ${String(arrow.id)})`,
            );
          }
        }
        ports.push({ owner: String(arrow.id), point });
        portsByNode.set(nodeId, ports);
      }
    }
  }

  const runs = arrows.map((arrow) => arrowSegments(arrow));
  for (let a = 0; a < arrows.length; a++) {
    for (let b = a + 1; b < arrows.length; b++) {
      const merged = runs[a].some((first) => runs[b].some((second) => segmentsVisuallyMerge(first, second)));
      if (merged) {
        report.overlappingParallelSegments.push(`${String(arrows[a].id)} x ${String(arrows[b].id)}`);
      }
    }
  }

  // Only shapes live on the hidden grid; connector routes and edge labels
  // keep ELK's exact channel geometry.
  for (const skeleton of plan.skeletons) {
    if (skeleton.type === "text" || skeleton.type === "arrow") continue;
    for (const key of ["x", "y", "width", "height"] as const) {
      const value = skeleton[key];
      if (typeof value === "number" && value % MODEL_GRID_SIZE !== 0) {
        report.offGrid.push(`${String(skeleton.id)}.${key}=${value}`);
      }
    }
  }

  evaluateContainers(containerView(plan, boxById), boxById, arrows, report);
  evaluateStyleCoherence(plan, report);
  evaluateObstacles(options.obstacles ?? [], { nodes, labels, arrows, boxById, plan }, report);

  return report;
}

/**
 * The agent's drawing against the person's. Every finding is marked, because
 * the caller treats a route driven through someone's box as a hard failure
 * and a box landing on their caption as a placement to try again.
 */
function evaluateObstacles(
  obstacles: readonly DiagramObstacle[],
  drawing: {
    nodes: readonly Box[];
    labels: readonly LabelBox[];
    arrows: readonly JsonObject[];
    boxById: ReadonlyMap<string, Box>;
    plan: DiagramPlan;
  },
  report: DiagramQualityReport,
): void {
  if (obstacles.length === 0) return;
  const boxes = obstacles.map((obstacle) => ({ obstacle, box: { id: obstacle.id, ...obstacle.bounds } }));
  const regions = [...drawing.plan.containers.values()]
    .map((entry) => drawing.boxById.get(entry.elementId))
    .filter((box): box is Box => Boolean(box));

  for (const box of [...drawing.nodes, ...regions]) {
    for (const { box: other } of boxes) {
      if (boxesOverlap(box, other)) {
        report.nodeOverlaps.push(`${box.id} x ${other.id}${OBSTACLE_MARKER}`);
      }
    }
  }
  for (const label of drawing.labels) {
    for (const { box: other } of boxes) {
      if (boxesOverlap(label, other)) {
        report.labelCollisions.push(`${label.id} x ${other.id}${OBSTACLE_MARKER}`);
      }
    }
  }
  // A route grazing a caption is normal; driving one through somebody's box
  // is the thing the whole obstacle pass exists to stop.
  for (const arrow of drawing.arrows) {
    const geometry = arrowGeometry(arrow);
    for (const { obstacle, box } of boxes) {
      if (obstacle.kind !== "shape") continue;
      if (geometryIntersectsBox(geometry, box, 4)) {
        report.edgesThroughNodes.push(`${String(arrow.id)} x ${box.id}${OBSTACLE_MARKER}`);
      }
    }
  }
}

/** The shape of a converted element the checks actually read. */
type ConvertedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: ReadonlyArray<readonly number[]>;
  containerId?: string | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  text?: string;
  roundness?: unknown;
};

/**
 * The same checks over what the converter actually produced.
 *
 * The plan says where things should be; the converter re-measures every bound
 * label with the editor's own font metrics and recomputes arrow geometry from
 * the points. Running the checks again over the result is how a difference
 * between the two is caught rather than assumed away.
 */
export function evaluateConvertedScene(
  elements: readonly ConvertedElement[],
  plan: DiagramPlan,
  options: EvaluationOptions = {},
): DiagramQualityReport {
  const boundLabelBoxes = new Map<string, Box>();
  const boundTextByArrow = new Map<string, string>();
  const arrowIds = new Set(
    [...plan.roles].filter(([, entry]) => entry.role === "edge").map(([id]) => id),
  );
  for (const element of elements) {
    const container = element.containerId;
    if (element.type !== "text" || !container || !arrowIds.has(container)) continue;
    boundLabelBoxes.set(container, {
      id: `${container}:label`,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    });
    boundTextByArrow.set(container, element.text ?? "");
  }
  const skeletons: JsonObject[] = elements
    .filter((element) => plan.roles.has(element.id))
    .map((element) => ({
      ...element,
      ...(element.type === "arrow"
        ? {
            start: { id: element.startBinding?.elementId },
            end: { id: element.endBinding?.elementId },
            ...(boundTextByArrow.has(element.id)
              ? { label: { text: boundTextByArrow.get(element.id) } }
              : {}),
          }
        : {}),
    }));
  return evaluateDiagramPlan({ ...plan, skeletons }, boundLabelBoxes, options);
}

/** Union of two reports, with each check's findings deduplicated. */
export function mergeQualityReports(
  first: DiagramQualityReport,
  second: DiagramQualityReport,
): DiagramQualityReport {
  const merged = {} as DiagramQualityReport;
  for (const key of Object.keys(first) as Array<keyof DiagramQualityReport>) {
    merged[key] = [...new Set([...first[key], ...second[key]])];
  }
  return merged;
}
