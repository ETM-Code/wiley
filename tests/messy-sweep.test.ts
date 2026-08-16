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
  bridge: { onCanvasRequest: vi.fn(() => () => undefined), respondCanvasRequest: vi.fn() },
}));

import { handleCanvasRequest } from "../src/renderer/canvas-handlers";
import { MODEL_GRID_SIZE } from "../src/renderer/diagram-layout";
import { isObstacleFinding } from "../src/renderer/diagram-quality";
import { inferHumanGraph, type SketchElement } from "../src/renderer/canvas/human-graph";
import { messyScenes, type MessyElement, type MessyScene } from "./fixtures/messy-scenes";

type Board = {
  api: ExcalidrawImperativeAPI;
  elements: () => MessyElement[];
};

function board(initial: readonly MessyElement[]): Board {
  let elements = [...initial];
  const api = {
    getSceneElements: () => elements,
    getAppState: () => ({ scrollX: 0, scrollY: 0, width: 1_000, height: 700, viewBackgroundColor: "#fff" }),
    getFiles: () => ({}),
    updateScene: ({ elements: next }: { elements: MessyElement[] }) => {
      elements = [...next];
    },
    scrollToContent: vi.fn(async () => undefined),
  } as unknown as ExcalidrawImperativeAPI;
  return { api, elements: () => elements };
}

type Quality = Record<string, string[]>;

function defects(quality: Quality | undefined): string[] {
  if (!quality) return [];
  return [
    ...quality.nodeOverlaps ?? [],
    ...quality.edgesThroughNodes ?? [],
    ...quality.containerContainment ?? [],
    ...quality.edgesThroughContainers ?? [],
  ];
}

const NEW_DIAGRAM = {
  title: "Proposal",
  theme: "forest" as const,
  nodes: [
    { id: "intake", label: "Intake" },
    { id: "triage", label: "Triage" },
    { id: "build", label: "Build" },
    { id: "ship", label: "Ship" },
  ],
  edges: [
    { from: "intake", to: "triage" },
    { from: "triage", to: "build" },
    { from: "build", to: "ship" },
  ],
};

const SHAPE_TYPES = new Set(["rectangle", "diamond", "ellipse"]);

function overlaps(a: MessyElement, b: MessyElement): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("reading messy sketches", () => {
  for (const scene of messyScenes()) {
    describe(scene.name, () => {
      it("reads the graph the person drew", () => {
        const graph = inferHumanGraph(scene.elements as unknown as SketchElement[]);
        expect({
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          loose: graph.edges.filter((edge) => !edge.fromElementId || !edge.toElementId).length,
          unattached: graph.unattached.length,
        }).toEqual({
          nodes: scene.expect.nodes,
          edges: scene.expect.edges,
          loose: scene.expect.loose,
          unattached: scene.expect.unattached,
        });
      });

      it("gets the attachments and captions it claims to", () => {
        const graph = inferHumanGraph(scene.elements as unknown as SketchElement[]);
        for (const [from, to] of scene.expect.attachments ?? []) {
          const found = graph.edges.some(
            (edge) => edge.fromElementId === from && edge.toElementId === to,
          );
          expect(found, `${from} -> ${to} was not read`).toBe(true);
        }
        for (const [elementId, label] of scene.expect.labels ?? []) {
          expect(graph.nodes.find((node) => node.elementId === elementId)?.label).toBe(label);
        }
      });
    });
  }
});

describe("tidying messy sketches", () => {
  async function tidyScene(scene: MessyScene, layout: "align" | "relayout") {
    const target = board(scene.elements);
    const result = await handleCanvasRequest(target.api, {
      id: 1,
      op: "tidy-diagram",
      params: { layout },
    }) as { moved: number; bound: number; edges: number; quality?: Quality };
    return { target, result };
  }

  for (const scene of messyScenes()) {
    for (const layout of ["align", "relayout"] as const) {
      it(`${scene.name} survives a ${layout} intact and clean`, async () => {
        const { target, result } = await tidyScene(scene, layout);
        const after = target.elements();

        // Nothing deleted, nothing invented, nothing claimed as the agent's.
        expect(after.map((element) => element.id).sort())
          .toEqual(scene.elements.map((element) => element.id).sort());
        expect(after.every((element) => element.customData === undefined)).toBe(true);
        for (const element of after) {
          const before = scene.elements.find((candidate) => candidate.id === element.id)!;
          expect(element.text).toBe(before.text);
          expect(element.strokeColor).toBe(before.strokeColor);
        }

        for (const element of after) {
          if (!SHAPE_TYPES.has(element.type)) continue;
          for (const value of [element.x, element.y, element.width, element.height]) {
            expect(value % MODEL_GRID_SIZE).toBe(0);
          }
        }

        const ids = new Set(after.map((element) => element.id));
        for (const arrow of after.filter((element) => element.type === "arrow")) {
          const start = arrow.startBinding?.elementId;
          const end = arrow.endBinding?.elementId;
          if (!start && !end) continue;
          expect(ids.has(start ?? "")).toBe(true);
          expect(ids.has(end ?? "")).toBe(true);
        }

        expect(defects(result.quality)).toEqual([]);
      });
    }
  }

  it("leaves an already-tidy sketch essentially where it was", async () => {
    const scene = messyScenes().find((candidate) => candidate.name === "already-tidy")!;
    const { target } = await tidyScene(scene, "align");
    for (const before of scene.elements.filter((element) => element.type === "rectangle")) {
      const after = target.elements().find((element) => element.id === before.id)!;
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(MODEL_GRID_SIZE);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(MODEL_GRID_SIZE);
    }
  });
});

describe("drawing beside a messy sketch", () => {
  for (const scene of messyScenes()) {
    it(`stays clear of ${scene.name}`, async () => {
      const target = board(scene.elements);
      const anchor = scene.elements.find((element) => SHAPE_TYPES.has(element.type))!;
      const result = await handleCanvasRequest(target.api, {
        id: 1,
        op: "layout-diagram",
        params: { ...NEW_DIAGRAM, anchor: anchor.id, anchorDirection: "below" },
      }) as { count: number; quality?: Quality };

      expect(result.count).toBeGreaterThan(0);
      const findings = Object.values(result.quality ?? {}).flat();
      expect(findings.filter(isObstacleFinding)).toEqual([]);

      const drawn = target.elements().filter((element) => element.customData !== undefined);
      expect(drawn.length).toBeGreaterThan(0);
      for (const theirs of scene.elements) {
        if (theirs.type === "arrow" || theirs.type === "freedraw") continue;
        for (const ours of drawn) {
          expect(overlaps(ours, theirs), `${ours.id} sits on ${theirs.id}`).toBe(false);
        }
      }
      // Their sketch is exactly as they left it.
      for (const theirs of scene.elements) {
        const after = target.elements().find((element) => element.id === theirs.id)!;
        expect({ x: after.x, y: after.y, width: after.width, height: after.height })
          .toEqual({ x: theirs.x, y: theirs.y, width: theirs.width, height: theirs.height });
      }
    });
  }
});
