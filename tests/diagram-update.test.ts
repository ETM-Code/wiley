import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { EVENTUALLY: "EVENTUALLY", IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (
    skeletons: Array<Record<string, unknown>>,
    opts?: { regenerateIds?: boolean },
  ) => {
    const keepIds = opts?.regenerateIds === false;
    return skeletons.flatMap((item, index) => {
      const points = item.points as Array<[number, number]> | undefined;
      const id = keepIds ? String(item.id) : `converted-${index}`;
      const width = (item.width as number | undefined) ?? Math.abs(points?.at(-1)?.[0] ?? 0);
      const height = (item.height as number | undefined) ?? Math.abs(points?.at(-1)?.[1] ?? 0);
      const start = item.start as { id?: string } | undefined;
      const end = item.end as { id?: string } | undefined;
      const element = {
        ...item,
        id,
        width,
        height,
        version: 1,
        ...(start?.id ? { startBinding: { elementId: start.id } } : {}),
        ...(end?.id ? { endBinding: { elementId: end.id } } : {}),
      };
      const label = (item.label as { text?: string } | undefined)?.text;
      if (!label) return [element];
      return [element, {
        id: `${id}-label`,
        type: "text",
        x: (item.x as number) + width / 2,
        y: (item.y as number) + height / 2,
        width: Math.max(1, label.length * 8),
        height: 24,
        text: label,
        containerId: id,
        version: 1,
      }];
    });
  },
  exportToBlob: vi.fn(),
  viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
    x: clientX,
    y: clientY,
  }),
}));

vi.mock("../src/renderer/bridge", () => ({
  bridge: {
    onCanvasRequest: vi.fn(() => () => undefined),
    respondCanvasRequest: vi.fn(),
  },
}));

import { handleCanvasRequest } from "../src/renderer/canvas-handlers";
import type { SceneElement } from "../src/renderer/canvas/types";
import { mergeSpec, reconstructSpec, resolveTargetDiagram } from "../src/renderer/canvas/diagram-reconstruct";
import { placeUpdatedPlan } from "../src/renderer/canvas/diagram-update";
import {
  assertDiagramQuality,
  assertQualityClearOfHuman,
  diagramDefects,
  placementCollisions,
} from "../src/renderer/canvas/diagram-render";
import { planBounds, planDiagramLayout } from "../src/renderer/diagram-layout";
import { resampleRoute, tweenGeometry } from "../src/renderer/diagram-diff";

type SceneRecord = Record<string, unknown> & {
  id: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string;
  groupIds?: string[];
  customData?: { wiley?: { key?: string; role?: string; container?: string } };
};

type Board = {
  api: ExcalidrawImperativeAPI;
  elements: () => SceneRecord[];
  frames: () => SceneRecord[][];
  captures: () => unknown[];
  reads: () => number;
};

function board(initial: SceneRecord[] = []): Board {
  let elements = [...initial];
  let reads = 0;
  const frames: SceneRecord[][] = [];
  const captures: unknown[] = [];
  const api = {
    getSceneElements: () => {
      reads += 1;
      return elements;
    },
    getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700, viewBackgroundColor: "#fff" }),
    getFiles: () => ({}),
    updateScene: ({ elements: next, captureUpdate }: { elements: SceneRecord[]; captureUpdate?: unknown }) => {
      elements = [...next];
      frames.push(elements);
      captures.push(captureUpdate);
    },
    scrollToContent: vi.fn(async () => undefined),
  } as unknown as ExcalidrawImperativeAPI;
  return {
    api,
    elements: () => elements,
    frames: () => frames,
    captures: () => captures,
    reads: () => reads,
  };
}

const flow = {
  title: "Delivery",
  theme: "ocean" as const,
  nodes: [
    { id: "accept", label: "Accept" },
    { id: "queue", label: "Queue" },
    { id: "deliver", label: "Deliver" },
  ],
  edges: [
    { from: "accept", to: "queue", label: "enqueue" },
    { from: "queue", to: "deliver", label: "drain" },
  ],
};

/** The fakes carry only the fields the code reads; the editor's type is wider. */
function asScene(elements: readonly SceneRecord[]): SceneElement[] {
  return elements as unknown as SceneElement[];
}

async function drawFlow(target: Board, params: Record<string, unknown> = flow) {
  return await handleCanvasRequest(target.api, {
    id: 1,
    op: "layout-diagram",
    params,
  }) as { diagramId: string; idMap: Record<string, string> };
}

describe("resolveTargetDiagram", () => {
  it("accepts the diagram's own id or any element inside it", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const scene = target.elements();
    expect(resolveTargetDiagram(asScene(scene), drawn.diagramId)).toBe(drawn.diagramId);
    expect(resolveTargetDiagram(asScene(scene), drawn.idMap.queue)).toBe(drawn.diagramId);
    expect(() => resolveTargetDiagram(asScene(scene), "nothing")).toThrow(/No diagram/);
    expect(() => resolveTargetDiagram(asScene(scene), undefined)).toThrow(/requires a diagram id/);
  });
});

describe("reconstructSpec", () => {
  it("rebuilds the graph from the stamps and bindings on the board", async () => {
    const target = board();
    const drawn = await drawFlow(target, {
      ...flow,
      containers: [{ id: "tier", label: "Runtime" }],
      nodes: [
        { id: "accept", label: "Accept" },
        { id: "queue", label: "Queue", shape: "diamond", container: "tier" },
        { id: "deliver", label: "Deliver", container: "tier" },
      ],
    });
    const spec = reconstructSpec(asScene(target.elements()), drawn.diagramId);
    expect(spec.title).toBe("Delivery");
    expect(spec.theme).toBe("ocean");
    expect(spec.nodes).toEqual([
      { id: "accept", label: "Accept" },
      { id: "queue", label: "Queue", shape: "diamond", container: "tier" },
      { id: "deliver", label: "Deliver", container: "tier" },
    ]);
    expect(spec.containers).toEqual([{ id: "tier", label: "Runtime" }]);
    expect(spec.edges).toEqual([
      { from: "accept", to: "queue", label: "enqueue" },
      { from: "queue", to: "deliver", label: "drain" },
    ]);
  });
});

describe("mergeSpec", () => {
  const existing = {
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b", label: "one" }, { from: "a", to: "b", label: "two" }],
  };

  it("replaces what is named and keeps what is not", () => {
    const merged = mergeSpec(existing, {
      nodes: [{ id: "b", label: "Renamed" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b", label: "edited" }],
    });
    expect(merged.nodes).toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "Renamed" },
      { id: "c", label: "C" },
    ]);
    // Only the first of the two parallel edges was claimed.
    expect(merged.edges).toEqual([
      { from: "a", to: "b", label: "edited" },
      { from: "a", to: "b", label: "two" },
    ]);
  });
});

describe("route tweening", () => {
  it("spaces a resampled route evenly along its own length", () => {
    expect(resampleRoute([[0, 0], [100, 0]], 3)).toEqual([[0, 0], [50, 0], [100, 0]]);
    const bent = resampleRoute([[0, 0], [0, 100], [100, 100]], 3);
    expect(bent[0]).toEqual([0, 0]);
    expect(bent[1]).toEqual([0, 100]);
    expect(bent[2]).toEqual([100, 100]);
  });

  it("grows a straight arrow into a bent one without changing point count", () => {
    const from = { x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] as Array<[number, number]> };
    const to = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: [[0, 0], [50, 60], [100, 100]] as Array<[number, number]>,
    };
    const midway = tweenGeometry(from, to, 0.5);
    expect(midway.points).toHaveLength(3);
    expect(midway.points![0]).toEqual([0, 0]);
    expect(midway.points![1][1]).toBeGreaterThan(0);
    // The ends are exact rather than resampled.
    expect(tweenGeometry(from, to, 1).points).toEqual(to.points);
    expect(tweenGeometry(from, to, 0).points).toEqual(from.points);
  });
});

describe("update-diagram", () => {
  it("keeps survivors as the same elements and animates prune, move, then add", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const beforeIds = new Set(target.elements().map((element) => element.id));
    const framesBefore = target.frames().length;

    const result = await handleCanvasRequest(target.api, {
      id: 2,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "retry", label: "Retry" }],
        edges: [{ from: "deliver", to: "retry", label: "bounce" }],
      },
    }) as {
      diagramId: string;
      counts: { added: number; removed: number; moved: number; relabeled: number };
      quality: Record<string, string[]>;
    };

    expect(result.diagramId).toBe(drawn.diagramId);
    expect(result.counts.added).toBeGreaterThan(0);
    expect(result.counts.removed).toBe(0);
    for (const findings of Object.values(result.quality)) expect(findings).toEqual([]);

    const after = target.elements();
    // The nodes that survived are the very same elements, not replacements.
    for (const key of ["accept", "queue", "deliver"]) {
      expect(after.some((element) => element.id === drawn.idMap[key])).toBe(true);
      expect(beforeIds.has(drawn.idMap[key])).toBe(true);
    }
    expect(after.some((element) => element.customData?.wiley?.key === "retry")).toBe(true);
    // The added node arrives after the survivors have moved.
    const frames = target.frames().slice(framesBefore);
    expect(frames.length).toBeGreaterThan(2);
    const firstWithRetry = frames.findIndex(
      (frame) => frame.some((element) => element.customData?.wiley?.key === "retry"),
    );
    expect(firstWithRetry).toBeGreaterThan(0);
    // Nothing is captured as its own undo step until the last frame.
    expect(after.filter((element) => element.type === "arrow")).toHaveLength(3);
  });

  it("deletes in replace mode and takes the bound label with it", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const result = await handleCanvasRequest(target.api, {
      id: 3,
      op: "update-diagram",
      params: {
        diagram: drawn.idMap.accept,
        mode: "replace",
        title: "Delivery",
        theme: "ocean",
        nodes: [{ id: "accept", label: "Accept" }, { id: "queue", label: "Queue" }],
        edges: [{ from: "accept", to: "queue", label: "enqueue" }],
      },
    }) as { counts: { removed: number } };

    expect(result.counts.removed).toBeGreaterThan(0);
    const after = target.elements();
    expect(after.some((element) => element.id === drawn.idMap.deliver)).toBe(false);
    expect(after.some((element) => element.containerId === drawn.idMap.deliver)).toBe(false);
    expect(after.some((element) => element.id === drawn.idMap.accept)).toBe(true);
  });

  it("counts a relabel without adding or removing anything", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const result = await handleCanvasRequest(target.api, {
      id: 4,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "queue", label: "Buffer" }],
      },
    }) as { counts: { added: number; removed: number; relabeled: number } };

    expect(result.counts).toMatchObject({ added: 0, removed: 0, relabeled: 1 });
    const label = target.elements().find((element) => element.containerId === drawn.idMap.queue);
    expect(label?.text).toBe("Buffer");
  });

  it("pins the diagram to the corner it already occupied", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const corner = target.elements()
      .filter((element) => element.customData?.wiley)
      .reduce((best, element) => ({
        x: Math.min(best.x, element.x),
        y: Math.min(best.y, element.y),
      }), { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY });

    await handleCanvasRequest(target.api, {
      id: 5,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "retry", label: "Retry" }, { id: "audit", label: "Audit" }],
        edges: [{ from: "deliver", to: "retry" }, { from: "retry", to: "audit" }],
      },
    });
    const after = target.elements()
      .filter((element) => element.customData?.wiley)
      .reduce((best, element) => ({
        x: Math.min(best.x, element.x),
        y: Math.min(best.y, element.y),
      }), { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY });
    expect(after).toEqual(corner);
  });

  it("slides along the axis it grew on when it would land on foreign work", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const bounds = target.elements().reduce((box, element) => ({
      maxX: Math.max(box.maxX, element.x + element.width),
      minY: Math.min(box.minY, element.y),
    }), { maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY });
    // A hand-drawn note sitting just past the diagram's right edge.
    target.api.updateScene({
      elements: [...target.elements(), {
        id: "human-note",
        type: "rectangle",
        x: bounds.maxX + 40,
        y: bounds.minY,
        width: 400,
        height: 400,
        version: 1,
      }] as never,
    });

    const result = await handleCanvasRequest(target.api, {
      id: 6,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "retry", label: "Retry" }],
        edges: [{ from: "deliver", to: "retry", label: "bounce" }],
      },
    }) as { shifted?: { dx: number; dy: number } };

    expect(result.shifted).toBeTruthy();
    expect(result.shifted!.dx).toBeGreaterThan(0);
    // The human's note is untouched and nothing landed on top of it.
    const note = target.elements().find((element) => element.id === "human-note")!;
    expect(note).toMatchObject({ x: bounds.maxX + 40, y: bounds.minY });
    const mine = target.elements().filter((element) => element.customData?.wiley);
    expect(mine.every((element) => element.x >= note.x + note.width
      || element.x + element.width <= note.x
      || element.y >= note.y + note.height
      || element.y + element.height <= note.y)).toBe(true);
  });

  it("abandons the animation and commits when the human edits mid-tween", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    // A hand-drawn element appears a few frames into the animation, which is
    // the cue to stop tweening and commit the finished scene.
    const api = target.api as unknown as { getSceneElements: () => SceneRecord[] };
    const original = api.getSceneElements;
    const appearsAfter = target.reads() + 12;
    api.getSceneElements = () => {
      const live = original.call(target.api) as SceneRecord[];
      if (target.reads() < appearsAfter) return live;
      return [...live, {
        id: "human-late",
        type: "rectangle",
        x: -900,
        y: -900,
        width: 40,
        height: 40,
      } as SceneRecord];
    };

    const framesBefore = target.frames().length;
    const result = await handleCanvasRequest(target.api, {
      id: 7,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "retry", label: "Retry" }],
        edges: [{ from: "deliver", to: "retry" }],
      },
    }) as { counts: { added: number } };

    expect(result.counts.added).toBeGreaterThan(0);
    // The final scene is complete regardless of where the tween gave up, and
    // the human's element is still there.
    expect(target.elements().some((element) => element.customData?.wiley?.key === "retry")).toBe(true);
    expect(target.frames().length - framesBefore).toBeLessThan(20);
  });

  it("captures one undo step, on the last frame only", async () => {
    const target = board();
    const drawn = await drawFlow(target);
    const before = target.captures().length;
    await handleCanvasRequest(target.api, {
      id: 9,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        nodes: [{ id: "retry", label: "Retry" }],
        edges: [{ from: "deliver", to: "retry" }],
      },
    });
    const captures = target.captures().slice(before);
    expect(captures.length).toBeGreaterThan(1);
    expect(captures.slice(0, -1).every((capture) => capture === "EVENTUALLY")).toBe(true);
    expect(captures.at(-1)).toBe("IMMEDIATELY");
  });

  it("refuses a diagram that is not on the board", async () => {
    const target = board();
    await expect(handleCanvasRequest(target.api, {
      id: 8,
      op: "update-diagram",
      params: { diagram: "wd-nothing", nodes: [{ id: "a", label: "A" }], edges: [] },
    })).rejects.toThrow(/No diagram/);
  });
});

describe("placeUpdatedPlan", () => {
  it("leaves a plan alone when nothing is in the way", async () => {
    const plan = await planDiagramLayout(flow, { x: 0, y: 0 }, "wd-test");
    const shifted = placeUpdatedPlan(plan, { minX: 500, minY: 300, maxX: 900, maxY: 600 }, []);
    expect(shifted).toBeUndefined();
    const minX = Math.min(...plan.skeletons.map((skeleton) => skeleton.x as number));
    expect(minX).toBe(500);
  });
});

describe("update-diagram reaching into the human's sketch", () => {
  /** Draws the flow, then puts a hand-drawn box well below it. */
  async function boardWithSketch() {
    const target = board();
    const drawn = await drawFlow(target);
    const deliver = target.elements().find(
      (element) => element.customData?.wiley?.key === "deliver",
    )!;
    const sketch: SceneRecord = {
      id: "sketch-login",
      type: "rectangle",
      x: deliver.x,
      y: deliver.y + 500,
      width: 160,
      height: 80,
    };
    const caption: SceneRecord = {
      id: "sketch-login-text",
      type: "text",
      x: sketch.x + 20,
      y: sketch.y + 30,
      width: 60,
      height: 20,
      text: "Login",
      containerId: "sketch-login",
    };
    target.api.updateScene({
      elements: [...target.elements(), sketch, caption] as never,
      captureUpdate: "IMMEDIATELY" as never,
    });
    return { target, drawn, sketch, caption };
  }

  it("binds a new edge to the person's own element instead of copying it", async () => {
    const { target, drawn, sketch } = await boardWithSketch();
    const connected = await handleCanvasRequest(target.api, {
      id: 21,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "deliver", to: "human:sketch-login", label: "signs in" }],
      },
    }) as { counts: { added: number } };
    expect(connected.counts.added).toBeGreaterThan(0);

    const arrow = target.elements().find(
      (element) => (element.endBinding as { elementId?: string } | undefined)?.elementId === "sketch-login",
    );
    expect(arrow).toBeDefined();
    expect(arrow?.customData?.wiley?.role).toBe("edge");

    const survivor = target.elements().find((element) => element.id === "sketch-login")!;
    expect(survivor.x).toBe(sketch.x);
    expect(survivor.y).toBe(sketch.y);
    expect(survivor.width).toBe(sketch.width);
    expect(survivor.customData).toBeUndefined();
    expect(survivor.boundElements).toEqual([{ id: arrow!.id, type: "arrow" }]);
  });

  it("rebuilds the connection on the next merge instead of doubling it", async () => {
    const { target, drawn } = await boardWithSketch();
    const params = {
      diagram: drawn.diagramId,
      mode: "merge",
      edges: [{ from: "deliver", to: "human:sketch-login" }],
    };
    await handleCanvasRequest(target.api, { id: 22, op: "update-diagram", params });
    const after = await handleCanvasRequest(target.api, {
      id: 23,
      op: "update-diagram",
      params: { diagram: drawn.diagramId, mode: "merge" },
    }) as { counts: { added: number; removed: number } };

    expect(after.counts).toMatchObject({ added: 0, removed: 0 });
    const bridges = target.elements().filter(
      (element) => (element.endBinding as { elementId?: string } | undefined)?.elementId === "sketch-login",
    );
    expect(bridges).toHaveLength(1);
    const survivor = target.elements().find((element) => element.id === "sketch-login")!;
    expect((survivor.boundElements as unknown[]).length).toBe(1);
  });

  it("takes the record of a dropped connector off their element", async () => {
    const { target, drawn } = await boardWithSketch();
    await handleCanvasRequest(target.api, {
      id: 27,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "deliver", to: "human:sketch-login" }],
      },
    });
    expect((target.elements().find((element) => element.id === "sketch-login")!
      .boundElements as unknown[]).length).toBe(1);

    await handleCanvasRequest(target.api, {
      id: 28,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "replace",
        nodes: [{ id: "deliver", label: "Deliver" }],
        edges: [],
      },
    });
    const survivor = target.elements().find((element) => element.id === "sketch-login")!;
    expect(survivor.boundElements).toEqual([]);
  });

  it("keeps the person's element through a replace that drops every agent node", async () => {
    const { target, drawn } = await boardWithSketch();
    await handleCanvasRequest(target.api, {
      id: 24,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "replace",
        nodes: [{ id: "accept", label: "Accept" }],
        edges: [],
      },
    });
    expect(target.elements().some((element) => element.id === "sketch-login")).toBe(true);
    expect(target.elements().some((element) => element.id === "sketch-login-text")).toBe(true);
  });

  it("accepts a bare element id, which is what the scene listing shows", async () => {
    const { target, drawn } = await boardWithSketch();
    await handleCanvasRequest(target.api, {
      id: 26,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "deliver", to: "sketch-login" }],
      },
    });
    const arrow = target.elements().find(
      (element) => (element.endBinding as { elementId?: string } | undefined)?.elementId === "sketch-login",
    );
    expect(arrow).toBeDefined();
  });

  it("does not stack a second arrow when the same bare id is asked for twice", async () => {
    const { target, drawn } = await boardWithSketch();
    const params = {
      diagram: drawn.diagramId,
      mode: "merge",
      edges: [{ from: "deliver", to: "sketch-login" }],
    };
    await handleCanvasRequest(target.api, { id: 30, op: "update-diagram", params });
    const after = await handleCanvasRequest(target.api, {
      id: 31,
      op: "update-diagram",
      params,
    }) as { counts: { added: number } };

    expect(after.counts.added).toBe(0);
    const bridges = target.elements().filter(
      (element) => (element.endBinding as { elementId?: string } | undefined)?.elementId === "sketch-login",
    );
    expect(bridges).toHaveLength(1);
    expect((target.elements().find((element) => element.id === "sketch-login")!
      .boundElements as unknown[]).length).toBe(1);
  });

  it("checks an edge into the sketch as strictly as any other", async () => {
    const { target, drawn } = await boardWithSketch();
    await expect(handleCanvasRequest(target.api, {
      id: 32,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "typo", to: "human:sketch-login" }],
      },
    })).rejects.toThrow(/unknown node/);

    await expect(handleCanvasRequest(target.api, {
      id: 33,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "deliver", to: "human:sketch-login", style: "zigzag" }],
      },
    })).rejects.toThrow(/style/);
  });

  it("refuses an id with no element of the person's behind it", async () => {
    const { target, drawn } = await boardWithSketch();
    await expect(handleCanvasRequest(target.api, {
      id: 25,
      op: "update-diagram",
      params: {
        diagram: drawn.diagramId,
        mode: "merge",
        edges: [{ from: "deliver", to: "human:nothing" }],
      },
    })).rejects.toThrow(/human:nothing/);
  });
});

describe("keeping the agent's drawing clear of the person's", () => {
  async function flowPlan() {
    const plan = await planDiagramLayout(flow, { x: 0, y: 0 }, "wd-clear");
    return plan;
  }

  function boxOf(plan: Awaited<ReturnType<typeof flowPlan>>, key: string) {
    const id = plan.elementIdByNode.get(key)!;
    const skeleton = plan.skeletons.find((entry) => entry.id === id)!;
    return {
      x: skeleton.x as number,
      y: skeleton.y as number,
      width: skeleton.width as number,
      height: skeleton.height as number,
    };
  }

  it("does not fail a drawing merely for landing on the person's box", async () => {
    const plan = await flowPlan();
    const box = boxOf(plan, "queue");
    const obstacles = [{ id: "theirs", bounds: box, kind: "shape" as const }];
    const quality = assertDiagramQuality(plan, obstacles)!;
    expect(placementCollisions(quality).length).toBeGreaterThan(0);
    expect(diagramDefects(quality)).toEqual([]);
  });

  it("treats a route driven through the person's box as a placement to redo", async () => {
    const plan = await flowPlan();
    const accept = boxOf(plan, "accept");
    const queue = boxOf(plan, "queue");
    // Sits in the channel between two nodes, which the layout engine had no
    // way of knowing about: nothing about the diagram itself is wrong.
    const gap = {
      x: accept.x + accept.width + 10,
      y: accept.y,
      width: Math.max(20, queue.x - accept.x - accept.width - 20),
      height: accept.height,
    };
    const obstacles = [{ id: "theirs", bounds: gap, kind: "shape" as const }];
    const quality = assertDiagramQuality(plan, obstacles)!;
    expect(diagramDefects(quality)).toEqual([]);
    expect(placementCollisions(quality).some((finding) => finding.startsWith("wd-clear-e-"))).toBe(true);

    const { quality: retried } = assertQualityClearOfHuman(plan, obstacles, "right");
    expect(placementCollisions(retried!)).toEqual([]);
  });

  it("shifts once to get out of the way and reports the move", async () => {
    const plan = await flowPlan();
    const obstacles = [{ id: "theirs", bounds: boxOf(plan, "queue"), kind: "shape" as const }];
    const { quality, shifted } = assertQualityClearOfHuman(plan, obstacles, "right");
    expect(shifted?.dx).toBeGreaterThan(0);
    expect(shifted?.dy).toBe(0);
    expect(placementCollisions(quality!)).toEqual([]);
  });

  it("gives up after one shift rather than sliding forever", async () => {
    const plan = await flowPlan();
    const first = boxOf(plan, "queue");
    const here = planBounds(plan);
    // Clear of the diagram now, squarely in its way once it has slid past the
    // first obstacle. Text, so arriving on it is a placement problem rather
    // than a crossed route.
    const landing = {
      x: here.maxX + 20,
      y: here.minY,
      width: 200,
      height: here.maxY - here.minY,
    };
    expect(() => assertQualityClearOfHuman(plan, [
      { id: "theirs", bounds: first, kind: "shape" },
      { id: "their-note", bounds: landing, kind: "text" },
    ], "right")).toThrow(/sit on the user's own drawing/);
  });

  it("slides past a stray doodle in the lane instead of failing the draw", async () => {
    // One rectangle sitting where the diagram is about to land, in the middle
    // of a channel its routes want. The layout engine never saw it.
    const anchor: SceneRecord = { id: "anchor", type: "rectangle", x: 0, y: 0, width: 200, height: 120 };
    const stray: SceneRecord = { id: "stray", type: "rectangle", x: 620, y: 40, width: 80, height: 40 };
    const target = board([anchor, stray]);
    await drawFlow(target, { ...flow, anchor: "anchor", anchorDirection: "right" });

    const drawn = target.elements().filter((element) => element.customData?.wiley);
    expect(drawn.length).toBeGreaterThan(0);
    for (const element of drawn) {
      const hits = element.x < stray.x + stray.width && stray.x < element.x + element.width
        && element.y < stray.y + stray.height && stray.y < element.y + element.height;
      expect(hits).toBe(false);
    }
    expect(target.elements().find((element) => element.id === "stray"))
      .toMatchObject({ x: 620, y: 40 });
  });

  it("slides the other way when it was asked to sit on the other side", async () => {
    const anchor: SceneRecord = { id: "anchor", type: "rectangle", x: 0, y: 0, width: 200, height: 120 };
    const target = board([anchor]);
    await drawFlow(target, { ...flow, anchor: "anchor", anchorDirection: "left" });
    const drawn = target.elements().filter((element) => element.customData?.wiley);
    expect(Math.max(...drawn.map((element) => element.x + element.width))).toBeLessThanOrEqual(0);
  });

  it("places a new diagram beside a hand-drawn box without touching it", async () => {
    const sketch: SceneRecord = { id: "sketch", type: "rectangle", x: 0, y: 0, width: 300, height: 200 };
    const target = board([sketch]);
    await drawFlow(target, { ...flow, anchor: "sketch", anchorDirection: "right" });

    const survivor = target.elements().find((element) => element.id === "sketch")!;
    expect(survivor).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
    const drawn = target.elements().filter((element) => element.customData?.wiley);
    expect(drawn.length).toBeGreaterThan(0);
    for (const element of drawn) {
      const overlaps = element.x < 300 && 0 < element.x + element.width
        && element.y < 200 && 0 < element.y + element.height;
      expect(overlaps).toBe(false);
    }
  });
});
