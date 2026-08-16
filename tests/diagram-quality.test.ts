import { describe, expect, it } from "vitest";

import {
  arrowGeometry,
  evaluateConvertedScene,
  evaluateDiagramPlan,
  mergeQualityReports,
  isObstacleFinding,
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

function region(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  parent?: string,
): PlanPart {
  return {
    role: "container",
    key: id,
    ...(parent ? { parent } : {}),
    skeleton: { id, type: "rectangle", x, y, width, height, backgroundColor: "transparent" },
  };
}

function member(id: string, x: number, y: number, container: string, width = 160, height = 80): PlanPart {
  return { ...node(id, x, y, width, height), container };
}

describe("containers", () => {
  it("reports which side a member escapes through and by how much", () => {
    const plan = handBuiltPlan([
      region("box", 0, 0, 400, 300),
      member("inside", 40, 60, "box"),
      // Hangs 60px past the right border and 20px below it.
      member("escapee", 300, 240, "box"),
    ]);
    const report = evaluateDiagramPlan(plan);
    expect(report.containerContainment).toEqual(["box > escapee overflows right 72, bottom 32"]);
    expect(report.containerIntrusion).toEqual([]);
  });

  it("lets a nested region sit inside its parent and flags one that does not", () => {
    const nested = handBuiltPlan([
      region("outer", 0, 0, 600, 400),
      region("inner", 40, 40, 300, 200, "outer"),
      member("deep", 80, 100, "inner"),
    ]);
    const report = evaluateDiagramPlan(nested);
    expect(report.containerContainment).toEqual([]);
    expect(report.containerIntrusion).toEqual([]);
    expect(report.nodeOverlaps).toEqual([]);

    const straddling = handBuiltPlan([
      region("outer", 0, 0, 600, 400),
      region("inner", 500, 40, 300, 200, "outer"),
    ]);
    expect(evaluateDiagramPlan(straddling).containerContainment).toEqual([
      "outer > inner overflows right 212",
    ]);
  });

  it("flags a stranger standing on a region and two regions standing on each other", () => {
    const intruder = handBuiltPlan([
      region("box", 0, 0, 400, 300),
      member("mine", 40, 60, "box"),
      node("theirs", 300, 100),
    ]);
    expect(evaluateDiagramPlan(intruder).containerIntrusion).toEqual(["box x theirs"]);

    const collided = handBuiltPlan([
      region("left", 0, 0, 400, 300),
      region("right", 300, 0, 400, 300),
      member("a", 40, 60, "left"),
      member("b", 340, 60, "right"),
    ]);
    const report = evaluateDiagramPlan(collided);
    // Region on region is a node overlap; the stray member is the intrusion.
    expect(report.nodeOverlaps).toEqual(["left x right"]);
    expect(report.containerIntrusion).toEqual(["left x b"]);
  });

  it("lets an arrow leave a region it belongs to and catches one merely passing through", () => {
    const legal = handBuiltPlan([
      region("box", 0, 0, 400, 300),
      member("inner", 40, 60, "box"),
      node("outer", 700, 60),
      arrow("wire", [[200, 100], [700, 100]], { start: "inner", end: "outer" }),
    ]);
    expect(evaluateDiagramPlan(legal).edgesThroughContainers).toEqual([]);

    const trespass = handBuiltPlan([
      region("box", 200, 0, 400, 300),
      member("inner", 240, 60, "box"),
      node("west", 0, 400),
      node("east", 900, 400),
      // Straight through both vertical borders, belonging to neither end.
      arrow("wire", [[160, 100], [900, 100]], { start: "west", end: "east" }),
    ]);
    expect(evaluateDiagramPlan(trespass).edgesThroughContainers).toEqual([
      "wire x box (2 crossings)",
    ]);
  });
});

describe("bound edge labels", () => {
  const labelled = (points: Array<[number, number]>, rounded = false) => handBuiltPlan([
    node("from", 0, 0),
    node("to", 600, 0),
    {
      ...arrow("wire", points, { start: "from", end: "to", rounded }),
      skeleton: {
        ...arrow("wire", points, { start: "from", end: "to", rounded }).skeleton,
        label: { text: "emit" },
      },
    },
  ]);

  it("puts the label where Excalidraw puts it and leaves its own arrow alone", () => {
    const report = evaluateDiagramPlan(labelled([[160, 40], [600, 40]]));
    expect(report.labelCollisions).toEqual([]);
  });

  it("flags a bound label sitting on somebody else's arrow", () => {
    const plan = handBuiltPlan([
      node("from", 0, 0),
      node("to", 600, 0),
      {
        role: "edge",
        key: "wire",
        skeleton: {
          id: "wire",
          type: "arrow",
          x: 160,
          y: 40,
          points: [[0, 0], [440, 0]],
          start: { id: "from" },
          end: { id: "to" },
          label: { text: "emit" },
        },
      },
      // A second connector run straight through the middle of that label.
      arrow("crosser", [[380, -60], [380, 140]], { start: "from", end: "to" }),
    ]);
    expect(evaluateDiagramPlan(plan).labelCollisions).toEqual(["wire:label x crosser"]);
  });

  it("reads the converter's own measurement instead of predicting one", () => {
    const plan = labelled([[160, 40], [600, 40]]);
    expect(evaluateDiagramPlan(plan).labelCollisions).toEqual([]);
    // The editor measured the label far wider than the plan expected, so it
    // now reaches back over the node the arrow left.
    const converted = [
      { id: "from", type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
      { id: "to", type: "rectangle", x: 600, y: 0, width: 160, height: 80 },
      {
        id: "wire",
        type: "arrow",
        x: 160,
        y: 40,
        width: 440,
        height: 0,
        points: [[0, 0], [440, 0]],
        startBinding: { elementId: "from" },
        endBinding: { elementId: "to" },
      },
      {
        id: "wire-label",
        type: "text",
        x: 100,
        y: 28,
        width: 560,
        height: 24,
        text: "emit",
        containerId: "wire",
      },
    ];
    const report = evaluateConvertedScene(converted, plan);
    expect(report.labelCollisions.sort()).toEqual(["wire:label x from", "wire:label x to"]);
  });

  it("merges the two passes without repeating a finding", () => {
    const first = evaluateDiagramPlan(strayColorPlan);
    const merged = mergeQualityReports(first, first);
    expect(merged.styleCoherence).toEqual(first.styleCoherence);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(first).sort());
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

describe("obstacles: the person's own drawing", () => {
  function obstacle(
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    kind: "shape" | "text" = "shape",
  ) {
    return { id, bounds: { x, y, width, height }, kind };
  }

  it("flags an agent node landing on one of their shapes, marked as theirs", () => {
    const plan = handBuiltPlan([node("mine", 0, 0)]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [obstacle("theirs", 40, 20, 200, 100)],
    });
    expect(report.nodeOverlaps).toEqual(["mine x theirs [obstacle]"]);
    expect(report.nodeOverlaps.every(isObstacleFinding)).toBe(true);
  });

  it("flags an agent route driven through one of their shapes", () => {
    const plan = handBuiltPlan([
      node("a", 0, 0),
      node("b", 600, 0),
      arrow("edge", [[160, 40], [600, 40]], { start: "a", end: "b" }),
    ]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [obstacle("theirs", 300, 0, 100, 100)],
    });
    expect(report.edgesThroughNodes).toEqual(["edge x theirs [obstacle]"]);
  });

  it("flags an agent label sitting on one of their captions", () => {
    const plan = handBuiltPlan([
      { role: "title", skeleton: { id: "title", type: "text", x: 0, y: 0, width: 200, height: 40 } },
    ]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [obstacle("their-note", 20, 10, 80, 20, "text")],
    });
    expect(report.labelCollisions).toEqual(["title x their-note [obstacle]"]);
  });

  it("lets a route graze one of their captions", () => {
    const plan = handBuiltPlan([
      node("a", 0, 0),
      node("b", 600, 0),
      arrow("edge", [[160, 40], [600, 40]], { start: "a", end: "b" }),
    ]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [obstacle("their-note", 300, 20, 100, 40, "text")],
    });
    expect(report.edgesThroughNodes).toEqual([]);
  });

  it("never judges their drawing against itself", () => {
    const plan = handBuiltPlan([node("mine", 0, 0)]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [
        obstacle("theirs-a", 900, 900, 200, 200),
        obstacle("theirs-b", 950, 950, 200, 200),
        obstacle("their-note", 960, 960, 40, 20, "text"),
      ],
    });
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
  });

  it("leaves a drawing that clears them alone", () => {
    const plan = handBuiltPlan([
      node("a", 0, 0),
      node("b", 600, 0),
      arrow("edge", [[160, 40], [600, 40]], { start: "a", end: "b" }),
    ]);
    const report = evaluateDiagramPlan(plan, undefined, {
      obstacles: [obstacle("theirs", 0, 900, 200, 100)],
    });
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
  });

  it("costs nothing when the board has no sketch on it", () => {
    const plan = handBuiltPlan([node("mine", 0, 0)]);
    expect(evaluateDiagramPlan(plan, undefined, { obstacles: [] }))
      .toEqual(evaluateDiagramPlan(plan));
  });
});
