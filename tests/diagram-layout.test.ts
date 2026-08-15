import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MODEL_GRID_SIZE,
  evaluateDiagramPlan,
  measureText,
  nodeDimensions,
  planDiagramLayout,
  wrapLabel,
} from "../src/renderer/diagram-layout";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";
import { planningDiagram, stressGraphs } from "./fixtures/diagram-gallery";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 200, y: 200 };

describe("diagram layout quality", () => {
  it.each(stressGraphs)("lays out $name without overlaps, shared ports, or collisions", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, "agent-test");
    const report = evaluateDiagramPlan(plan);
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.sharedPorts).toEqual([]);
    expect(report.overlappingParallelSegments).toEqual([]);
    expect(report.offGrid).toEqual([]);
  });

  it.each(stressGraphs)("produces complete, finite geometry for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, "agent-test");
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

  it("fits every wrapped label line inside its node's usable width", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    const nodesById = new Map(
      plan.skeletons
        .filter((skeleton) => String(skeleton.id).includes("-node-"))
        .map((skeleton) => [String(skeleton.id), skeleton]),
    );
    for (const [index, node] of planningDiagram.nodes.entries()) {
      const skeleton = nodesById.get(`agent-test-node-${index}`);
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
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    const title = plan.skeletons.find((skeleton) => String(skeleton.id).endsWith("-title"))!;
    expect(title).toBeTruthy();
    expect(title.textAlign).toBe("left");
    const nodeTops = plan.skeletons
      .filter((skeleton) => String(skeleton.id).includes("-node-"))
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

  it("snaps node geometry to the hidden model grid", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, "agent-test");
    for (const skeleton of plan.skeletons) {
      if (skeleton.type === "text" || skeleton.type === "arrow") continue;
      expect((skeleton.x as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.y as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.width as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.height as number) % MODEL_GRID_SIZE).toBe(0);
    }
  });
});
