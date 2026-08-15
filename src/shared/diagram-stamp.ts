/**
 * The identity an agent-drawn diagram element carries in its customData,
 * plus the vocabulary both processes validate against. The renderer builds
 * diagrams from it, the main process sanitizes streaming tool arguments
 * against it, and neither may drift from the other.
 */
export type DiagramElementRole = "node" | "nodeLabel" | "edge" | "edgeLabel" | "title";

export type DiagramThemeName = "slate" | "ocean" | "forest" | "sunset" | "grape" | "mono";

export const DIAGRAM_THEME_NAMES: readonly DiagramThemeName[] = [
  "slate",
  "ocean",
  "forest",
  "sunset",
  "grape",
  "mono",
];

export type DiagramNodeRole =
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "accent"
  | "muted"
  | "neutral";

export const DIAGRAM_NODE_ROLES: readonly DiagramNodeRole[] = [
  "primary",
  "success",
  "warning",
  "danger",
  "accent",
  "muted",
  "neutral",
];

export type DiagramNodeEmphasis = "normal" | "strong" | "quiet";

export const DIAGRAM_NODE_EMPHASES: readonly DiagramNodeEmphasis[] = ["normal", "strong", "quiet"];

export type DiagramEdgeLineStyle = "solid" | "dashed" | "dotted";

export const DIAGRAM_EDGE_LINE_STYLES: readonly DiagramEdgeLineStyle[] = ["solid", "dashed", "dotted"];

export type DiagramEdgeWeight = "normal" | "strong" | "quiet";

export const DIAGRAM_EDGE_WEIGHTS: readonly DiagramEdgeWeight[] = ["normal", "strong", "quiet"];

export type DiagramEdgeArrow = "none" | "end" | "both";

export const DIAGRAM_EDGE_ARROWS: readonly DiagramEdgeArrow[] = ["none", "end", "both"];

export type DiagramStamp = {
  diagram: string;
  role: DiagramElementRole;
  key?: string;
  theme?: DiagramThemeName;
};

const ROLES = new Set<string>(["node", "nodeLabel", "edge", "edgeLabel", "title"]);
const THEMES = new Set<string>(DIAGRAM_THEME_NAMES);

export function readDiagramStamp(element: unknown): DiagramStamp | undefined {
  const customData = (element as { customData?: unknown } | null)?.customData;
  const wiley = (customData as { wiley?: unknown } | null | undefined)?.wiley as
    | { diagram?: unknown; role?: unknown; key?: unknown; theme?: unknown }
    | undefined;
  if (!wiley || typeof wiley.diagram !== "string") return undefined;
  if (typeof wiley.role !== "string" || !ROLES.has(wiley.role)) return undefined;
  return {
    diagram: wiley.diagram,
    role: wiley.role as DiagramElementRole,
    ...(typeof wiley.key === "string" ? { key: wiley.key } : {}),
    ...(typeof wiley.theme === "string" && THEMES.has(wiley.theme)
      ? { theme: wiley.theme as DiagramThemeName }
      : {}),
  };
}
