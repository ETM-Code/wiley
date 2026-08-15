import {
  DIAGRAM_EDGE_ARROWS,
  DIAGRAM_EDGE_LINE_STYLES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_NODE_EMPHASES,
  DIAGRAM_NODE_ROLES,
  DIAGRAM_THEME_NAMES,
} from "../shared/diagram-stamp";

type JsonObject = Record<string, unknown>;

const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const DIRECTIONS = new Set(["RIGHT", "DOWN"]);
const NODE_ROLES = new Set<string>(DIAGRAM_NODE_ROLES);
const NODE_EMPHASES = new Set<string>(DIAGRAM_NODE_EMPHASES);
const EDGE_STYLES = new Set<string>(DIAGRAM_EDGE_LINE_STYLES);
const EDGE_WEIGHTS = new Set<string>(DIAGRAM_EDGE_WEIGHTS);
const EDGE_ARROWS = new Set<string>(DIAGRAM_EDGE_ARROWS);
const THEMES = new Set<string>(DIAGRAM_THEME_NAMES);

function record(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Only complete enum members survive; a half-streamed token waits. */
function member(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function optional(key: string, value: string | undefined): JsonObject {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Converts repaired, incomplete tool arguments into the largest safe diagram
 * prefix the renderer can show. Invalid/incomplete nodes and dangling edges
 * wait for a later delta instead of failing the final tool call.
 *
 * Every field draw_diagram accepts has to appear here: the preview queue
 * dedupes on this object, so a field it drops never reaches a live preview.
 */
export function stableDiagramPreview(value: unknown): JsonObject | undefined {
  const source = record(value);
  if (!Array.isArray(source.nodes)) return undefined;

  const ids = new Set<string>();
  const nodes: JsonObject[] = [];
  for (const candidate of source.nodes.slice(0, 100)) {
    const node = record(candidate);
    const id = text(node.id);
    const label = text(node.label);
    if (!id || !label || ids.has(id)) continue;
    ids.add(id);
    nodes.push({
      id,
      label,
      ...optional("shape", member(node.shape, SHAPES)),
      ...optional("role", member(node.role, NODE_ROLES)),
      ...optional("emphasis", member(node.emphasis, NODE_EMPHASES)),
      ...(typeof node.backgroundColor === "string" ? { backgroundColor: node.backgroundColor } : {}),
      ...(typeof node.strokeColor === "string" ? { strokeColor: node.strokeColor } : {}),
      ...(typeof node.rounded === "boolean" ? { rounded: node.rounded } : {}),
    });
  }
  if (nodes.length === 0) return undefined;

  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .slice(0, 200)
    .flatMap((candidate) => {
      const edge = record(candidate);
      const from = text(edge.from);
      const to = text(edge.to);
      if (!from || !to || !ids.has(from) || !ids.has(to)) return [];
      return [{
        from,
        to,
        ...(typeof edge.label === "string" ? { label: edge.label } : {}),
        ...optional("style", member(edge.style, EDGE_STYLES)),
        ...optional("weight", member(edge.weight, EDGE_WEIGHTS)),
        ...optional("arrow", member(edge.arrow, EDGE_ARROWS)),
        ...(typeof edge.color === "string" ? { color: edge.color } : {}),
      }];
    });

  const layoutSource = record(source.layout);
  const layout = {
    ...(typeof layoutSource.direction === "string" && DIRECTIONS.has(layoutSource.direction)
      ? { direction: layoutSource.direction }
      : {}),
    ...(typeof layoutSource.nodeSpacing === "number" && Number.isFinite(layoutSource.nodeSpacing)
      ? { nodeSpacing: layoutSource.nodeSpacing }
      : {}),
    ...(typeof layoutSource.layerSpacing === "number" && Number.isFinite(layoutSource.layerSpacing)
      ? { layerSpacing: layoutSource.layerSpacing }
      : {}),
  };

  return {
    nodes,
    edges,
    ...(typeof source.title === "string" ? { title: source.title } : {}),
    ...optional("theme", member(source.theme, THEMES)),
    ...(typeof source.anchor === "string" ? { anchor: source.anchor } : {}),
    ...(Object.keys(layout).length ? { layout } : {}),
  };
}
