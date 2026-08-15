import { describe, expect, it } from "vitest";

import {
  PORT_SPACING,
  assignPorts,
  chooseSide,
  countBlockers,
  orthogonalRoute,
  planRoutes,
  portSlots,
  reanchorRoute,
  repairStraightRoute,
  segmentIntersectsBox,
  type Box,
} from "../src/renderer/diagram-routes";

const box = (id: string, x: number, y: number, width = 160, height = 80): Box => ({
  id,
  x,
  y,
  width,
  height,
});

describe("segmentIntersectsBox", () => {
  const target = box("t", 100, 100, 100, 100);

  it("reports a genuine crossing", () => {
    expect(segmentIntersectsBox({ x1: 0, y1: 150, x2: 300, y2: 150 }, target)).toBe(true);
  });

  it("does not report a diagonal that only passes the corner", () => {
    // A bounding-box test would call this a hit; the line itself stays clear.
    expect(segmentIntersectsBox({ x1: 0, y1: 120, x2: 120, y2: 0 }, target)).toBe(false);
  });

  it("treats the clearance band as outside the box", () => {
    expect(segmentIntersectsBox({ x1: 0, y1: 102, x2: 300, y2: 102 }, target)).toBe(false);
    expect(segmentIntersectsBox({ x1: 0, y1: 106, x2: 300, y2: 106 }, target)).toBe(true);
  });
});

describe("port assignment", () => {
  it("picks the side facing the other end, measured against the box diagonal", () => {
    const wide = box("wide", 0, 0, 400, 80);
    expect(chooseSide(wide, { x: 600, y: 60 })).toBe("right");
    expect(chooseSide(wide, { x: -600, y: 60 })).toBe("left");
    expect(chooseSide(wide, { x: 210, y: 400 })).toBe("bottom");
    expect(chooseSide(wide, { x: 210, y: -400 })).toBe("top");
    // The box's own diagonal decides: a shallow angle off a wide node keeps
    // the long side, a steeper one crosses to the short one.
    expect(chooseSide(wide, { x: 400, y: 70 })).toBe("right");
    expect(chooseSide(wide, { x: 400, y: 140 })).toBe("bottom");
  });

  it("spaces slots evenly, centred on the side, never closer than a port width", () => {
    const tall = box("tall", 0, 0, 160, 400);
    const slots = portSlots(tall, "right", 4);
    expect(slots.map((slot) => slot.x)).toEqual([160, 160, 160, 160]);
    const ys = slots.map((slot) => slot.y);
    expect(ys).toEqual([80, 160, 240, 320]);
    const gaps = ys.slice(1).map((y, index) => y - ys[index]);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(PORT_SPACING);
    // Centred: the slot block's midpoint is the side's midpoint.
    expect((ys[0] + ys[ys.length - 1]) / 2).toBe(200);
  });

  it("falls back to the minimum spacing when the side is short", () => {
    const slots = portSlots(box("small", 0, 0, 160, 80), "right", 3);
    const gaps = slots.slice(1).map((slot, index) => slot.y - slots[index].y);
    for (const gap of gaps) expect(gap).toBe(PORT_SPACING);
  });

  it("orders ports by the direction they leave in, not by edge order", () => {
    const nodes = new Map([
      ["hub", box("hub", 0, 0, 160, 400)],
      ["low", box("low", 600, 600)],
      ["high", box("high", 600, -400)],
      ["mid", box("mid", 600, 160)],
    ]);
    const ports = assignPorts(nodes, [
      { id: "e-low", from: "hub", to: "low" },
      { id: "e-high", from: "hub", to: "high" },
      { id: "e-mid", from: "hub", to: "mid" },
    ]);
    const y = (id: string) => ports.get(id)!.start.y;
    expect(y("e-high")).toBeLessThan(y("e-mid"));
    expect(y("e-mid")).toBeLessThan(y("e-low"));
    for (const id of ["e-low", "e-high", "e-mid"]) expect(ports.get(id)!.start.x).toBe(160);
  });

  it("is deterministic for edges that want the same slot", () => {
    const nodes = new Map([["a", box("a", 0, 0)], ["b", box("b", 400, 0)]]);
    const edges = [
      { id: "second", from: "a", to: "b" },
      { id: "first", from: "a", to: "b" },
    ];
    const once = assignPorts(nodes, edges);
    const twice = assignPorts(nodes, [...edges].reverse());
    expect(once.get("first")!.start).toEqual(twice.get("first")!.start);
    expect(once.get("second")!.start).toEqual(twice.get("second")!.start);
    expect(once.get("first")!.start).not.toEqual(once.get("second")!.start);
  });
});

describe("reanchorRoute", () => {
  const route = [{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 0 }];

  it("moves each endpoint by its own node's snap delta", () => {
    expect(reanchorRoute(route, { dx: -7, dy: 3 }, { dx: 12, dy: -4 })).toEqual([
      { x: -7, y: 3 },
      { x: 50, y: 30 },
      { x: 112, y: -4 },
    ]);
  });

  it("leaves the bendpoints where the layout put them", () => {
    expect(reanchorRoute(route, { dx: 100, dy: 100 }, undefined)[1]).toEqual({ x: 50, y: 30 });
  });

  it("leaves a route alone when neither node moved", () => {
    expect(reanchorRoute(route, undefined, undefined)).toEqual(route);
  });
});

describe("repairStraightRoute", () => {
  // Straddles the run symmetrically, so both sides clear at the same offset.
  const blocker = [box("wall", 180, 150, 100, 100)];
  const from = { x: 0, y: 200 };
  const to = { x: 500, y: 200 };

  it("leaves a clear run straight", () => {
    expect(repairStraightRoute(from, to, [box("far", 0, 600)])).toEqual({
      points: [from, to],
      rounded: false,
    });
  });

  it("bends by the smallest clearing offset and breaks the tie positive", () => {
    const repaired = repairStraightRoute(from, to, blocker)!;
    expect(repaired.rounded).toBe(true);
    // Perpendicular to a left-to-right run, positive is downward.
    expect(repaired.points).toEqual([from, { x: 250, y: 300 }, to]);
    expect(countBlockers(repaired.points, true, blocker)).toBe(0);
    // The mirror image clears too; it lost only on the sign.
    expect(countBlockers([from, { x: 250, y: 100 }, to], true, blocker)).toBe(0);
    // One step tighter on either side still crosses.
    expect(countBlockers([from, { x: 250, y: 280 }, to], true, blocker)).toBe(1);
    expect(countBlockers([from, { x: 250, y: 120 }, to], true, blocker)).toBe(1);
  });

  it("takes the negative side when only that one clears", () => {
    const below = [box("wall", 180, 190, 100, 200)];
    const repaired = repairStraightRoute(from, to, below)!;
    expect(repaired.points[1]).toEqual({ x: 250, y: 180 });
  });

  it("honours a raised minimum offset so a second pass differs from the first", () => {
    const first = repairStraightRoute(from, to, blocker)!;
    const second = repairStraightRoute(from, to, blocker, 8)!;
    expect(first.points[1].y).toBe(300);
    expect(second.points[1].y).toBe(360);
  });

  it("gives up when nothing in range clears", () => {
    const wall = [box("wall", 180, -1000, 100, 2000)];
    expect(repairStraightRoute(from, to, wall)).toBeNull();
  });

  it("is deterministic", () => {
    expect(repairStraightRoute(from, to, blocker)).toEqual(repairStraightRoute(from, to, blocker));
  });
});

describe("orthogonalRoute", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 300 };

  it("prefers the first clear L", () => {
    expect(orthogonalRoute(from, to, []).points).toEqual([from, { x: 400, y: 0 }, to]);
  });

  it("turns on the corridor midline when both L shapes are blocked", () => {
    const blocked = [box("a", 340, -40, 120, 120), box("b", -40, 260, 120, 120)];
    const route = orthogonalRoute(from, to, blocked);
    expect(route.points).toEqual([from, { x: 200, y: 0 }, { x: 200, y: 300 }, to]);
    expect(route.rounded).toBe(false);
  });

  it("returns the least-blocking candidate when none is clean", () => {
    const walled = [box("a", 340, -40, 120, 120), box("b", -40, 260, 120, 120), box("c", 160, -400, 80, 1000)];
    const route = orthogonalRoute(from, to, walled);
    expect(route.points.length).toBeGreaterThanOrEqual(3);
    expect(countBlockers(route.points, false, walled)).toBeGreaterThan(0);
  });
});

describe("planRoutes", () => {
  const nodes = new Map([
    ["a", box("a", 0, 0)],
    ["b", box("b", 600, 0)],
    ["wall", box("wall", 280, -20, 80, 120)],
  ]);

  it("ports, repairs, and clears the obstacles between two nodes", () => {
    const [route] = planRoutes(nodes, [{ id: "e", from: "a", to: "b" }]);
    expect(route.id).toBe("e");
    expect(route.points[0]).toEqual({ x: 160, y: 40 });
    expect(route.points[route.points.length - 1]).toEqual({ x: 600, y: 40 });
    expect(countBlockers(route.points, route.rounded, [nodes.get("wall")!])).toBe(0);
  });

  it("re-anchors a supplied route onto the snapped boxes before repairing", () => {
    const [route] = planRoutes(
      new Map([["a", box("a", 0, 0)], ["b", box("b", 600, 0)]]),
      [{ id: "e", from: "a", to: "b", route: [{ x: 157, y: 37 }, { x: 597, y: 37 }] }],
      { snapDeltas: new Map([["a", { dx: 3, dy: 3 }], ["b", { dx: 3, dy: 3 }]]) },
    );
    // Port assignment wins over the re-anchored endpoints, and both agree.
    expect(route.points[0]).toEqual({ x: 160, y: 40 });
  });

  it("produces the same routes for the same graph every time", () => {
    const edges = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "a" },
    ];
    expect(planRoutes(nodes, edges)).toEqual(planRoutes(nodes, edges));
  });
});
