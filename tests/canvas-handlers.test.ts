import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { EVENTUALLY: "EVENTUALLY", IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (skeletons: Array<Record<string, any>>) => {
    const convertedIds = new Map(skeletons.map((item, index) => [item.id, `converted-${index}`]));
    return skeletons.flatMap((item, index) => {
    const points = item.points as Array<[number, number]> | undefined;
    const x = item.x;
    const y = item.y;
    const width = item.width ?? Math.abs(points?.at(-1)?.[0] ?? 0);
    const height = item.height ?? Math.abs(points?.at(-1)?.[1] ?? 0);
    const element = {
      ...item,
      // Match the real converter, which creates fresh Excalidraw ids rather
      // than preserving the supplied skeleton ids.
      id: `converted-${index}`,
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
    expect(result.idMap.human).toBe("converted-0");
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
});
