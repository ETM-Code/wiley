/**
 * Flattening ELK's hierarchical output into one coordinate system.
 *
 * ELK reports a nested layout in nested coordinates: a child node's position
 * is relative to its parent's origin, and an edge's route is relative to the
 * origin of the node the edge is declared in (its lowest common ancestor).
 * Everything downstream of the layout works in absolute canvas coordinates,
 * so the whole tree is resolved once, here, instead of every consumer
 * remembering which frame of reference it is holding.
 *
 * It imports nothing but ELK's own types, so it can be unit-tested against a
 * hand-written tree with no layout run involved.
 */

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export type Point = { x: number; y: number };
export type AbsoluteBox = { x: number; y: number; width: number; height: number };

export type AbsoluteLayout = {
  /** Every node in the tree, root included, in absolute coordinates. */
  boxes: Map<string, AbsoluteBox>;
  /** Edge id to its full polyline: start point, bendpoints, end point. */
  routes: Map<string, Point[]>;
  /** Edge id to the top-left of its first label, when ELK placed one. */
  labels: Map<string, Point>;
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** ELK's own JSON carries the containing node on returned edges. */
type EdgeWithContainer = ElkExtendedEdge & { container?: string };

export function resolveAbsolute(root: ElkNode): AbsoluteLayout {
  const boxes = new Map<string, AbsoluteBox>();
  const routes = new Map<string, Point[]>();
  const labels = new Map<string, Point>();
  const nodesById = new Map<string, ElkNode>();

  const walk = (node: ElkNode, originX: number, originY: number): void => {
    nodesById.set(node.id, node);
    boxes.set(node.id, {
      x: originX,
      y: originY,
      width: finite(node.width),
      height: finite(node.height),
    });
    for (const child of node.children ?? []) {
      walk(child, originX + finite(child.x), originY + finite(child.y));
    }
  };
  walk(root, finite(root.x), finite(root.y));

  const resolveEdges = (node: ElkNode): void => {
    for (const candidate of (node.edges ?? []) as EdgeWithContainer[]) {
      // An edge declared inside a node is measured from that node's origin
      // unless ELK named a different container on the way back out.
      const container = candidate.container && boxes.has(candidate.container)
        ? candidate.container
        : node.id;
      const origin = boxes.get(container) ?? { x: 0, y: 0, width: 0, height: 0 };
      const section = candidate.sections?.[0];
      if (section) {
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
        routes.set(candidate.id, points.map((point) => ({
          x: origin.x + finite(point.x),
          y: origin.y + finite(point.y),
        })));
      }
      const label = candidate.labels?.[0];
      if (label) {
        labels.set(candidate.id, { x: origin.x + finite(label.x), y: origin.y + finite(label.y) });
      }
    }
    for (const child of node.children ?? []) resolveEdges(child);
  };
  resolveEdges(root);

  return { boxes, routes, labels };
}
