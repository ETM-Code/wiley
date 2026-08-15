/**
 * The identity an agent-drawn diagram element carries in its customData.
 * Both processes read it: the renderer to validate and index the scene, the
 * main process to describe existing diagrams back to the agent.
 */
export type DiagramElementRole = "node" | "nodeLabel" | "edge" | "edgeLabel" | "title";

export type DiagramStamp = { diagram: string; role: DiagramElementRole; key?: string };

const ROLES = new Set<string>(["node", "nodeLabel", "edge", "edgeLabel", "title"]);

export function readDiagramStamp(element: unknown): DiagramStamp | undefined {
  const customData = (element as { customData?: unknown } | null)?.customData;
  const wiley = (customData as { wiley?: unknown } | null | undefined)?.wiley as
    | { diagram?: unknown; role?: unknown; key?: unknown }
    | undefined;
  if (!wiley || typeof wiley.diagram !== "string") return undefined;
  if (typeof wiley.role !== "string" || !ROLES.has(wiley.role)) return undefined;
  return {
    diagram: wiley.diagram,
    role: wiley.role as DiagramElementRole,
    ...(typeof wiley.key === "string" ? { key: wiley.key } : {}),
  };
}
