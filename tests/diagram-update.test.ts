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
import { planDiagramLayout } from "../src/renderer/diagram-layout";
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
