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

import { handleCanvasRequest } from "../src/renderer/canvas-handlers";

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
  });
});
