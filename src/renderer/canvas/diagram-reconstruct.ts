/**
 * Rebuilding the graph a diagram was drawn from, out of the diagram itself.
 *
 * Every element an agent draws is stamped with its role, its semantic key, and
 * the container holding it, and arrows carry real Excalidraw bindings. That is
 * enough to reconstruct the nodes, edges, and containers without keeping any
 * state between calls: the board is the record. What the stamps cannot say is
 * how the layout was asked for, so a merge that wants a particular direction or
 * algorithm has to name it again.
 */

import { readDiagramStamp } from "../../shared/diagram-stamp";
import type {
  GraphContainer,
  GraphEdge,
  GraphNode,
  GraphShape,
  LayoutParams,
} from "../diagram-layout";
import type { HumanGraph } from "./human-graph";
import { humanGraphNode, humanNodeId } from "./human-merge";
import type { SceneElement } from "./types";

type Labelled = SceneElement & {
  text?: string;
  name?: string;
  containerId?: string | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
};

const SHAPES = new Set<string>(["rectangle", "diamond", "ellipse", "text"]);

/**
 * The diagram a request is aimed at: its own id, or the id of any element
 * inside it, so the agent can name whatever it happens to be holding.
 */
export function resolveTargetDiagram(
  elements: readonly SceneElement[],
  target: string | undefined,
): string {
  if (!target) throw new Error("update-diagram requires a diagram id or an element id inside one");
  const owners = new Set<string>();
  for (const element of elements) {
    const stamp = readDiagramStamp(element);
    if (!stamp) continue;
    owners.add(stamp.diagram);
    if (element.id === target) return stamp.diagram;
  }
  if (owners.has(target)) return target;
  throw new Error(`No diagram on the board matches ${target}`);
}

export function diagramElements(
  elements: readonly SceneElement[],
  diagramId: string,
): SceneElement[] {
  return elements.filter((element) => readDiagramStamp(element)?.diagram === diagramId);
}

/** Bound labels carry no stamp of their own; they are found by attachment. */
function boundText(elements: readonly SceneElement[]): Map<string, string> {
  const text = new Map<string, string>();
  for (const element of elements as Labelled[]) {
    if (element.type !== "text" || !element.containerId || !element.text) continue;
    text.set(element.containerId, element.text);
  }
  return text;
}

export type ReconstructOptions = {
  /**
   * The reading of the person's own sketch. With it, an arrow this diagram
   * already runs into the sketch reconstructs as an edge to a `human:` node
   * carrying that element's real id, instead of being dropped for having an
   * endpoint the stamps cannot explain.
   */
  human?: HumanGraph;
};

export function reconstructSpec(
  elements: readonly SceneElement[],
  diagramId: string,
  options: ReconstructOptions = {},
): LayoutParams {
  const mine = diagramElements(elements, diagramId);
  const labels = boundText(elements);
  const nodes: GraphNode[] = [];
  const containers: GraphContainer[] = [];
  const nodeKeyByElementId = new Map<string, string>();
  const containerLabels = new Map<string, string>();
  const edgeLabels = new Map<string, string>();
  let title: string | undefined;
  let theme: LayoutParams["theme"];

  for (const element of mine as Labelled[]) {
    const stamp = readDiagramStamp(element)!;
    if (stamp.theme) theme = stamp.theme;
    if (stamp.role === "title") title = element.text;
    if (stamp.role === "containerLabel" && stamp.key) {
      containerLabels.set(stamp.key, element.text ?? "");
    }
    if (stamp.role === "edgeLabel" && stamp.key) edgeLabels.set(stamp.key, element.text ?? "");
  }

  for (const element of mine as Labelled[]) {
    const stamp = readDiagramStamp(element)!;
    if (stamp.role === "node" && stamp.key) {
      nodeKeyByElementId.set(element.id, stamp.key);
      nodes.push({
        id: stamp.key,
        label: labels.get(element.id) ?? element.text ?? stamp.key,
        ...(stamp.nodeRole ? { role: stamp.nodeRole } : {}),
        ...(stamp.emphasis ? { emphasis: stamp.emphasis } : {}),
        ...(stamp.backgroundColor ? { backgroundColor: stamp.backgroundColor } : {}),
        ...(stamp.strokeColor ? { strokeColor: stamp.strokeColor } : {}),
        ...((element as Labelled & { backgroundColor?: string; strokeColor?: string }).backgroundColor
          && (element as Labelled & { backgroundColor?: string; strokeColor?: string }).strokeColor
          ? {
              preservedStyle: {
                backgroundColor: (element as Labelled & { backgroundColor: string }).backgroundColor,
                strokeColor: (element as Labelled & { strokeColor: string }).strokeColor,
              },
            }
          : {}),
        ...(SHAPES.has(element.type) && element.type !== "rectangle"
          ? { shape: element.type as GraphShape }
          : {}),
        ...(stamp.container ? { container: stamp.container } : {}),
      });
      continue;
    }
    if (stamp.role !== "container" || !stamp.key) continue;
    containers.push({
      id: stamp.key,
      ...(containerLabels.get(stamp.key) ?? element.name
        ? { label: containerLabels.get(stamp.key) ?? element.name }
        : {}),
      ...(stamp.container ? { parent: stamp.container } : {}),
      ...(element.type === "frame" ? { render: "frame" as const } : {}),
    });
  }

  const humanByElementId = new Map((options.human?.nodes ?? []).map((node) => [node.elementId, node]));
  const claimedHuman = new Map<string, GraphNode>();
  const resolve = (elementId: string | undefined): string | undefined => {
    if (!elementId) return undefined;
    const owned = nodeKeyByElementId.get(elementId);
    if (owned) return owned;
    const human = humanByElementId.get(elementId);
    if (!human) return undefined;
    const id = humanNodeId(elementId);
    claimedHuman.set(id, humanGraphNode(human));
    return id;
  };

  const edges: GraphEdge[] = [];
  for (const element of mine as Labelled[]) {
    const stamp = readDiagramStamp(element)!;
    if (stamp.role !== "edge") continue;
    const from = resolve(element.startBinding?.elementId);
    const to = resolve(element.endBinding?.elementId);
    // A connector whose ends were pulled off their shapes has no graph meaning
    // left; dropping it beats inventing an endpoint.
    if (!from || !to) continue;
    const label = labels.get(element.id) ?? (stamp.key ? edgeLabels.get(stamp.key) : undefined);
    edges.push({ from, to, ...(label ? { label } : {}) });
  }

  return {
    nodes: [...nodes, ...claimedHuman.values()],
    edges,
    ...(containers.length ? { containers } : {}),
    ...(title ? { title } : {}),
    ...(theme ? { theme } : {}),
  };
}

/**
 * Lays the requested graph over the reconstructed one. Anything named by id
 * replaces what was there; anything new is appended; everything unmentioned
 * survives untouched. An edge matches the first unclaimed one sharing its
 * endpoints, so redeclaring one of two parallel edges edits that one rather
 * than both.
 */
export function mergeSpec(existing: LayoutParams, overlay: Partial<LayoutParams>): LayoutParams {
  const nodes = [...existing.nodes];
  for (const node of overlay.nodes ?? []) {
    const index = nodes.findIndex((candidate) => candidate.id === node.id);
    if (index === -1) nodes.push(node);
    else {
      const merged = { ...nodes[index], ...node };
      // A named semantic/style change is intentional; do not let the
      // previous rendered fallback override the new role or colour.
      if ("role" in node || "emphasis" in node
        || "backgroundColor" in node || "strokeColor" in node) {
        delete merged.preservedStyle;
      }
      nodes[index] = merged;
    }
  }
  const containers = [...(existing.containers ?? [])];
  for (const container of overlay.containers ?? []) {
    const index = containers.findIndex((candidate) => candidate.id === container.id);
    if (index === -1) containers.push(container);
    else containers[index] = { ...containers[index], ...container };
  }
  const edges = [...existing.edges];
  const claimed = new Set<number>();
  for (const edge of overlay.edges ?? []) {
    const index = edges.findIndex((candidate, position) => !claimed.has(position)
      && candidate.from === edge.from
      && candidate.to === edge.to);
    if (index === -1) {
      edges.push(edge);
      claimed.add(edges.length - 1);
      continue;
    }
    claimed.add(index);
    edges[index] = { ...edges[index], ...edge };
  }
  return {
    ...existing,
    ...(overlay.title !== undefined ? { title: overlay.title } : {}),
    ...(overlay.theme !== undefined ? { theme: overlay.theme } : {}),
    ...(overlay.layout !== undefined ? { layout: overlay.layout } : {}),
    nodes,
    edges,
    ...(containers.length ? { containers } : {}),
  };
}
