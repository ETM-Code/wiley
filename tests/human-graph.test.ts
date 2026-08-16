import { describe, expect, it } from "vitest";

import {
  distanceToBounds,
  formatHumanGraph,
  humanGraphPayload,
  inferHumanGraph,
  looseEdgeCount,
  polylineMidpoint,
  type SketchElement,
} from "../src/renderer/canvas/human-graph";

function box(
  id: string,
  x: number,
  y: number,
  width = 120,
  height = 60,
  type = "rectangle",
): SketchElement {
  return { id, type, x, y, width, height };
}

function text(id: string, x: number, y: number, value: string, containerId?: string): SketchElement {
  return {
    id,
    type: "text",
    x,
    y,
    width: Math.max(20, value.length * 8),
    height: 20,
    text: value,
    ...(containerId ? { containerId } : {}),
  };
}

function arrow(
  id: string,
  from: [number, number],
  to: [number, number],
  bindings: { start?: string; end?: string } = {},
): SketchElement {
  return {
    id,
    type: "arrow",
    x: from[0],
    y: from[1],
    width: to[0] - from[0],
    height: to[1] - from[1],
    points: [[0, 0], [to[0] - from[0], to[1] - from[1]]],
    ...(bindings.start ? { startBinding: { elementId: bindings.start } } : {}),
    ...(bindings.end ? { endBinding: { elementId: bindings.end } } : {}),
  };
}

describe("distanceToBounds", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  it("reads zero anywhere inside the shape", () => {
    expect(distanceToBounds({ x: 50, y: 50 }, bounds)).toBe(0);
    expect(distanceToBounds({ x: 0, y: 0 }, bounds)).toBe(0);
  });

  it("measures the straight-line gap outside it", () => {
    expect(distanceToBounds({ x: 110, y: 50 }, bounds)).toBe(10);
    expect(distanceToBounds({ x: 103, y: 104 }, bounds)).toBeCloseTo(5);
  });
});

describe("polylineMidpoint", () => {
  it("halves a straight run", () => {
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toEqual({ x: 50, y: 0 });
  });

  it("halves by length rather than by point count", () => {
    const middle = polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 110, y: 0 }]);
    expect(middle.x).toBeCloseTo(55);
  });
});

describe("inferHumanGraph nodes", () => {
  it("reads shapes with bound labels", () => {
    const graph = inferHumanGraph([
      box("shape-a", 0, 0),
      text("label-a", 20, 20, "Login", "shape-a"),
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ elementId: "shape-a", shape: "rectangle", label: "Login" });
    expect(graph.nodes[0].labelElementId).toBeUndefined();
    expect(graph.unattached).toEqual([]);
  });

  it("adopts a free text sitting inside a shape", () => {
    const graph = inferHumanGraph([
      box("shape-a", 0, 0),
      text("caption", 30, 20, "Home"),
    ]);
    expect(graph.nodes[0].label).toBe("Home");
    expect(graph.nodes[0].labelElementId).toBe("caption");
    expect(graph.unattached).toEqual([]);
  });

  it("adopts a free text just outside the shape but leaves a distant one alone", () => {
    const near = inferHumanGraph([box("shape-a", 0, 0), text("near", 55, 60, "Near")]);
    expect(near.nodes[0].label).toBe("Near");

    const far = inferHumanGraph([box("shape-a", 0, 0), text("far", 55, 200, "Far")]);
    expect(far.nodes[0].label).toBeUndefined();
    expect(far.unattached).toEqual(["far"]);
  });

  it("gives an ambiguous caption to the nearer of two overlapping boxes", () => {
    const graph = inferHumanGraph([
      box("zzz-left", 0, 0, 100, 100),
      box("aaa-right", 90, 0, 100, 100),
      // Centre sits inside the right box and 4px outside the left one.
      text("caption", 100, 45, "Q"),
    ]);
    const labelled = graph.nodes.filter((node) => node.label === "Q");
    expect(labelled).toHaveLength(1);
    expect(labelled[0].elementId).toBe("aaa-right");
  });

  it("breaks an exact tie on element id", () => {
    const graph = inferHumanGraph([
      box("shape-b", 0, 0, 100, 100),
      box("shape-a", 0, 0, 100, 100),
      text("caption", 45, 45, "Q"),
    ]);
    expect(graph.nodes.find((node) => node.label === "Q")?.elementId).toBe("shape-a");
  });

  it("never reads a freedraw scribble as a node", () => {
    const graph = inferHumanGraph([
      box("shape-a", 0, 0),
      { id: "scribble", type: "freedraw", x: 300, y: 300, width: 90, height: 40 },
    ]);
    expect(graph.nodes.map((node) => node.elementId)).toEqual(["shape-a"]);
    expect(graph.unattached).toEqual(["scribble"]);
  });

  it("ignores stamped agent elements and deleted ones", () => {
    const graph = inferHumanGraph([
      { ...box("agent-node", 0, 0), customData: { wiley: { diagram: "d1", role: "node", key: "n1" } } },
      { ...box("gone", 200, 0), isDeleted: true },
      box("mine", 400, 0),
    ]);
    expect(graph.nodes.map((node) => node.elementId)).toEqual(["mine"]);
  });

  it("honours an element-id scope and pulls bound labels in with their shape", () => {
    const graph = inferHumanGraph([
      box("shape-a", 0, 0),
      text("label-a", 20, 20, "Kept", "shape-a"),
      box("shape-b", 400, 0),
    ], { elementIds: ["shape-a"] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe("Kept");
  });
});

describe("inferHumanGraph edges", () => {
  it("follows real bindings", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0),
      box("b", 400, 0),
      arrow("edge", [500, 500], [600, 600], { start: "a", end: "b" }),
    ]);
    expect(graph.edges[0]).toMatchObject({
      elementId: "edge",
      fromElementId: "a",
      toElementId: "b",
      bound: { start: true, end: true },
    });
  });

  it("attaches an unbound arrow whose ends land on the shapes", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0),
      box("b", 300, 0),
      arrow("edge", [120, 30], [300, 30]),
    ]);
    expect(graph.edges[0]).toMatchObject({
      fromElementId: "a",
      toElementId: "b",
      bound: { start: false, end: false },
    });
  });

  it("forgives a near miss and refuses a real miss", () => {
    const near = inferHumanGraph([
      box("a", 0, 0),
      box("b", 300, 0),
      arrow("edge", [134, 30], [286, 30]),
    ]);
    expect(near.edges[0].fromElementId).toBe("a");
    expect(near.edges[0].toElementId).toBe("b");

    const wide = inferHumanGraph([
      box("a", 0, 0),
      box("b", 300, 0),
      arrow("edge", [200, 30], [240, 30]),
    ]);
    expect(wide.edges[0].fromElementId).toBeUndefined();
    expect(wide.edges[0].toElementId).toBeUndefined();
    expect(looseEdgeCount(wide)).toBe(1);
  });

  it("gives a big shape a proportionally bigger catch radius", () => {
    const graph = inferHumanGraph([
      box("big", 0, 0, 400, 400),
      arrow("edge", [430, 200], [700, 200]),
    ]);
    expect(graph.edges[0].fromElementId).toBe("big");
  });

  it("keeps a half-connected arrow as a half-connected edge", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0),
      arrow("edge", [120, 30], [400, 30]),
    ]);
    expect(graph.edges[0].fromElementId).toBe("a");
    expect(graph.edges[0].toElementId).toBeUndefined();
    expect(looseEdgeCount(graph)).toBe(1);
  });

  it("claims a floating text near the arrow midpoint as its label", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0),
      box("b", 300, 0),
      arrow("edge", [120, 30], [300, 30]),
      text("caption", 200, 20, "then"),
    ]);
    expect(graph.edges[0].label).toBe("then");
    expect(graph.edges[0].labelElementId).toBe("caption");
    expect(graph.unattached).toEqual([]);
  });

  it("leaves a text far from the midpoint unattached", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0),
      box("b", 300, 0),
      arrow("edge", [120, 30], [300, 30]),
      text("caption", 200, 300, "elsewhere"),
    ]);
    expect(graph.edges[0].label).toBeUndefined();
    expect(graph.unattached).toEqual(["caption"]);
  });

  it("prefers a shape caption over an arrow caption for the same text", () => {
    const graph = inferHumanGraph([
      box("a", 0, 0, 120, 60),
      box("b", 200, 0, 120, 60),
      // Runs through the gap; its midpoint lands inside neither box.
      arrow("edge", [120, 30], [200, 30]),
      text("caption", 40, 20, "inside a"),
    ]);
    expect(graph.nodes.find((node) => node.elementId === "a")?.label).toBe("inside a");
    expect(graph.edges[0].label).toBeUndefined();
  });

  it("ignores a binding that points at an agent-owned element", () => {
    const graph = inferHumanGraph([
      { ...box("agent", 0, 0), customData: { wiley: { diagram: "d1", role: "node", key: "n1" } } },
      box("b", 400, 0),
      arrow("edge", [700, 700], [800, 800], { start: "agent", end: "b" }),
    ]);
    expect(graph.edges[0].fromElementId).toBeUndefined();
    expect(graph.edges[0].bound).toEqual({ start: false, end: true });
  });
});

describe("human graph reporting", () => {
  const scene: SketchElement[] = [
    box("a", 0, 0),
    text("la", 10, 10, "Login", "a"),
    box("b", 300, 0),
    text("lb", 310, 10, "Home", "b"),
    arrow("e1", [120, 30], [300, 30]),
    arrow("e2", [600, 600], [700, 700]),
    { id: "scribble", type: "freedraw", x: 900, y: 900, width: 20, height: 20 },
  ];

  it("summarizes what the person drew in their own words", () => {
    const line = formatHumanGraph(inferHumanGraph(scene));
    expect(line).toBe('human sketch: 2 shapes ("Login", "Home"), 2 connectors (1 unattached), 1 loose marks');
  });

  it("says nothing when there is no sketch", () => {
    expect(formatHumanGraph(inferHumanGraph([]))).toBe("(none)");
  });

  it("carries real element ids in the payload", () => {
    const payload = humanGraphPayload(inferHumanGraph(scene));
    expect(payload.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(payload.edges[0]).toMatchObject({ id: "e1", from: "a", to: "b" });
    expect(payload.edges[1]).toMatchObject({ id: "e2", from: null, to: null });
    expect(payload.unattached).toEqual(["scribble"]);
  });
});
