import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MODEL_GRID_SIZE,
  measureText,
  nodeDimensions,
  planDiagramLayout,
  wrapLabel,
  type LayoutParams,
} from "../src/renderer/diagram-layout";
import { evaluateDiagramPlan } from "../src/renderer/diagram-quality";
import { THEMES } from "../src/renderer/diagram-theme";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";
import { planningDiagram, stressGraphs } from "./fixtures/diagram-gallery";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 200, y: 200 };
const DIAGRAM_ID = "wd-test";

describe("diagram layout quality", () => {
  it.each(stressGraphs)("lays out $name without overlaps, shared ports, or collisions", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const report = evaluateDiagramPlan(plan);
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.sharedPorts).toEqual([]);
    expect(report.overlappingParallelSegments).toEqual([]);
    expect(report.offGrid).toEqual([]);
  });

  it.each(stressGraphs)("produces complete, finite geometry for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    expect(plan.nodeCount).toBe(params.nodes.length);
    expect(plan.edgeCount).toBe(params.edges.length);
    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows).toHaveLength(params.edges.length);
    for (const arrow of arrows) {
      expect(arrow.start).toBeTruthy();
      expect(arrow.end).toBeTruthy();
      expect((arrow.points as number[][]).length).toBeGreaterThanOrEqual(2);
    }
    for (const skeleton of plan.skeletons) {
      for (const key of ["x", "y", "width", "height"] as const) {
        if (key in skeleton) expect(Number.isFinite(skeleton[key])).toBe(true);
      }
    }
  });

  it.each(stressGraphs)("labels every emitted element with a semantic role for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    for (const skeleton of plan.skeletons) {
      expect(plan.roles.get(String(skeleton.id))).toBeTruthy();
    }
    const counts = { node: 0, edge: 0, edgeLabel: 0, title: 0 };
    for (const entry of plan.roles.values()) {
      if (entry.role in counts) counts[entry.role as keyof typeof counts] += 1;
    }
    expect(counts.node).toBe(params.nodes.length);
    expect(counts.edge).toBe(params.edges.length);
    expect(counts.edgeLabel).toBe(plan.edgeLabelCount);
    expect(counts.title).toBe(params.title ? 1 : 0);
  });

  it.each(stressGraphs)("stamps derived ids and diagram customData on every element of $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    expect(plan.diagramId).toBe(DIAGRAM_ID);
    const ids = plan.skeletons.map((skeleton) => String(skeleton.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const skeleton of plan.skeletons) {
      const role = plan.roles.get(String(skeleton.id))!;
      expect(String(skeleton.id).startsWith(`${DIAGRAM_ID}-`)).toBe(true);
      expect(skeleton.customData).toEqual({
        wiley: {
          diagram: DIAGRAM_ID,
          role: role.role,
          theme: plan.theme,
          ...(role.key ? { key: role.key } : {}),
        },
      });
    }
  });

  it("derives the same element ids for the same request", async () => {
    const first = await planDiagramLayout(planningDiagram, ORIGIN);
    const second = await planDiagramLayout(planningDiagram, ORIGIN, first.diagramId);
    expect(second.skeletons.map((skeleton) => skeleton.id))
      .toEqual(first.skeletons.map((skeleton) => skeleton.id));
  });

  it("fits every wrapped label line inside its node's usable width", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    const nodesById = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    for (const node of planningDiagram.nodes) {
      const skeleton = nodesById.get(plan.elementIdByNode.get(node.id)!);
      expect(skeleton).toBeTruthy();
      const factor = node.shape === "diamond" ? 2 : node.shape === "ellipse" ? Math.SQRT2 : 1;
      const usable = (skeleton!.width as number) / factor - 16;
      for (const line of wrapLabel(node.label)) {
        expect(measureText(line, 20).width).toBeLessThanOrEqual(usable);
      }
    }
  });

  it("grows a node's connector side with its edge degree on the axis edges attach to", () => {
    const quiet = nodeDimensions({ id: "a", label: "Hub" }, 1, "RIGHT");
    const busy = nodeDimensions({ id: "a", label: "Hub" }, 8, "RIGHT");
    expect(busy.height).toBeGreaterThan(quiet.height);
    expect(busy.height).toBeGreaterThanOrEqual(9 * 28);
    // DOWN layouts attach edges along the top and bottom, so width grows.
    const busyDown = nodeDimensions({ id: "a", label: "Hub" }, 8, "DOWN");
    expect(busyDown.width).toBeGreaterThanOrEqual(9 * 28);
    expect(busyDown.height).toBeLessThan(busy.height);
  });

  it("keeps the title clear of nodes, labels, and its own headroom band", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    const title = plan.skeletons.find(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "title",
    )!;
    expect(title).toBeTruthy();
    expect(title.textAlign).toBe("left");
    const nodeTops = plan.skeletons
      .filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node")
      .map((skeleton) => skeleton.y as number);
    // Full headroom band between the title and the top row of nodes.
    expect((title.y as number) + (title.height as number)).toBeLessThanOrEqual(Math.min(...nodeTops) - 40);
  });

  it("measures with the real Excalifont, not the fallback estimate", () => {
    const wide = measureText("WWWW", 20).width;
    const narrow = measureText("iiii", 20).width;
    // The fallback estimate is width-per-character; the real font is not.
    expect(wide).not.toBeCloseTo(narrow, 5);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("styles nodes, edges, and the title from the requested theme", async () => {
    const plan = await planDiagramLayout({
      title: "Pipeline",
      theme: "ocean",
      nodes: [
        { id: "a", label: "Ingest", role: "primary" },
        { id: "b", label: "Archive", role: "muted", emphasis: "quiet" },
        { id: "c", label: "Alert", role: "danger", emphasis: "strong" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c", label: "on failure", style: "dashed", weight: "strong", color: "danger", arrow: "both" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const theme = THEMES.ocean;
    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const node = (id: string) => byId.get(plan.elementIdByNode.get(id)!)!;

    expect(node("a")).toMatchObject({
      backgroundColor: theme.entries.primary.fill,
      strokeColor: theme.entries.primary.stroke,
      strokeWidth: 1,
      opacity: 100,
      fillStyle: "solid",
      label: { text: "Ingest", strokeColor: "#1e1e1e" },
    });
    expect(node("b")).toMatchObject({ backgroundColor: theme.entries.muted.soft, opacity: 70 });
    expect(node("c")).toMatchObject({ backgroundColor: theme.entries.danger.fill, strokeWidth: 2 });

    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows[0]).toMatchObject({
      strokeColor: theme.edgeColor,
      strokeStyle: "solid",
      startArrowhead: null,
      endArrowhead: "arrow",
    });
    expect(arrows[1]).toMatchObject({
      strokeColor: theme.entries.danger.stroke,
      strokeStyle: "dashed",
      strokeWidth: 2,
      startArrowhead: "arrow",
      endArrowhead: "arrow",
    });
    const title = plan.skeletons.find((skeleton) => plan.roles.get(String(skeleton.id))?.role === "title")!;
    expect(title.strokeColor).toBe(theme.titleColor);
    expect(plan.theme).toBe("ocean");
    expect([...plan.explicitColors]).toEqual([]);
  });

  it("keeps explicit colours and records them as deliberate", async () => {
    const plan = await planDiagramLayout({
      theme: "forest",
      nodes: [
        { id: "a", label: "Custom", role: "primary", backgroundColor: "#123456", strokeColor: "#654321" },
        { id: "b", label: "Themed", role: "primary" },
      ],
      edges: [{ from: "a", to: "b", color: "#abcdef" }],
    }, ORIGIN, DIAGRAM_ID);
    const node = plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get("a"))!;
    expect(node).toMatchObject({ backgroundColor: "#123456", strokeColor: "#654321" });
    // Dark override flips the bound label to paper so it stays readable.
    expect(node.label).toEqual({ text: "Custom", strokeColor: "#ffffff" });
    expect([...plan.explicitColors].sort()).toEqual(["#123456", "#654321", "#abcdef"]);
  });

  it("rejects role, emphasis, and edge styling values outside the vocabulary", async () => {
    const base = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] } as LayoutParams;
    await expect(planDiagramLayout(
      { ...base, nodes: [{ id: "a", label: "A", role: "chartreuse" as never }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/role/);
    await expect(planDiagramLayout(
      { ...base, edges: [{ from: "a", to: "b", weight: "heavy" as never }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/weight/);
    await expect(planDiagramLayout(
      { ...base, edges: [{ from: "a", to: "b", color: "puce" }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/colour/);
  });

  it("emits a text node as a standalone text element with no box or bound label", async () => {
    const plan = await planDiagramLayout({
      theme: "grape",
      nodes: [
        { id: "note", label: "A standing caption that has to wrap across more than one line", shape: "text", role: "accent" },
        { id: "box", label: "Worker" },
      ],
      edges: [{ from: "note", to: "box" }],
    }, ORIGIN, DIAGRAM_ID);
    const note = plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get("note"))!;
    expect(note.type).toBe("text");
    expect(note.label).toBeUndefined();
    expect(note.backgroundColor).toBe("transparent");
    expect(note.strokeColor).toBe(THEMES.grape.entries.accent.stroke);
    expect(String(note.text).split("\n").length).toBeGreaterThan(1);
    // The measured block is the layout box, so the caption never overlaps.
    const lines = String(note.text).split("\n");
    const widest = Math.max(...lines.map((line) => measureText(line, 20).width));
    expect(note.width).toBe(Math.ceil(widest));
    expect(note.height).toBe(Math.ceil(lines.length * 20 * 1.3));
  });

  it("gives emoji a square tile advance in both measurement fallbacks", () => {
    const rocket = measureText("🚀", 20).width;
    // The fontkit measurer has no Excalifont glyph for an emoji and must not
    // fall back to the notdef advance of the first subset.
    expect(rocket).toBeCloseTo(24, 6);
    expect(measureText("🚀🚀", 20).width).toBeCloseTo(48, 6);

    uninstallExcalifontMeasurer();
    try {
      // The naive estimate has to agree; a canvas-less environment otherwise
      // sizes an emoji like an average letter.
      expect(measureText("🚀", 20).width).toBeCloseTo(24, 6);
      expect(measureText("aa", 20).width).toBeCloseTo(24.8, 6);
    } finally {
      installExcalifontMeasurer();
    }
  });

  it("sizes an emoji label wider than the same label without it", () => {
    expect(measureText("🚀 Ship", 20).width).toBeGreaterThan(measureText("Ship", 20).width + 20);
  });

  it("snaps node geometry to the hidden model grid", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    for (const skeleton of plan.skeletons) {
      if (skeleton.type === "text" || skeleton.type === "arrow") continue;
      expect((skeleton.x as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.y as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.width as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.height as number) % MODEL_GRID_SIZE).toBe(0);
    }
  });
});
