import { MODEL_GRID_SIZE, finiteNumber, type DiagramPlan } from "./diagram-layout";

type JsonObject = Record<string, unknown>;

export interface DiagramQualityReport {
  nodeOverlaps: string[];
  labelCollisions: string[];
  edgesThroughNodes: string[];
  sharedPorts: string[];
  overlappingParallelSegments: string[];
  offGrid: string[];
}

type Box = { id: string; x: number; y: number; width: number; height: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.width + margin
    && b.x < a.x + a.width + margin
    && a.y < b.y + b.height + margin
    && b.y < a.y + a.height + margin;
}

function segmentIntersectsBox(segment: Segment, box: Box, shrink: number): boolean {
  const left = box.x + shrink;
  const right = box.x + box.width - shrink;
  const top = box.y + shrink;
  const bottom = box.y + box.height - shrink;
  if (left >= right || top >= bottom) return false;
  // Orthogonal segments cover the layout output; a conservative bbox check
  // covers any residual diagonal.
  const minX = Math.min(segment.x1, segment.x2);
  const maxX = Math.max(segment.x1, segment.x2);
  const minY = Math.min(segment.y1, segment.y2);
  const maxY = Math.max(segment.y1, segment.y2);
  return minX < right && maxX > left && minY < bottom && maxY > top;
}

function arrowSegments(arrow: JsonObject): Segment[] {
  const originX = finiteNumber(arrow.x);
  const originY = finiteNumber(arrow.y);
  const points = (Array.isArray(arrow.points) ? arrow.points : []) as Array<[number, number]>;
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index++) {
    segments.push({
      x1: originX + points[index - 1][0],
      y1: originY + points[index - 1][1],
      x2: originX + points[index][0],
      y2: originY + points[index][1],
    });
  }
  return segments;
}

export function evaluateDiagramPlan(plan: DiagramPlan): DiagramQualityReport {
  const report: DiagramQualityReport = {
    nodeOverlaps: [],
    labelCollisions: [],
    edgesThroughNodes: [],
    sharedPorts: [],
    overlappingParallelSegments: [],
    offGrid: [],
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
    if (skeleton.type === "arrow") arrows.push(skeleton);
    else if (id.includes("-node-")) nodes.push(box);
    // The title competes for the same space as edge labels; hold it to the
    // same collision standard.
    else if (id.includes("-edgelabel-") || id.endsWith("-title")) labels.push(box);
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

  const portsByNode = new Map<string, Map<string, string>>();
  for (const arrow of arrows) {
    const segments = arrowSegments(arrow);
    const startNode = String((arrow.start as { id?: string } | undefined)?.id ?? "");
    const endNode = String((arrow.end as { id?: string } | undefined)?.id ?? "");
    for (const node of nodes) {
      if (node.id === startNode || node.id === endNode) continue;
      if (segments.some((segment) => segmentIntersectsBox(segment, node, 4))) {
        report.edgesThroughNodes.push(`${String(arrow.id)} x ${node.id}`);
      }
    }
    const points = (Array.isArray(arrow.points) ? arrow.points : []) as Array<[number, number]>;
    if (points.length >= 2) {
      const endpoints: Array<[string, [number, number]]> = [
        [startNode, points[0]],
        [endNode, points[points.length - 1]],
      ];
      for (const [nodeId, point] of endpoints) {
        if (!nodeId) continue;
        const absolute = `${finiteNumber(arrow.x) + point[0]},${finiteNumber(arrow.y) + point[1]}`;
        const ports = portsByNode.get(nodeId) ?? new Map<string, string>();
        const owner = ports.get(absolute);
        if (owner && owner !== String(arrow.id)) {
          report.sharedPorts.push(`${nodeId} @ ${absolute} (${owner}, ${String(arrow.id)})`);
        }
        ports.set(absolute, String(arrow.id));
        portsByNode.set(nodeId, ports);
      }
    }
  }

  for (let a = 0; a < arrows.length; a++) {
    for (let b = a + 1; b < arrows.length; b++) {
      for (const first of arrowSegments(arrows[a])) {
        for (const second of arrowSegments(arrows[b])) {
          const firstVertical = Math.abs(first.x1 - first.x2) < 1;
          const secondVertical = Math.abs(second.x1 - second.x2) < 1;
          if (firstVertical !== secondVertical) continue;
          if (firstVertical) {
            if (Math.abs(first.x1 - second.x1) >= 2) continue;
            const overlap = Math.min(Math.max(first.y1, first.y2), Math.max(second.y1, second.y2))
              - Math.max(Math.min(first.y1, first.y2), Math.min(second.y1, second.y2));
            if (overlap > 10) {
              report.overlappingParallelSegments.push(`${String(arrows[a].id)} x ${String(arrows[b].id)}`);
            }
          } else {
            if (Math.abs(first.y1 - second.y1) >= 2) continue;
            const overlap = Math.min(Math.max(first.x1, first.x2), Math.max(second.x1, second.x2))
              - Math.max(Math.min(first.x1, first.x2), Math.min(second.x1, second.x2));
            if (overlap > 10) {
              report.overlappingParallelSegments.push(`${String(arrows[a].id)} x ${String(arrows[b].id)}`);
            }
          }
        }
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

  return report;
}
