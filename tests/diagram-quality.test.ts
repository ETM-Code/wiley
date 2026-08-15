import { describe, expect, it } from "vitest";

import {
  arrowGeometry,
  evaluateDiagramPlan,
  segmentsVisuallyMerge,
} from "../src/renderer/diagram-quality";
import {
  contrastTrapPlan,
  handBuiltPlan,
  rainbowPlan,
  strayColorPlan,
  strokeWidthSoupPlan,
  type PlanPart,
} from "./fixtures/diagram-gallery";

function node(id: string, x: number, y: number, width = 160, height = 80): PlanPart {
  return {
    role: "node",
    key: id,
    skeleton: { id, type: "rectangle", x, y, width, height, backgroundColor: "transparent" },
  };
}

function arrow(
  id: string,
  points: Array<[number, number]>,
  ends: { start?: string; end?: string; rounded?: boolean } = {},
): PlanPart {
  return {
    role: "edge",
    key: id,
    skeleton: {
      id,
      type: "arrow",
      x: 0,
      y: 0,
      points,
      ...(ends.start ? { start: { id: ends.start } } : {}),
      ...(ends.end ? { end: { id: ends.end } } : {}),
      ...(ends.rounded ? { roundness: { type: 2 } } : {}),
    },
  };
}

describe("segmentsVisuallyMerge", () => {
  const horizontal = { x1: 0, y1: 0, x2: 100, y2: 0 };

  it("merges near-collinear runs that share enough length", () => {
    expect(segmentsVisuallyMerge(horizontal, { x1: 20, y1: 1, x2: 90, y2: 1 })).toBe(true);
    // Antiparallel counts: direction does not change what the eye sees.
    expect(segmentsVisuallyMerge(horizontal, { x1: 90, y1: 1, x2: 20, y2: 1 })).toBe(true);
  });

  it("works at arbitrary angles, not just on the axes", () => {
    const diagonal = { x1: 0, y1: 0, x2: 100, y2: 100 };
    expect(segmentsVisuallyMerge(diagonal, { x1: 20, y1: 22, x2: 80, y2: 82 })).toBe(true);
    expect(segmentsVisuallyMerge(diagonal, { x1: 20, y1: 40, x2: 80, y2: 100 })).toBe(false);
  });

  it("ignores runs that are far apart, crossing, or barely overlapping", () => {
    expect(segmentsVisuallyMerge(horizontal, { x1: 20, y1: 6, x2: 90, y2: 6 })).toBe(false);
    expect(segmentsVisuallyMerge(horizontal, { x1: 50, y1: -40, x2: 50, y2: 40 })).toBe(false);
    // 15 degrees apart is a crossing, not a doubled line.
    expect(segmentsVisuallyMerge(horizontal, { x1: 0, y1: 0, x2: 96.6, y2: 25.9 })).toBe(false);
    expect(segmentsVisuallyMerge(horizontal, { x1: 95, y1: 0, x2: 160, y2: 0 })).toBe(false);
  });
});

describe("arrowGeometry", () => {
  it("leaves a straight arrow as plain segments", () => {
    const geometry = arrowGeometry({ x: 0, y: 0, points: [[0, 0], [100, 0], [100, 100]] });
    expect(geometry.corners).toEqual([]);
    expect(geometry.segments).toHaveLength(2);
  });

  it("replaces each interior corner of a rounded arrow with its hull triangle", () => {
    const geometry = arrowGeometry({
      x: 0,
      y: 0,
      roundness: { type: 2 },
      points: [[0, 0], [100, 0], [100, 100]],
    });
    expect(geometry.corners).toEqual([[{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]]);
    expect(geometry.segments).toEqual([
      { x1: 0, y1: 0, x2: 50, y2: 0 },
      { x1: 100, y1: 50, x2: 100, y2: 100 },
    ]);
  });

  it("catches a node in the pocket a rounded corner sweeps through", () => {
    const pocket = node("pocket", 83, 3, 10, 10);
    const parts = (rounded: boolean) => [
      node("from", -200, -40),
      node("to", 60, 200),
      pocket,
      arrow("wire", [[0, 0], [100, 0], [100, 100]], { start: "from", end: "to", rounded }),
    ];
    // The polyline's legs run along y=0 and x=100 and miss the box entirely.
    expect(evaluateDiagramPlan(handBuiltPlan(parts(false))).edgesThroughNodes).toEqual([]);
    expect(evaluateDiagramPlan(handBuiltPlan(parts(true))).edgesThroughNodes).toEqual(["wire x pocket"]);
  });
});

describe("crowdedPorts", () => {
  it("flags two endpoints that land on the same node within a port's width", () => {
    const plan = handBuiltPlan([
      node("hub", 0, 0),
      node("a", 400, -200),
      node("b", 400, 200),
      arrow("e1", [[160, 40], [400, -160]], { start: "hub", end: "a" }),
      arrow("e2", [[160, 48], [400, 240]], { start: "hub", end: "b" }),
    ]);
    expect(plan.roles.size).toBe(5);
    const report = evaluateDiagramPlan(plan);
    expect(report.sharedPorts).toEqual([]);
    expect(report.crowdedPorts).toEqual(["hub @ 8.0px (e1, e2)"]);
  });

  it("leaves properly spaced ports alone and still catches exact duplicates", () => {
    const spaced = handBuiltPlan([
      node("hub", 0, 0),
      node("a", 400, -200),
      node("b", 400, 200),
      arrow("e1", [[160, 20], [400, -160]], { start: "hub", end: "a" }),
      arrow("e2", [[160, 60], [400, 240]], { start: "hub", end: "b" }),
    ]);
    expect(evaluateDiagramPlan(spaced).crowdedPorts).toEqual([]);
    const duplicate = handBuiltPlan([
      node("hub", 0, 0),
      node("a", 400, -200),
      node("b", 400, 200),
      arrow("e1", [[160, 40], [400, -160]], { start: "hub", end: "a" }),
      arrow("e2", [[160, 40], [400, 240]], { start: "hub", end: "b" }),
    ]);
    expect(evaluateDiagramPlan(duplicate).sharedPorts).toEqual(["hub @ 160,40 (e1, e2)"]);
    expect(evaluateDiagramPlan(duplicate).crowdedPorts).toEqual([]);
  });
});

describe("styleCoherence", () => {
  it("flags a colour that is neither theme-derived nor requested", () => {
    const report = evaluateDiagramPlan(strayColorPlan);
    expect(report.styleCoherence).toEqual([
      "wd-dirty-n-a.backgroundColor=#bada55 is neither theme-derived nor requested",
    ]);
  });

  it("flags a label that cannot be read on its own fill", () => {
    const report = evaluateDiagramPlan(contrastTrapPlan);
    expect(report.styleCoherence).toHaveLength(1);
    expect(report.styleCoherence[0]).toContain("wd-dirty-n-trap");
    expect(report.styleCoherence[0]).toMatch(/contrasts 1\.\d+:1/);
  });

  it("flags a palette too wide for the number of nodes", () => {
    expect(evaluateDiagramPlan(rainbowPlan).styleCoherence).toEqual([
      "5 distinct fills across 6 nodes exceeds 2",
    ]);
  });

  it("flags more than two node stroke weights", () => {
    expect(evaluateDiagramPlan(strokeWidthSoupPlan).styleCoherence).toEqual([
      "3 distinct node stroke widths exceeds 2",
    ]);
  });
});
