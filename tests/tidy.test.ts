import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { EVENTUALLY: "EVENTUALLY", IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (skeletons: Array<Record<string, unknown>>) => skeletons,
  exportToBlob: vi.fn(),
  viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
    x: clientX,
    y: clientY,
  }),
}));

vi.mock("../src/renderer/bridge", () => ({
  bridge: { onCanvasRequest: vi.fn(() => () => undefined), respondCanvasRequest: vi.fn() },
}));

import { handleCanvasRequest } from "../src/renderer/canvas-handlers";
import { MODEL_GRID_SIZE } from "../src/renderer/diagram-layout";
import { alignBoxes, clusterAxis, tidyTargets } from "../src/renderer/canvas/tidy";
import { inferHumanGraph, type SketchElement } from "../src/renderer/canvas/human-graph";
import { messyScene, type MessyElement } from "./fixtures/messy-scenes";

type Board = {
  api: ExcalidrawImperativeAPI;
  elements: () => MessyElement[];
  captures: () => unknown[];
};

function board(initial: readonly MessyElement[]): Board {
  let elements = [...initial];
  const captures: unknown[] = [];
  const api = {
    getSceneElements: () => elements,
    getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700, viewBackgroundColor: "#fff" }),
    getFiles: () => ({}),
    updateScene: ({ elements: next, captureUpdate }: { elements: MessyElement[]; captureUpdate?: unknown }) => {
      elements = [...next];
      captures.push(captureUpdate);
    },
    scrollToContent: vi.fn(async () => undefined),
  } as unknown as ExcalidrawImperativeAPI;
  return { api, elements: () => elements, captures: () => captures };
}

type TidyResult = {
  layout: string;
  nodes: number;
  edges: number;
  moved: number;
  bound: number;
  quality?: Record<string, string[]>;
};

async function tidy(target: Board, params: Record<string, unknown> = {}) {
  return await handleCanvasRequest(target.api, {
    id: 1,
    op: "tidy-diagram",
    params,
  }) as TidyResult;
}

function defects(result: TidyResult): string[] {
  const quality = result.quality ?? {};
  return [
    ...quality.nodeOverlaps ?? [],
    ...quality.edgesThroughNodes ?? [],
    ...quality.containerContainment ?? [],
    ...quality.edgesThroughContainers ?? [],
  ];
}

describe("clusterAxis", () => {
  it("groups centres that were already meant to line up", () => {
    const clusters = clusterAxis([
      { id: "a", center: 10 },
      { id: "b", center: 22 },
      { id: "c", center: 300 },
    ], 24);
    expect(clusters).toEqual([["a", "b"], ["c"]]);
  });

  it("does not depend on the order elements sit in the scene", () => {
    const entries = [{ id: "c", center: 300 }, { id: "b", center: 22 }, { id: "a", center: 10 }];
    expect(clusterAxis(entries, 24)).toEqual([["a", "b"], ["c"]]);
  });

  it("breaks a run the moment the gap exceeds the tolerance", () => {
    const clusters = clusterAxis([
      { id: "a", center: 0 },
      { id: "b", center: 20 },
      { id: "c", center: 40 },
    ], 24);
    expect(clusters).toEqual([["a", "b"], ["c"]]);
  });
});

describe("alignBoxes", () => {
  const nodes = [
    { elementId: "a", shape: "rectangle", bounds: { x: 13, y: 7, width: 118, height: 57 } },
    { elementId: "b", shape: "rectangle", bounds: { x: 247, y: 19, width: 122, height: 63 } },
    { elementId: "c", shape: "rectangle", bounds: { x: 11, y: 201, width: 120, height: 60 } },
  ];

  it("snaps every box onto the grid", () => {
    for (const box of alignBoxes(nodes).values()) {
      for (const value of [box.x, box.y, box.width, box.height]) {
        expect(value % MODEL_GRID_SIZE).toBe(0);
      }
    }
  });

  it("keeps the arrangement the person drew", () => {
    const boxes = alignBoxes(nodes);
    expect(boxes.get("a")!.x).toBeLessThan(boxes.get("b")!.x);
    expect(boxes.get("a")!.y).toBeLessThan(boxes.get("c")!.y);
    // A row shares one top edge and a column shares one left edge, exactly.
    expect(boxes.get("a")!.y).toBe(boxes.get("b")!.y);
    expect(boxes.get("a")!.x).toBe(boxes.get("c")!.x);
  });

  it("never grows a box smaller than the person drew it", () => {
    const boxes = alignBoxes(nodes);
    for (const node of nodes) {
      expect(boxes.get(node.elementId)!.width).toBeGreaterThanOrEqual(node.bounds.width);
      expect(boxes.get(node.elementId)!.height).toBeGreaterThanOrEqual(node.bounds.height);
    }
  });
});

describe("tidyTargets", () => {
  const scene = messyScene("half-connected-flow").elements as unknown as SketchElement[];

  it("takes the whole sketch by default", () => {
    expect(tidyTargets(scene, {}).length).toBe(scene.length);
  });

  it("reaches only as far around a named element as it is told", () => {
    const near = tidyTargets(scene, { near: scene[0].id, radius: 60 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(scene.length);
  });

  it("refuses to move anything that is not the person's own", () => {
    const withAgent = [
      ...scene,
      {
        id: "agent-node",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        customData: { wiley: { diagram: "wd-x", role: "node", key: "n" } },
      },
    ] as unknown as SketchElement[];
    expect(() => tidyTargets(withAgent, { elementIds: ["agent-node"] }))
      .toThrow(/not the user's own elements/);
    expect(tidyTargets(withAgent, {})).not.toContain("agent-node");
  });
});

describe("tidy-diagram", () => {
  const scene = messyScene("crooked-signup");

  it("keeps every element, moves none of them away, and snaps the shapes", async () => {
    const target = board(scene.elements);
    const before = new Set(target.elements().map((element) => element.id));
    const result = await tidy(target);

    const after = target.elements();
    expect(new Set(after.map((element) => element.id))).toEqual(before);
    expect(after).toHaveLength(scene.elements.length);
    expect(result.moved).toBeGreaterThan(0);

    for (const element of after) {
      if (!["rectangle", "diamond", "ellipse"].includes(String(element.type))) continue;
      for (const value of [element.x, element.y, element.width, element.height]) {
        expect(value % MODEL_GRID_SIZE).toBe(0);
      }
    }
  });

  it("never stamps the person's work as its own", async () => {
    const target = board(scene.elements);
    await tidy(target);
    expect(target.elements().every((element) => element.customData === undefined)).toBe(true);
  });

  it("gives their freehand arrows real bindings in both directions", async () => {
    const target = board(scene.elements);
    const result = await tidy(target);
    expect(result.bound).toBeGreaterThan(0);

    const ids = new Set(target.elements().map((element) => element.id));
    const bound = target.elements().filter((element) => element.type === "arrow"
      && (element as { startBinding?: { elementId?: string } }).startBinding);
    expect(bound.length).toBe(result.bound);
    for (const arrow of bound) {
      const start = (arrow as { startBinding?: { elementId?: string } }).startBinding!.elementId!;
      const end = (arrow as { endBinding?: { elementId?: string } }).endBinding!.elementId!;
      expect(ids.has(start)).toBe(true);
      expect(ids.has(end)).toBe(true);
      const owner = target.elements().find((element) => element.id === start)!;
      expect((owner.boundElements as Array<{ id: string }>).some((entry) => entry.id === arrow.id)).toBe(true);
    }
  });

  it("comes out clean by the evaluator", async () => {
    const target = board(scene.elements);
    expect(defects(await tidy(target))).toEqual([]);
  });

  it("carries every caption along with the shape it names", async () => {
    const target = board(scene.elements);
    await tidy(target);
    for (const element of target.elements()) {
      const containerId = (element as { containerId?: string }).containerId;
      if (element.type !== "text" || !containerId) continue;
      const shape = target.elements().find((candidate) => candidate.id === containerId)!;
      const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
      expect(center.x).toBeCloseTo(shape.x + shape.width / 2);
      expect(center.y).toBeCloseTo(shape.y + shape.height / 2);
    }
  });

  it("captures one undo step, on the last frame only", async () => {
    const target = board(scene.elements);
    await tidy(target);
    const captures = target.captures();
    expect(captures.length).toBeGreaterThan(1);
    expect(captures.slice(0, -1).every((capture) => capture === "EVENTUALLY")).toBe(true);
    expect(captures.at(-1)).toBe("IMMEDIATELY");
  });

  it("relayout rearranges from the connections rather than straightening", async () => {
    const aligned = board(scene.elements);
    const relaid = board(scene.elements);
    await tidy(aligned, { layout: "align" });
    const result = await tidy(relaid, { layout: "relayout", direction: "RIGHT" });

    expect(result.layout).toBe("relayout");
    expect(defects(result)).toEqual([]);
    const positionsOf = (target: Board) => target.elements()
      .filter((element) => element.type === "rectangle")
      .map((element) => `${element.id}:${element.x},${element.y}`)
      .sort()
      .join("|");
    expect(positionsOf(relaid)).not.toBe(positionsOf(aligned));
    expect(new Set(relaid.elements().map((element) => element.id)))
      .toEqual(new Set(scene.elements.map((element) => element.id)));
  });

  it("leaves everything outside the named region alone", async () => {
    const target = board(scene.elements);
    const first = scene.elements.find((element) => element.type === "rectangle")!;
    const outside = scene.elements.filter(
      (element) => Math.hypot(element.x - first.x, element.y - first.y) > 400,
    );
    await tidy(target, { near: first.id, radius: 120 });
    for (const element of outside) {
      const after = target.elements().find((candidate) => candidate.id === element.id)!;
      expect({ x: after.x, y: after.y }).toEqual({ x: element.x, y: element.y });
    }
  });

  it("says so rather than guessing when there is nothing to tidy", async () => {
    await expect(tidy(board([]))).rejects.toThrow(/nothing of the user's/);
  });
});

describe("tidying a named handful of shapes", () => {
  const scene = messyScene("crooked-signup");

  it("carries their captions along without judging them as foreign", async () => {
    const target = board(scene.elements);
    const shapes = scene.elements
      .filter((element) => element.type === "rectangle")
      .map((element) => element.id);
    const result = await tidy(target, { elementIds: shapes });

    expect(defects(result)).toEqual([]);
    for (const element of target.elements()) {
      const containerId = (element as { containerId?: string }).containerId;
      if (element.type !== "text" || !containerId) continue;
      const shape = target.elements().find((candidate) => candidate.id === containerId)!;
      expect(element.x).toBeGreaterThanOrEqual(shape.x);
      expect(element.x + element.width).toBeLessThanOrEqual(shape.x + shape.width);
    }
  });
});

describe("a shape drawn around other shapes", () => {
  const scene = messyScene("grouped-cluster");

  it("is read as framing rather than as a step in the flow", () => {
    const graph = inferHumanGraph(scene.elements as unknown as SketchElement[]);
    const ring = graph.nodes.find((node) => node.elementId === "g-ring")!;
    expect(ring.encloses).toEqual(["g-a", "g-b", "g-c"]);
    expect(graph.nodes.filter((node) => node.encloses)).toHaveLength(1);
    // The arrows inside it connect the boxes, not the ring they sit in.
    expect(graph.edges.find((edge) => edge.elementId === "g-1"))
      .toMatchObject({ fromElementId: "g-a", toElementId: "g-b" });
  });

  it("keeps it around whatever it ends up holding", async () => {
    const target = board(scene.elements);
    const result = await tidy(target);
    expect(defects(result)).toEqual([]);

    const ring = target.elements().find((element) => element.id === "g-ring")!;
    for (const id of ["g-a", "g-b", "g-c"]) {
      const member = target.elements().find((element) => element.id === id)!;
      expect(member.x).toBeGreaterThan(ring.x);
      expect(member.y).toBeGreaterThan(ring.y);
      expect(member.x + member.width).toBeLessThan(ring.x + ring.width);
      expect(member.y + member.height).toBeLessThan(ring.y + ring.height);
    }
  });

  it("does the same when the whole thing is laid out again", async () => {
    const target = board(scene.elements);
    expect(defects(await tidy(target, { layout: "relayout" }))).toEqual([]);
    const ring = target.elements().find((element) => element.id === "g-ring")!;
    const member = target.elements().find((element) => element.id === "g-b")!;
    expect(member.x).toBeGreaterThan(ring.x);
    expect(member.x + member.width).toBeLessThan(ring.x + ring.width);
  });
});

describe("what tidy refuses to break", () => {
  it("never records a line as a bound arrow on a shape", async () => {
    const scene = messyScene("crooked-signup");
    const asLines = scene.elements.map((element) => element.type === "arrow"
      ? { ...element, type: "line" }
      : element);
    const target = board(asLines);
    const result = await tidy(target);

    expect(result.bound).toBe(0);
    for (const element of target.elements()) {
      expect(element.boundElements ?? []).not.toContainEqual(
        expect.objectContaining({ type: "arrow" }),
      );
      if (element.type !== "line") continue;
      expect((element as { startBinding?: unknown }).startBinding).toBeUndefined();
    }
  });

  it("carries a loose note along with the shape it was written beside", async () => {
    const scene = messyScene("half-connected-flow");
    const target = board(scene.elements);
    const before = scene.elements.find((element) => element.id === "h-aside")!;
    await tidy(target);
    const after = target.elements().find((element) => element.id === "h-aside")!;
    // Review is the box it sits nearest, so that is the one it follows,
    // rather than staying put while the grid packs together on top of it.
    const nearestBefore = scene.elements.find((element) => element.id === "h-b")!;
    const nearestAfter = target.elements().find((element) => element.id === "h-b")!;
    expect({ dx: after.x - before.x, dy: after.y - before.y })
      .toEqual({ dx: nearestAfter.x - nearestBefore.x, dy: nearestAfter.y - nearestBefore.y });
  });

  it("takes a re-pointed arrow off the shape it left", async () => {
    const scene = messyScene("crooked-signup");
    // Home still claims an arrow that actually runs from Landing to Sign up:
    // the person dragged the end off it at some point and Excalidraw left the
    // record behind.
    const seeded = scene.elements.map((element) => element.id === "s-home"
      ? { ...element, boundElements: [{ id: "a-1", type: "arrow" }] }
      : element);
    const target = board(seeded);
    await tidy(target);

    const arrow = target.elements().find((element) => element.id === "a-1")!;
    const start = (arrow as { startBinding?: { elementId?: string } }).startBinding!.elementId;
    // a-1 runs from Landing to Sign up, so the tidy re-points it off Home.
    expect(start).toBe("s-landing");
    const abandoned = target.elements().find((element) => element.id === "s-home")!;
    expect(abandoned.boundElements ?? []).not.toContainEqual({ id: "a-1", type: "arrow" });
  });
});

describe("shapes drawn nearly on top of each other", () => {
  const stacked: MessyElement[] = [
    { id: "n-a", type: "rectangle", x: 0, y: 0, width: 120, height: 60, version: 1 },
    { id: "n-b", type: "rectangle", x: 14, y: 12, width: 120, height: 60, version: 2 },
    { id: "n-c", type: "rectangle", x: 400, y: 0, width: 120, height: 60, version: 3 },
  ];

  it("are given cells of their own rather than the same one", () => {
    const nodes = stacked.map((element) => ({
      elementId: element.id,
      shape: element.type,
      bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
    }));
    const boxes = alignBoxes(nodes);
    const corners = [...boxes.values()].map((box) => `${box.x},${box.y}`);
    expect(new Set(corners).size).toBe(corners.length);
  });

  it("survive a tidy instead of failing it", async () => {
    const target = board(stacked);
    expect(defects(await tidy(target))).toEqual([]);
    expect(target.elements()).toHaveLength(stacked.length);
  });
});

describe("tidying only the shapes someone named", () => {
  const scene = messyScene("crooked-signup");

  it("brings the arrows between them along", async () => {
    const target = board(scene.elements);
    const shapes = scene.elements
      .filter((element) => element.type === "rectangle")
      .map((element) => element.id);
    const result = await tidy(target, { elementIds: shapes });

    expect(result.edges).toBe(3);
    expect(result.bound).toBe(3);
    for (const before of scene.elements.filter((element) => element.type === "arrow")) {
      const after = target.elements().find((element) => element.id === before.id)!;
      const start = (after as { startBinding?: { elementId?: string } }).startBinding;
      expect(start?.elementId).toBeDefined();
      expect({ x: after.x, y: after.y }).not.toEqual({ x: before.x, y: before.y });
    }
  });
});

describe("a screenshot in the sketch", () => {
  it("keeps its proportions through a tidy", async () => {
    const scene = messyScene("crooked-signup");
    const shot: MessyElement = {
      id: "shot", type: "image", x: 600, y: 40, width: 331, height: 187, version: 99,
    };
    const target = board([...scene.elements, shot]);
    await tidy(target);
    const after = target.elements().find((element) => element.id === "shot")!;
    expect({ width: after.width, height: after.height })
      .toEqual({ width: shot.width, height: shot.height });
  });
});

describe("an arrow drawn onto a framing shape", () => {
  const scene = messyScene("grouped-cluster");

  it("is read as reaching the ring itself", () => {
    const graph = inferHumanGraph(scene.elements as unknown as SketchElement[]);
    expect(graph.edges.find((edge) => edge.elementId === "g-3"))
      .toMatchObject({ fromElementId: "g-ring", toElementId: "g-out" });
  });

  it("does not stop a relayout, which never lays the ring out", async () => {
    const target = board(scene.elements);
    const result = await tidy(target, { layout: "relayout" });
    expect(defects(result)).toEqual([]);
    expect(target.elements()).toHaveLength(scene.elements.length);
  });

  it("does not stop an align either", async () => {
    expect(defects(await tidy(board(scene.elements), { layout: "align" }))).toEqual([]);
  });
});

describe("an arrow the tidy is not moving both ends of", () => {
  it("is left alone rather than pulled off the shape that stayed put", async () => {
    const elements: MessyElement[] = [
      { id: "in-a", type: "rectangle", x: 13, y: 11, width: 120, height: 60, version: 1 },
      { id: "in-b", type: "rectangle", x: 300, y: 17, width: 120, height: 60, version: 2 },
      { id: "outside", type: "rectangle", x: 900, y: 600, width: 120, height: 60, version: 3 },
      {
        id: "arr",
        type: "arrow",
        x: 133,
        y: 41,
        width: 767,
        height: 589,
        points: [[0, 0], [767, 589]],
        startBinding: { elementId: "in-a" },
        endBinding: { elementId: "outside" },
        version: 4,
      },
    ];
    const target = board(elements);
    await tidy(target, { elementIds: ["in-a", "in-b"] });

    const after = target.elements().find((element) => element.id === "arr")!;
    const before = elements[3];
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
    expect(target.elements().find((element) => element.id === "outside"))
      .toMatchObject({ x: 900, y: 600 });
  });
});
