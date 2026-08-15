import {
  DIAGRAM_CONTAINER_RENDERS,
  DIAGRAM_EDGE_ARROWS,
  DIAGRAM_EDGE_LABEL_MODES,
  DIAGRAM_EDGE_LINE_STYLES,
  DIAGRAM_EDGE_WEIGHTS,
  DIAGRAM_NODE_EMPHASES,
  DIAGRAM_NODE_ROLES,
  DIAGRAM_THEME_NAMES,
} from "../shared/diagram-stamp";

type JsonObject = Record<string, unknown>;

const SHAPES = new Set(["rectangle", "diamond", "ellipse", "text"]);
const DIRECTIONS = new Set(["RIGHT", "DOWN", "LEFT", "UP"]);
const ALGORITHMS = new Set(["layered", "tree", "radial", "force", "stress"]);
const NODE_ROLES = new Set<string>(DIAGRAM_NODE_ROLES);
const NODE_EMPHASES = new Set<string>(DIAGRAM_NODE_EMPHASES);
const EDGE_STYLES = new Set<string>(DIAGRAM_EDGE_LINE_STYLES);
const EDGE_WEIGHTS = new Set<string>(DIAGRAM_EDGE_WEIGHTS);
const EDGE_ARROWS = new Set<string>(DIAGRAM_EDGE_ARROWS);
const THEMES = new Set<string>(DIAGRAM_THEME_NAMES);
const CONTAINER_RENDERS = new Set<string>(DIAGRAM_CONTAINER_RENDERS);
const EDGE_LABEL_MODES = new Set<string>(DIAGRAM_EDGE_LABEL_MODES);

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
 * The containers safe to draw at this point in the stream: complete, rooted in
 * a complete parent, still waiting on none of their members, and holding at
 * least one node that has arrived. A container waiting on anything below it
 * takes its ancestors down with it, so a half-populated region never flashes
 * up and then re-flows.
 */
function stableContainers(
  value: unknown,
  pending: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
): JsonObject[] {
  const parsed: JsonObject[] = [];
  const seen = new Set<string>();
  for (const candidate of (Array.isArray(value) ? value : []).slice(0, 50)) {
    const container = record(candidate);
    const id = text(container.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    parsed.push({
      id,
      ...(typeof container.label === "string" ? { label: container.label } : {}),
      ...optional("parent", text(container.parent)),
      ...optional("role", member(container.role, NODE_ROLES)),
      ...optional("render", member(container.render, CONTAINER_RENDERS)),
    });
  }
  const byId = new Map(parsed.map((container) => [String(container.id), container]));
  const parentOf = (id: string) => {
    const parent = byId.get(id)?.parent;
    return typeof parent === "string" && byId.has(parent) && parent !== id ? parent : undefined;
  };
  // A pending member blocks its own container and every ancestor of it. A
  // container naming a parent that has not streamed in yet blocks itself.
  const unrooted = [...byId.values()]
    .filter((container) => typeof container.parent === "string" && !byId.has(container.parent))
    .map((container) => String(container.id));
  const blocked = new Set<string>();
  for (const id of [...pending, ...unrooted]) {
    let cursor: string | undefined = id;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      blocked.add(cursor);
      cursor = parentOf(cursor);
    }
  }
  // Occupancy flows the other way: a populated child keeps its ancestors alive.
  const occupied = new Set<string>();
  for (const id of claimed) {
    let cursor: string | undefined = id;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      occupied.add(cursor);
      cursor = parentOf(cursor);
    }
  }
  const visible = (id: string): boolean => {
    if (blocked.has(id) || !occupied.has(id)) return false;
    const parent = byId.get(id)?.parent;
    if (typeof parent !== "string") return true;
    return byId.has(parent) && parent !== id && visible(parent);
  };
  return parsed.filter((container) => visible(String(container.id)));
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
  // A container is only safe to draw once every node that claims it has
  // arrived: half a region is worse than no region at all.
  const pendingContainers = new Set<string>();
  const claimedContainers = new Set<string>();
  for (const candidate of source.nodes.slice(0, 100)) {
    const node = record(candidate);
    const id = text(node.id);
    const label = text(node.label);
    const container = text(node.container);
    if (!id || !label || ids.has(id)) {
      if (container) pendingContainers.add(container);
      continue;
    }
    ids.add(id);
    if (container) claimedContainers.add(container);
    nodes.push({
      id,
      label,
      ...optional("shape", member(node.shape, SHAPES)),
      ...optional("role", member(node.role, NODE_ROLES)),
      ...optional("emphasis", member(node.emphasis, NODE_EMPHASES)),
      ...(typeof node.backgroundColor === "string" ? { backgroundColor: node.backgroundColor } : {}),
      ...(typeof node.strokeColor === "string" ? { strokeColor: node.strokeColor } : {}),
      ...(typeof node.rounded === "boolean" ? { rounded: node.rounded } : {}),
      ...optional("container", container),
    });
  }
  if (nodes.length === 0) return undefined;

  const containers = stableContainers(source.containers, pendingContainers, claimedContainers);
  const visibleContainers = new Set(containers.map((container) => String(container.id)));
  for (const node of nodes) {
    if (typeof node.container === "string" && !visibleContainers.has(node.container)) {
      delete node.container;
    }
  }

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
        ...optional("labelMode", member(edge.labelMode, EDGE_LABEL_MODES)),
        ...(typeof edge.color === "string" ? { color: edge.color } : {}),
      }];
    });

  const layoutSource = record(source.layout);
  const layout = {
    ...optional("algorithm", member(layoutSource.algorithm, ALGORITHMS)),
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
    ...(containers.length ? { containers } : {}),
    ...(typeof source.title === "string" ? { title: source.title } : {}),
    ...optional("theme", member(source.theme, THEMES)),
    ...(typeof source.anchor === "string" ? { anchor: source.anchor } : {}),
    ...(Object.keys(layout).length ? { layout } : {}),
  };
}
