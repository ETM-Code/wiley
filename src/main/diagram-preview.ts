type JsonObject = Record<string, unknown>;

const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const DIRECTIONS = new Set(["RIGHT", "DOWN"]);

function record(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Converts repaired, incomplete tool arguments into the largest safe diagram
 * prefix the renderer can show. Invalid/incomplete nodes and dangling edges
 * wait for a later delta instead of failing the final tool call.
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
      ...(typeof node.shape === "string" && SHAPES.has(node.shape) ? { shape: node.shape } : {}),
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
    ...(typeof source.anchor === "string" ? { anchor: source.anchor } : {}),
    ...(Object.keys(layout).length ? { layout } : {}),
  };
}
