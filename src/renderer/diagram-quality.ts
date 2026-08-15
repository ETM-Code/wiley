import { MODEL_GRID_SIZE, finiteNumber, type DiagramPlan } from "./diagram-layout";
import {
  absoluteArrowPoints,
  arrowGeometry,
  geometryIntersectsBox,
  pointsToSegments,
  type Box,
  type Point,
  type Segment,
} from "./diagram-routes";
import { contrastRatio, resolveTheme, themeColors } from "./diagram-theme";

export { absoluteArrowPoints, arrowGeometry } from "./diagram-routes";

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
}

/** Two runs closer in angle than this read as the same line. */
const PARALLEL_ANGLE_DEGREES = 5;
/** How near two parallel runs have to be before they visually merge. */
const PARALLEL_SEPARATION = 3;
/** Shorter shared runs than this are a crossing, not a doubled line. */
const MIN_PARALLEL_OVERLAP = 10;
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
  };
  const nodes: Box[] = [];
  const labels: Box[] = [];
  const arrows: JsonObject[] = [];
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
    if (role === "edge") arrows.push(skeleton);
    else if (role === "node") nodes.push(box);
    // The title competes for the same space as edge labels; hold it to the
    // same collision standard.
    else if (role === "edgeLabel" || role === "title") labels.push(box);
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

  evaluateStyleCoherence(plan, report);

  return report;
}
