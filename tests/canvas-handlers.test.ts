import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { EVENTUALLY: "EVENTUALLY", IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (skeletons: Array<Record<string, any>>, opts?: { regenerateIds?: boolean }) => {
    // The real converter regenerates skeleton ids unless told otherwise.
    const keepIds = opts?.regenerateIds === false;
    const idOf = (item: Record<string, any>, index: number) => (keepIds ? String(item.id) : `converted-${index}`);
    const convertedIds = new Map(skeletons.map((item, index) => [item.id, idOf(item, index)]));
    return skeletons.flatMap((item, index) => {
    const points = item.points as Array<[number, number]> | undefined;
    const x = item.x;
    const y = item.y;
    const width = item.width ?? Math.abs(points?.at(-1)?.[0] ?? 0);
    const height = item.height ?? Math.abs(points?.at(-1)?.[1] ?? 0);
    const element = {
      ...item,
      id: idOf(item, index),
      x,
      y,
      width,
      height,
      version: 1,
      ...(item.start?.id ? { startBinding: { elementId: convertedIds.get(item.start.id) } } : {}),
      ...(item.end?.id ? { endBinding: { elementId: convertedIds.get(item.end.id) } } : {}),
    };
    if (!item.label?.text) return [element];
    return [element, {
      id: `${element.id}-label`,
      type: "text",
      x: x + width / 2,
      y: y + height / 2,
      width: Math.max(1, String(item.label.text).length * 8),
      height: 24,
      text: item.label.text,
      containerId: element.id,
      version: 1,
    }];
    });
  },
  exportToBlob: vi.fn(),
  viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX, y: clientY }),
}));

vi.mock("../src/renderer/bridge", () => ({
  bridge: {
    onCanvasRequest: vi.fn(() => () => undefined),
    respondCanvasRequest: vi.fn(),
  },
}));

import {
  handleCanvasRequest,
  isDiagramPreviewActive,
  MODEL_GRID_SIZE,
  withoutDiagramPreviewElements,
} from "../src/renderer/canvas-handlers";
import { nodeElementId } from "../src/renderer/diagram-spec";
import { QUALITY_EVALUATION_LIMIT, assertDiagramQuality } from "../src/renderer/canvas/diagram-render";
import { handBuiltPlan } from "./fixtures/diagram-gallery";

/** The loose element shape these fakes pass around, spelled out. */
type SceneRecord = Record<string, unknown> & {
  id: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  children?: string[];
  groupIds?: string[];
  containerId?: string;
  customData?: { wiley?: { key?: string; role?: string } };
};

function expectOnModelGrid(value: unknown) {
  expect(typeof value).toBe("number");
  expect((value as number) % MODEL_GRID_SIZE).toBe(0);
}

describe("diagram renderer", () => {
  it("creates finite node, connector, and label geometry", async () => {
    let elements: Array<Record<string, unknown>> = [];
    const updateSizes: number[] = [];
    const captureActions: unknown[] = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({
        scrollX: 0,
        scrollY: 0,
        width: 1_000,
        height: 700,
        viewBackgroundColor: "#ffffff",
      }),
      getFiles: () => ({}),
      updateScene: ({ elements: next, captureUpdate }: { elements: Array<Record<string, unknown>>; captureUpdate: unknown }) => {
        elements = [...next];
        updateSizes.push(next.length);
        captureActions.push(captureUpdate);
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 1,
      op: "layout-diagram",
      params: {
        nodes: [
          { id: "human", label: "Human" },
          { id: "voice", label: "Voice" },
          { id: "root", label: "Orchestrator" },
        ],
        edges: [
          { from: "human", to: "voice", label: "speech" },
          { from: "voice", to: "root", label: "job" },
        ],
      },
    }) as {
      diagramId: string;
      idMap: Record<string, string>;
      __boardSnapshot: { elements: Array<Record<string, unknown>> };
    };

    expect(result.__boardSnapshot.elements.length).toBeGreaterThan(3);
    for (const element of result.__boardSnapshot.elements) {
      expect(Number.isFinite(element.x)).toBe(true);
      expect(Number.isFinite(element.y)).toBe(true);
      expect(Number.isFinite(element.width)).toBe(true);
      expect(Number.isFinite(element.height)).toBe(true);
    }
    expect(api.scrollToContent).toHaveBeenCalledOnce();
    expect(updateSizes.length).toBeGreaterThan(3);
    expect(updateSizes[0]).toBeLessThan(updateSizes.at(-1)!);
    expect(captureActions.slice(0, -1).every((action) => action === "EVENTUALLY")).toBe(true);
    expect(captureActions.at(-1)).toBe("IMMEDIATELY");
    // Ids survive conversion, so the reported id is the id on the board.
    expect(result.diagramId).toMatch(/^wd-/);
    expect(result.idMap.human.startsWith(`${result.diagramId}-n-`)).toBe(true);
    const sceneIds = new Set(result.__boardSnapshot.elements.map((element) => element.id));
    for (const id of Object.values(result.idMap)) expect(sceneIds.has(id)).toBe(true);
    for (const element of result.__boardSnapshot.elements) {
      const stamp = (element.customData as { wiley?: { diagram?: string } } | undefined)?.wiley;
      // Bound labels are made by the converter and carry no stamp of their own.
      if (stamp) expect(stamp.diagram).toBe(result.diagramId);
    }
    const arrows = result.__boardSnapshot.elements.filter((element) => element.type === "arrow");
    expect(arrows).toHaveLength(2);
    expect(arrows.every((arrow) => arrow.startBinding && arrow.endBinding)).toBe(true);
    // Shapes live on the hidden grid; connector routes keep ELK's exact
    // channel geometry so parallel runs can never snap onto each other.
    const primaryGeometry = result.__boardSnapshot.elements.filter(
      (element) => element.type !== "text" && element.type !== "arrow",
    );
    for (const element of primaryGeometry) {
      expectOnModelGrid(element.x);
      expectOnModelGrid(element.y);
      expectOnModelGrid(element.width);
      expectOnModelGrid(element.height);
    }
  });

  it("renders and validates title, shapes, colors, rounding, and layout in one call", async () => {
    let elements: Array<Record<string, any>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({
        scrollX: 0,
        scrollY: 0,
        width: 1_000,
        height: 700,
        viewBackgroundColor: "#ffffff",
      }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 2,
      op: "layout-diagram",
      params: {
        title: "Validated flow",
        nodes: [
          { id: "start", label: "Start", shape: "rectangle", backgroundColor: "#dbeafe", rounded: true },
          { id: "decision", label: "Ready?", shape: "diamond", strokeColor: "#7c3aed" },
          { id: "finish", label: "Finish", shape: "ellipse" },
        ],
        edges: [
          { from: "start", to: "decision" },
          { from: "decision", to: "finish", label: "Yes" },
        ],
        layout: { direction: "DOWN", nodeSpacing: 80, layerSpacing: 140 },
      },
    }) as {
      idMap: Record<string, string>;
      validation: { title: boolean; nodes: number; edges: number; shapes: Record<string, string> };
      __boardSnapshot: { elements: Array<Record<string, any>> };
    };

    const byId = new Map(result.__boardSnapshot.elements.map((element) => [element.id, element]));
    const start = byId.get(result.idMap.start)!;
    const decision = byId.get(result.idMap.decision)!;
    const finish = byId.get(result.idMap.finish)!;
    expect(result.__boardSnapshot.elements.some((element) => element.type === "text" && element.text === "Validated flow")).toBe(true);
    expect(start).toMatchObject({ type: "rectangle", backgroundColor: "#dbeafe", fillStyle: "solid", roundness: { type: 3 } });
    expect(decision).toMatchObject({ type: "diamond", strokeColor: "#7c3aed" });
    expect(finish.type).toBe("ellipse");
    expect(start.y).toBeLessThan(decision.y);
    expect(decision.y).toBeLessThan(finish.y);
    expect(result.validation).toEqual({
      title: true,
      nodes: 3,
      edges: 2,
      edgeLabels: 1,
      shapes: { start: "rectangle", decision: "diamond", finish: "ellipse" },
      grid: { gridSize: 20, snapped: true },
    });
  });

  it("snaps only model mutations while preserving existing freeform geometry", async () => {
    let elements: Array<Record<string, any>> = [{
      id: "human-freeform",
      type: "rectangle",
      x: 13,
      y: 27,
      width: 111,
      height: 53,
      version: 1,
    }];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_001, height: 701 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 20,
      op: "add-shape",
      params: { shape: "rectangle", width: 213, height: 77 },
    });
    expect(elements.find((element) => element.id === "human-freeform")).toMatchObject({
      x: 13,
      y: 27,
      width: 111,
      height: 53,
    });
    const generatedShape = elements.find((element) => element.id !== "human-freeform" && element.type === "rectangle")!;
    for (const key of ["x", "y", "width", "height"] as const) expectOnModelGrid(generatedShape[key]);

    await handleCanvasRequest(api, {
      id: 21,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [{ id: "raw", type: "diamond", x: 33, y: 47, width: 151, height: 69 }],
      },
    });
    const generatedDiamond = elements.find((element) => element.type === "diamond")!;
    for (const key of ["x", "y", "width", "height"] as const) expectOnModelGrid(generatedDiamond[key]);

    await handleCanvasRequest(api, {
      id: 22,
      op: "apply-patch",
      params: {
        updates: [{ id: "human-freeform", props: { x: 37, y: 49, width: 119, height: 61 } }],
      },
    });
    const modelMovedHumanShape = elements.find((element) => element.id === "human-freeform")!;
    for (const key of ["x", "y", "width", "height"] as const) expectOnModelGrid(modelMovedHumanShape[key]);
  });

  it("nudges hand-placed standalone text clear of existing elements", async () => {
    let elements: Array<Record<string, any>> = [
      { id: "box", type: "rectangle", x: 100, y: 200, width: 300, height: 100, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    // Heading aimed straight at the existing box, like the misplaced
    // "Task and Verification Loop" title.
    await handleCanvasRequest(api, {
      id: 36,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [{ type: "text", text: "Section heading", x: 120, y: 220, width: 260, height: 40 }],
      },
    });
    const heading = elements.find((element) => element.type === "text")!;
    // Pushed above the box instead of rendering on top of it.
    expect((heading.y as number) + (heading.height as number)).toBeLessThanOrEqual(200);
  });

  it("binds a label the model addressed by container id to the shape it names", async () => {
    let elements: Array<Record<string, unknown>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    // The converter regenerates ids, so a separate text naming the box in
    // containerId would arrive pointing at a skeleton id nothing on the board
    // has, leaving the caption unbound and outside its box.
    await handleCanvasRequest(api, {
      id: 60,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [
          { id: "payments-box-01", type: "rectangle", x: 380, y: 300, width: 180, height: 80 },
          { type: "text", text: "payments", containerId: "payments-box-01", x: 375, y: 308 },
        ],
      },
    });

    const box = elements.find((element) => element.type === "rectangle")!;
    const label = elements.find((element) => element.type === "text")!;
    expect(label.text).toBe("payments");
    expect(label.containerId).toBe(box.id);
    expect(elements.filter((element) => element.type === "text")).toHaveLength(1);
    // Bound, so the editor centres it rather than leaving it where it was aimed.
    expect(label.x).toBeGreaterThanOrEqual(box.x as number);
  });

  it("keeps a caption standing alone when its container is not in the batch", async () => {
    let elements: Array<Record<string, unknown>> = [
      { id: "already-there", type: "rectangle", x: 0, y: 0, width: 200, height: 80, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 61,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [
          { type: "text", text: "note", containerId: "already-there", x: 400, y: 400 },
          { type: "text", text: "ghost", containerId: "no-such-element", x: 600, y: 400 },
        ],
      },
    });

    // Binding onto an element already on the board is edit_canvas's job; a
    // dangling containerId would be worse than a caption of its own.
    for (const text of ["note", "ghost"]) {
      const caption = elements.find((element) => element.text === text)!;
      expect(caption.containerId).toBeUndefined();
    }
  });

  it("keeps a drawn shape off the elements already on the board", async () => {
    // The live failure: the agent dropped a "payments svc" box straight on top
    // of the person's "notifs" box, which the human-element rules forbid.
    let elements: Array<Record<string, unknown>> = [
      { id: "notifs", type: "rectangle", x: 640, y: 290, width: 175, height: 80, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 63,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [{ type: "rectangle", x: 620, y: 318, width: 200, height: 80, label: { text: "payments svc" } }],
      },
    });

    const notifs = elements.find((element) => element.id === "notifs")!;
    const drawn = elements.find((element) => element.type === "rectangle" && element.id !== "notifs")!;
    const overlaps = (drawn.x as number) < (notifs.x as number) + (notifs.width as number)
      && (notifs.x as number) < (drawn.x as number) + (drawn.width as number)
      && (drawn.y as number) < (notifs.y as number) + (notifs.height as number)
      && (notifs.y as number) < (drawn.y as number) + (drawn.height as number);
    expect(overlaps).toBe(false);
    // The person's box never moves to make room for the agent's.
    expect(notifs.x).toBe(640);
    expect(notifs.y).toBe(290);
  });

  it("keeps a batch's own arrangement while clearing existing content", async () => {
    let elements: Array<Record<string, unknown>> = [
      { id: "there", type: "rectangle", x: 0, y: 0, width: 400, height: 200, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 64,
      op: "add-elements",
      params: {
        scrollTo: false,
        elements: [
          { id: "a", type: "rectangle", x: 20, y: 20, width: 100, height: 60 },
          { id: "b", type: "rectangle", x: 220, y: 20, width: 100, height: 60 },
        ],
      },
    });

    const a = elements.find((element) => element.id !== "there" && element.type === "rectangle"
      && (element.width as number) === 100)!;
    const boxes = elements.filter((element) => element.id !== "there" && element.type === "rectangle");
    expect(boxes).toHaveLength(2);
    // Shifted as one piece: the 200px gap the batch was drawn with survives.
    const [left, right] = boxes.sort((one, two) => (one.x as number) - (two.x as number));
    expect((right.x as number) - (left.x as number)).toBe(200);
    expect(left.y).toBe(right.y);
    expect(a).toBeDefined();
  });

  it("routes a connection around a shape standing between the two ends", async () => {
    // The exact shape of a live failure: login and dashbrd sit either side of
    // auth svc, and the straight perimeter-to-perimeter line runs through it.
    let elements: Array<Record<string, unknown>> = [
      { id: "login", type: "rectangle", x: 100, y: 120, width: 190, height: 90, version: 1 },
      { id: "auth", type: "rectangle", x: 360, y: 95, width: 170, height: 100, version: 1 },
      { id: "dash", type: "rectangle", x: 620, y: 140, width: 200, height: 95, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 62,
      op: "connect-elements",
      params: { connections: [{ from: "login", to: "dash" }] },
    });

    const arrow = elements.find((element) => element.type === "arrow")!;
    const originX = arrow.x as number;
    const originY = arrow.y as number;
    const absolute = (arrow.points as Array<[number, number]>)
      .map(([dx, dy]) => ({ x: originX + dx, y: originY + dy }));

    const blocker = { x: 360, y: 95, width: 170, height: 100 };
    const crosses = absolute.slice(1).some((point, index) => {
      const previous = absolute[index];
      // Sample the segment densely rather than trusting its endpoints alone.
      for (let step = 0; step <= 40; step++) {
        const x = previous.x + (point.x - previous.x) * (step / 40);
        const y = previous.y + (point.y - previous.y) * (step / 40);
        if (x > blocker.x + 1 && x < blocker.x + blocker.width - 1
          && y > blocker.y + 1 && y < blocker.y + blocker.height - 1) return true;
      }
      return false;
    });
    expect(crosses).toBe(false);
  });

  it("connects existing human-drawn elements with bound arrows", async () => {
    let elements: Array<Record<string, any>> = [
      { id: "magic", type: "rectangle", x: 0, y: 400, width: 300, height: 90, version: 1 },
      { id: "voice", type: "ellipse", x: 700, y: 0, width: 240, height: 120, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 30,
      op: "connect-elements",
      params: {
        connections: [{ from: "magic", to: "voice", label: "delegates", bidirectional: true }],
      },
    }) as { count: number; ids: string[] };

    expect(result.count).toBe(1);
    const arrow = elements.find((element) => element.type === "arrow")!;
    expect(arrow.startBinding).toMatchObject({ elementId: "magic" });
    expect(arrow.endBinding).toMatchObject({ elementId: "voice" });
    expect(arrow.startArrowhead).toBe("arrow");
    expect(arrow.endArrowhead).toBe("arrow");
    const magic = elements.find((element) => element.id === "magic")!;
    const voiceShape = elements.find((element) => element.id === "voice")!;
    expect(magic.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
    expect(voiceShape.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
    // The route starts on magic's perimeter, aimed at voice, not at a corner
    // of the bounding box or a random column below.
    expect(arrow.x).toBeGreaterThanOrEqual(magic.x);
    expect(arrow.x).toBeLessThanOrEqual(magic.x + magic.width);
    expect(arrow.y).toBeGreaterThanOrEqual(voiceShape.y + voiceShape.height - 1);
    expect(elements.some((element) => element.type === "text" && element.text === "delegates")).toBe(true);
    await expect(handleCanvasRequest(api, {
      id: 31,
      op: "connect-elements",
      params: { connections: [{ from: "magic", to: "ghost" }] },
    })).rejects.toThrow(/unknown element id ghost/);
  });

  it("carries bound labels and arrow endpoints when a shape moves", async () => {
    let elements: Array<Record<string, any>> = [
      {
        id: "c1", type: "rectangle", x: 0, y: 0, width: 100, height: 60, version: 1,
        boundElements: [{ id: "t1", type: "text" }],
      },
      { id: "t1", type: "text", x: 25, y: 20, width: 50, height: 20, version: 1, containerId: "c1", text: "Box" },
      { id: "c2", type: "rectangle", x: 300, y: 0, width: 100, height: 60, version: 1 },
      {
        id: "a1", type: "arrow", x: 100, y: 30, width: 200, height: 0, version: 1,
        points: [[0, 0], [200, 0]],
        startBinding: { elementId: "c1" }, endBinding: { elementId: "c2" },
      },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 32,
      op: "apply-patch",
      params: { updates: [{ id: "c1", props: { x: 40, y: 20 } }] },
    }) as { updated: number; adjusted: number };

    expect(result.updated).toBe(1);
    expect(result.adjusted).toBe(2);
    expect(elements.find((element) => element.id === "c1")).toMatchObject({ x: 40, y: 20 });
    // Label re-centered in the moved container.
    expect(elements.find((element) => element.id === "t1")).toMatchObject({ x: 65, y: 40 });
    // The bound start endpoint followed the shape; the far end stayed put.
    const arrow = elements.find((element) => element.id === "a1")!;
    expect(arrow.x).toBe(140);
    expect(arrow.y).toBe(50);
    expect(arrow.points).toEqual([[0, 0], [160, -20]]);
  });

  it("routes text edits on a labelled shape to its bound label and re-measures", async () => {
    let elements: Array<Record<string, any>> = [
      {
        id: "c1", type: "rectangle", x: 0, y: 0, width: 200, height: 80, version: 1,
        boundElements: [{ id: "t1", type: "text" }],
      },
      { id: "t1", type: "text", x: 60, y: 30, width: 80, height: 20, version: 1, containerId: "c1", text: "Old", fontSize: 20 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 33,
      op: "apply-patch",
      params: { updates: [{ id: "c1", props: { text: "Renamed component" } }] },
    });

    const label = elements.find((element) => element.id === "t1")!;
    expect(label.text).toBe("Renamed component");
    expect(label.originalText).toBe("Renamed component");
    expect(label.width).toBeGreaterThan(80);
    const container = elements.find((element) => element.id === "c1")!;
    expect(container.text).toBeUndefined();
  });

  it("creates a bound label when text is patched onto an unlabelled human box, even with flat update shape", async () => {
    let elements: Array<Record<string, any>> = [
      { id: "wire1", type: "rectangle", x: 0, y: 500, width: 900, height: 70, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    // Flat {id, text} shape, exactly as models tend to emit it.
    const result = await handleCanvasRequest(api, {
      id: 35,
      op: "apply-patch",
      params: { updates: [{ id: "wire1", text: "Navbar · logo · links" }] },
    }) as { updated: number; createdLabels: number };

    expect(result.createdLabels).toBe(1);
    const label = elements.find((element) => element.type === "text")!;
    expect(label.text).toBe("Navbar · logo · links");
    expect(label.containerId).toBe("wire1");
    const box = elements.find((element) => element.id === "wire1")!;
    expect(box.boundElements).toContainEqual({ id: label.id, type: "text" });
    expect(box.text).toBeUndefined();
    // Label sits inside the box, not at the origin.
    expect(label.y).toBeGreaterThan(500);
    expect(label.y).toBeLessThan(570);
  });

  it("deleting a labelled shape removes its label and strips dangling bindings", async () => {
    let elements: Array<Record<string, any>> = [
      {
        id: "c1", type: "rectangle", x: 0, y: 0, width: 100, height: 60, version: 1,
        boundElements: [{ id: "t1", type: "text" }],
      },
      { id: "t1", type: "text", x: 25, y: 20, width: 50, height: 20, version: 1, containerId: "c1", text: "Box" },
      { id: "c2", type: "rectangle", x: 300, y: 0, width: 100, height: 60, version: 1 },
      {
        id: "a1", type: "arrow", x: 100, y: 30, width: 200, height: 0, version: 1,
        points: [[0, 0], [200, 0]],
        startBinding: { elementId: "c1" }, endBinding: { elementId: "c2" },
      },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 34,
      op: "apply-patch",
      params: { deletes: ["c1"] },
    }) as { deleted: number };

    expect(result.deleted).toBe(2);
    expect(elements.some((element) => element.id === "t1")).toBe(false);
    const arrow = elements.find((element) => element.id === "a1")!;
    expect(arrow.startBinding).toBeNull();
    expect(arrow.endBinding).toEqual({ elementId: "c2" });
  });

  it("skips step animation in a hidden canvas mirror", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      hasFocus: () => false,
      documentElement: { dataset: {} },
      dispatchEvent,
    });
    vi.stubGlobal("CustomEvent", class {
      constructor(public type: string, public init?: unknown) {}
    });

    try {
      let elements: Array<Record<string, unknown>> = [];
      const updates: unknown[] = [];
      const api = {
        getSceneElements: () => elements,
        getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
        getFiles: () => ({}),
        updateScene: ({ elements: next, captureUpdate }: { elements: Array<Record<string, unknown>>; captureUpdate: unknown }) => {
          elements = [...next];
          updates.push(captureUpdate);
        },
        scrollToContent: vi.fn(async () => undefined),
      } as unknown as ExcalidrawImperativeAPI;

      await handleCanvasRequest(api, {
        id: 3,
        op: "layout-diagram",
        params: {
          nodes: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
            { id: "three", label: "Three" },
          ],
          edges: [
            { from: "one", to: "two" },
            { from: "two", to: "three" },
          ],
        },
      });

      expect(updates).toEqual(["IMMEDIATELY"]);
      expect(api.scrollToContent).toHaveBeenCalledOnce();
      expect(dispatchEvent).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("replaces provisional JSON frames without persisting or duplicating them", async () => {
    const base = {
      id: "human-note",
      type: "rectangle",
      x: 20,
      y: 20,
      width: 100,
      height: 40,
      version: 1,
    };
    let elements: Array<Record<string, any>> = [base];
    const updateSizes: number[] = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
        updateSizes.push(elements.length);
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const first = await handleCanvasRequest(api, {
      id: -1,
      op: "preview-diagram",
      params: {
        __previewVersion: 101,
        nodes: [{ id: "one", label: "First block" }],
        edges: [],
      },
    }) as Record<string, unknown>;
    expect(first.preview).toBe(true);
    expect(first.__boardSnapshot).toBeUndefined();
    expect(isDiagramPreviewActive()).toBe(true);
    expect(withoutDiagramPreviewElements(elements)).toEqual([base]);

    await handleCanvasRequest(api, {
      id: -2,
      op: "preview-diagram",
      params: {
        __previewVersion: 102,
        nodes: [
          { id: "one", label: "First block" },
          { id: "two", label: "Second block" },
        ],
        edges: [{ from: "one", to: "two" }],
      },
    });
    expect(elements.filter((element) => element.type === "rectangle")).toHaveLength(3);
    expect(withoutDiagramPreviewElements(elements)).toEqual([base]);

    const stale = await handleCanvasRequest(api, {
      id: -3,
      op: "preview-diagram",
      params: {
        __previewVersion: 101,
        nodes: [{ id: "old", label: "Old block" }],
        edges: [],
      },
    });
    expect(stale).toEqual({ stale: true });

    const final = await handleCanvasRequest(api, {
      id: 4,
      op: "layout-diagram",
      params: {
        __previewVersion: 103,
        nodes: [
          { id: "one", label: "First block" },
          { id: "two", label: "Second block" },
        ],
        edges: [{ from: "one", to: "two" }],
      },
    }) as { __boardSnapshot: { elements: Array<Record<string, unknown>> } };
    expect(isDiagramPreviewActive()).toBe(false);
    expect(final.__boardSnapshot.elements.filter((element) => element.type === "rectangle")).toHaveLength(3);
    expect(updateSizes.at(-1)).toBe(final.__boardSnapshot.elements.length);
  });

  it("keeps one diagram identity across every preview frame and the final commit", async () => {
    let elements: Array<Record<string, any>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const first = await handleCanvasRequest(api, {
      id: -10,
      op: "preview-diagram",
      params: { __previewVersion: 201, nodes: [{ id: "one", label: "One" }], edges: [] },
    }) as { diagramId: string };
    const diagramId = first.diagramId;
    const firstNodeId = nodeElementId(diagramId, "one");
    expect(elements.some((element) => element.id === firstNodeId)).toBe(true);

    const second = await handleCanvasRequest(api, {
      id: -11,
      op: "preview-diagram",
      params: {
        __previewVersion: 202,
        nodes: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
        edges: [{ from: "one", to: "two" }],
      },
    }) as { diagramId: string };
    expect(second.diagramId).toBe(diagramId);
    expect(elements.filter((element) => element.id === firstNodeId)).toHaveLength(1);

    const final = await handleCanvasRequest(api, {
      id: 40,
      op: "layout-diagram",
      params: {
        __previewVersion: 203,
        nodes: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
        edges: [{ from: "one", to: "two" }],
      },
    }) as { diagramId: string; idMap: Record<string, string> };

    // The provisional elements became the committed ones rather than being
    // deleted and replaced by a second set under different ids.
    expect(final.diagramId).toBe(diagramId);
    expect(final.idMap.one).toBe(firstNodeId);
    expect(elements.filter((element) => element.id === firstNodeId)).toHaveLength(1);
    expect(isDiagramPreviewActive()).toBe(false);
  });

  it("applies a patch without letting it rewrite identity or scene bookkeeping", async () => {
    let elements: Array<Record<string, any>> = [{
      id: "wd-x-n-start",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      version: 1,
      index: "a1",
      frameId: null,
      customData: { wiley: { diagram: "wd-x", role: "node", key: "start" } },
    }];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 60,
      op: "apply-patch",
      params: {
        updates: [{
          id: "wd-x-n-start",
          props: {
            backgroundColor: "#dbeafe",
            customData: { wiley: { diagram: "someone-else", role: "node" } },
            frameId: "frame-9",
            index: "zz",
          },
        }],
      },
    }) as { updated: number };

    expect(result.updated).toBe(1);
    const patched = elements[0];
    // The requested property landed; the protected ones did not.
    expect(patched.backgroundColor).toBe("#dbeafe");
    expect(patched.customData).toEqual({ wiley: { diagram: "wd-x", role: "node", key: "start" } });
    expect(patched.frameId).toBeNull();
    expect(patched.index).toBe("a1");
  });

  it("attaches a quality report and the layout outcome to a committed diagram", async () => {
    let elements: Array<Record<string, unknown>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 60,
      op: "layout-diagram",
      params: {
        theme: "ocean",
        nodes: [
          { id: "a", label: "Collect", role: "primary" },
          { id: "b", label: "Verify", shape: "diamond", role: "neutral" },
          { id: "c", label: "Store", role: "neutral" },
        ],
        edges: [
          { from: "a", to: "b", label: "batch" },
          { from: "b", to: "c", label: "ok" },
        ],
      },
    }) as { quality: Record<string, string[]>; layout: Record<string, string> };

    expect(result.layout).toEqual({ requested: "layered", used: "layered" });
    expect(Object.keys(result.quality).sort()).toEqual([
      "containerContainment",
      "containerIntrusion",
      "crowdedPorts",
      "edgesThroughContainers",
      "edgesThroughNodes",
      "labelCollisions",
      "nodeOverlaps",
      "offGrid",
      "overlappingParallelSegments",
      "sharedPorts",
      "styleCoherence",
    ]);
    for (const findings of Object.values(result.quality)) expect(findings).toEqual([]);
  });

  it("commits regions behind their members and a frame in front of its children", async () => {
    let elements: SceneRecord[] = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700, viewBackgroundColor: "#fff" }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: SceneRecord[] }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const result = await handleCanvasRequest(api, {
      id: 70,
      op: "layout-diagram",
      params: {
        theme: "ocean",
        containers: [
          { id: "tier", label: "Edge tier", role: "primary" },
          { id: "board", label: "Sprint 14", render: "frame" },
        ],
        nodes: [
          { id: "cdn", label: "CDN", container: "tier" },
          { id: "waf", label: "WAF", container: "tier" },
          { id: "todo", label: "To do", container: "board" },
          { id: "doing", label: "Doing", container: "board" },
        ],
        edges: [{ from: "cdn", to: "waf" }, { from: "waf", to: "todo" }, { from: "todo", to: "doing" }],
      },
    }) as { diagramId: string; idMap: Record<string, string>; quality: Record<string, string[]> };

    for (const findings of Object.values(result.quality)) expect(findings).toEqual([]);
    const order = elements.map((element) => element.id);
    const region = elements.find((element) => element.customData?.wiley?.key === "tier"
      && element.customData?.wiley?.role === "container")!;
    const frame = elements.find((element) => element.type === "frame")!;

    // groupIds survive conversion untouched, and a member shares its region's.
    expect(region.groupIds).toHaveLength(1);
    expect(elements.find((element) => element.id === result.idMap.cdn)!.groupIds)
      .toEqual(region.groupIds);
    // The region is drawn before what it holds; the frame after.
    expect(order.indexOf(region.id)).toBeLessThan(order.indexOf(result.idMap.cdn));
    expect(order.indexOf(frame.id)).toBeGreaterThan(order.indexOf(result.idMap.doing));
    // Nothing but the frame's own members and their bound labels comes
    // between the first member and the frame that closes the array.
    expect(order.at(-1)).toBe(frame.id);
    const tail = elements.slice(order.indexOf(result.idMap.todo), -1);
    for (const element of tail) {
      const owner = element.containerId ?? element.id;
      expect([result.idMap.todo, result.idMap.doing]).toContain(owner);
    }
    expect(frame.name).toBe("Sprint 14");
    expect(frame.children).toEqual([result.idMap.todo, result.idMap.doing]);
  });

  it("keeps a frame off the falsy origin the converter would auto-fit away", async () => {
    let elements: SceneRecord[] = [];
    const api = {
      getSceneElements: () => elements,
      // No scroll and no existing content puts the diagram origin at (80, 80),
      // then the frame's own left padding lands its box on zero.
      getAppState: () => ({ scrollX: 40, scrollY: 40, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: SceneRecord[] }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    await handleCanvasRequest(api, {
      id: 71,
      op: "layout-diagram",
      params: {
        containers: [{ id: "f", label: "Frame", render: "frame" }],
        nodes: [{ id: "only", label: "Only", container: "f" }],
        edges: [],
      },
    });
    const frame = elements.find((element) => element.type === "frame")!;
    const member = elements.find((element) => element.customData?.wiley?.key === "only")!;
    expect(frame.x).not.toBe(0);
    expect(frame.y).not.toBe(0);
    // Growing rather than moving keeps the member inside the frame.
    expect(member.x).toBeGreaterThan(frame.x);
    expect(member.x + member.width).toBeLessThan(frame.x + frame.width);
  });

  it("fails the call on a plan whose boxes overlap or whose arrows cut through them", () => {
    const overlapping = handBuiltPlan([
      {
        role: "node",
        key: "a",
        skeleton: { id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
      },
      {
        role: "node",
        key: "b",
        skeleton: { id: "b", type: "rectangle", x: 40, y: 20, width: 160, height: 80 },
      },
    ]);
    expect(() => assertDiagramQuality(overlapping)).toThrow(/quality check failed/i);

    const pierced = handBuiltPlan([
      { role: "node", key: "a", skeleton: { id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80 } },
      { role: "node", key: "b", skeleton: { id: "b", type: "rectangle", x: 800, y: 0, width: 160, height: 80 } },
      { role: "node", key: "c", skeleton: { id: "c", type: "rectangle", x: 400, y: 0, width: 160, height: 80 } },
      {
        role: "edge",
        key: "a__b",
        skeleton: {
          id: "wire",
          type: "arrow",
          x: 160,
          y: 40,
          points: [[0, 0], [640, 0]],
          start: { id: "a" },
          end: { id: "b" },
        },
      },
    ]);
    expect(() => assertDiagramQuality(pierced)).toThrow(/wire x c/);
  });

  it("skips evaluation entirely above the element budget", () => {
    const huge = handBuiltPlan(Array.from({ length: QUALITY_EVALUATION_LIMIT + 1 }, (_, index) => ({
      role: "node" as const,
      key: `n${index}`,
      // Deliberately stacked: nothing is checked, so nothing is reported.
      skeleton: { id: `n${index}`, type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
    })));
    expect(assertDiagramQuality(huge)).toBeUndefined();
  });

  it("reports drawn diagrams in the scene summary", async () => {
    let elements: Array<Record<string, any>> = [
      { id: "human-box", type: "rectangle", x: 0, y: 0, width: 40, height: 40, version: 1 },
    ];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700, viewBackgroundColor: "#fff" }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const drawn = await handleCanvasRequest(api, {
      id: 50,
      op: "layout-diagram",
      params: {
        title: "Signup flow",
        nodes: [{ id: "start", label: "Start" }, { id: "done", label: "Done" }],
        edges: [{ from: "start", to: "done" }],
      },
    }) as { diagramId: string };

    const summary = await handleCanvasRequest(api, { id: 51, op: "get-scene-summary", params: {} }) as {
      elements: Array<{ id: string; diagram?: { id: string; key?: string; role: string } }>;
      diagrams: Array<{ id: string; title?: string; theme?: string; nodeKeys: string[]; elementCount: number; bounds: { w: number } }>;
    };

    expect(summary.diagrams).toHaveLength(1);
    expect(summary.diagrams[0]).toMatchObject({
      id: drawn.diagramId,
      title: "Signup flow",
      // A follow-up call can extend this diagram in the palette it already uses.
      theme: "slate",
      nodeKeys: ["start", "done"],
    });
    expect(summary.diagrams[0].bounds.w).toBeGreaterThan(0);
    expect(summary.elements.find((element) => element.id === "human-box")?.diagram).toBeUndefined();
    const node = summary.elements.find((element) => element.diagram?.key === "start")!;
    expect(node.diagram).toEqual({ id: drawn.diagramId, key: "start", role: "node" });

    const full = await handleCanvasRequest(api, { id: 52, op: "get-scene-full", params: {} }) as {
      elements: unknown[];
      diagrams: unknown[];
    };
    expect(full.elements.length).toBe(elements.length);
    expect(full.diagrams).toHaveLength(1);
  });

  it("refuses to draw when a derived id is already taken by something else", async () => {
    let elements: Array<Record<string, any>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, any>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const first = await handleCanvasRequest(api, {
      id: -20,
      op: "preview-diagram",
      params: { __previewVersion: 301, nodes: [{ id: "one", label: "One" }], edges: [] },
    }) as { diagramId: string };

    // Something outside this diagram already sits on the id the next frame
    // will claim; converting anyway would drop one of them silently.
    elements = [...elements, {
      id: nodeElementId(first.diagramId, "two"),
      type: "rectangle",
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      version: 1,
    }];

    await expect(handleCanvasRequest(api, {
      id: -21,
      op: "preview-diagram",
      params: {
        __previewVersion: 302,
        nodes: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
        edges: [{ from: "one", to: "two" }],
      },
    })).rejects.toThrow(/Diagram id collision/);

    await handleCanvasRequest(api, {
      id: -22,
      op: "clear-diagram-preview",
      params: { __previewVersion: 303 },
    });
    expect(isDiagramPreviewActive()).toBe(false);
  });

  it("never evaluates a streaming preview", async () => {
    let elements: Array<Record<string, unknown>> = [];
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700 }),
      getFiles: () => ({}),
      updateScene: ({ elements: next }: { elements: Array<Record<string, unknown>> }) => {
        elements = [...next];
      },
      scrollToContent: vi.fn(async () => undefined),
    } as unknown as ExcalidrawImperativeAPI;

    const preview = await handleCanvasRequest(api, {
      id: 61,
      op: "preview-diagram",
      params: {
        // Preview arbitration is module state shared with the tests above.
        __previewVersion: 9_001,
        nodes: [{ id: "a", label: "One" }, { id: "b", label: "Two" }],
        edges: [{ from: "a", to: "b" }],
      },
    }) as Record<string, unknown>;
    expect(preview.preview).toBe(true);
    expect(preview.quality).toBeUndefined();
    await handleCanvasRequest(api, { id: 62, op: "clear-diagram-preview", params: { __previewVersion: 9_002 } });
  });
});
