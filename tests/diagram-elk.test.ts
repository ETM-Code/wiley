import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";

import { resolveAbsolute } from "../src/renderer/diagram-elk";

/**
 * Two levels of nesting with the numbers worked out by hand:
 *
 *   root
 *     outer      at (100, 40), 400 x 300
 *       inner    at ( 30, 20) inside outer -> absolute (130, 60), 200 x 150
 *         a      at ( 10, 10) inside inner -> absolute (140, 70)
 *         b      at ( 10, 90) inside inner -> absolute (140, 150)
 *     far        at (600, 40)
 *
 * `a -> b` lives inside inner, so its route is measured from (130, 60).
 * `a -> far` lives at the root, so its route is measured from (0, 0).
 */
const tree: ElkNode = {
  id: "root",
  width: 900,
  height: 400,
  children: [
    {
      id: "outer",
      x: 100,
      y: 40,
      width: 400,
      height: 300,
      children: [
        {
          id: "inner",
          x: 30,
          y: 20,
          width: 200,
          height: 150,
          children: [
            { id: "a", x: 10, y: 10, width: 80, height: 40 },
            { id: "b", x: 10, y: 90, width: 80, height: 40 },
          ],
          edges: [{
            id: "a-b",
            sources: ["a"],
            targets: ["b"],
            sections: [{
              id: "s1",
              startPoint: { x: 50, y: 50 },
              bendPoints: [{ x: 60, y: 70 }],
              endPoint: { x: 50, y: 90 },
            }],
            labels: [{ x: 65, y: 60, width: 20, height: 10 }],
          }],
        },
      ],
    },
    { id: "far", x: 600, y: 40, width: 120, height: 60 },
  ],
  edges: [{
    id: "a-far",
    sources: ["a"],
    targets: ["far"],
    sections: [{
      id: "s2",
      startPoint: { x: 220, y: 90 },
      bendPoints: [],
      endPoint: { x: 600, y: 70 },
    }],
  }],
};

describe("resolveAbsolute", () => {
  it("accumulates every ancestor offset into one coordinate system", () => {
    const { boxes } = resolveAbsolute(tree);
    expect(boxes.get("root")).toEqual({ x: 0, y: 0, width: 900, height: 400 });
    expect(boxes.get("outer")).toEqual({ x: 100, y: 40, width: 400, height: 300 });
    expect(boxes.get("inner")).toEqual({ x: 130, y: 60, width: 200, height: 150 });
    expect(boxes.get("a")).toEqual({ x: 140, y: 70, width: 80, height: 40 });
    expect(boxes.get("b")).toEqual({ x: 140, y: 150, width: 80, height: 40 });
    expect(boxes.get("far")).toEqual({ x: 600, y: 40, width: 120, height: 60 });
  });

  it("measures a nested edge from its container and a root edge from the root", () => {
    const { routes, labels } = resolveAbsolute(tree);
    expect(routes.get("a-b")).toEqual([
      { x: 180, y: 110 },
      { x: 190, y: 130 },
      { x: 180, y: 150 },
    ]);
    expect(labels.get("a-b")).toEqual({ x: 195, y: 120 });
    expect(routes.get("a-far")).toEqual([
      { x: 220, y: 90 },
      { x: 600, y: 70 },
    ]);
    expect(labels.has("a-far")).toBe(false);
  });

  it("honours an explicit container that differs from where the edge is declared", () => {
    const relabelled: ElkNode = {
      id: "root",
      children: [{ id: "outer", x: 100, y: 40, width: 200, height: 100 }],
      edges: [{
        id: "moved",
        container: "outer",
        sources: ["outer"],
        targets: ["outer"],
        sections: [{ id: "s", startPoint: { x: 5, y: 5 }, endPoint: { x: 15, y: 25 } }],
      }],
    };
    expect(resolveAbsolute(relabelled).routes.get("moved")).toEqual([
      { x: 105, y: 45 },
      { x: 115, y: 65 },
    ]);
  });

  it("skips an edge ELK returned without a route", () => {
    const unrouted: ElkNode = {
      id: "root",
      children: [{ id: "a", x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: "bare", sources: ["a"], targets: ["a"] }],
    };
    const { routes, boxes } = resolveAbsolute(unrouted);
    expect(routes.has("bare")).toBe(false);
    expect(boxes.get("a")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});
