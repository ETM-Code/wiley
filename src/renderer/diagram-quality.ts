import { MODEL_GRID_SIZE, finiteNumber, type DiagramPlan } from "./diagram-layout";
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

/** How far inside a container's border its members have to stay. */
export const CONTAINER_INSET = 12;

/** Two ports nearer than this on one node read as a single attachment. */
const MIN_PORT_SEPARATION = 14;

/** WCAG large-text minimum: below this a label stops being legible on its fill. */
const MIN_LABEL_CONTRAST = 3;
/** A diagram reads as designed at roughly one fill per three nodes. */
const MAX_DISTINCT_FILLS = 6;
const FILLS_PER_NODE = 3;
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

  const fillBudget = Math.min(MAX_DISTINCT_FILLS, Math.ceil(nodeCount / FILLS_PER_NODE));
  if (fills.size > fillBudget) {
    report.styleCoherence.push(`${fills.size} distinct fills across ${nodeCount} nodes exceeds ${fillBudget}`);
  }
  if (strokeWidths.size > MAX_DISTINCT_NODE_STROKE_WIDTHS) {
    report.styleCoherence.push(`${strokeWidths.size} distinct node stroke widths exceeds ${MAX_DISTINCT_NODE_STROKE_WIDTHS}`);
  }
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

export function evaluateDiagramPlan(plan: DiagramPlan): DiagramQualityReport {
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
  const labels: Box[] = [];
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

  return report;
}
