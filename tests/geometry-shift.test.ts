import { describe, expect, it } from "vitest";
import { shiftClearOf } from "../src/renderer/canvas/geometry";

describe("shiftClearOf directions", () => {
  const content = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const hit = [{ minX: 50, minY: 50, maxX: 150, maxY: 150 }];

  it("moves each way it is told", () => {
    expect(shiftClearOf(content, hit, "right")).toEqual({ dx: 280, dy: 0 });
    expect(shiftClearOf(content, hit, "left")).toEqual({ dx: -180, dy: 0 });
    expect(shiftClearOf(content, hit, "below")).toEqual({ dx: 0, dy: 280 });
    expect(shiftClearOf(content, hit, "above")).toEqual({ dx: 0, dy: -180 });
  });

  it("keeps going until it is clear of the next thing too", () => {
    const chain = [
      { minX: 50, minY: 0, maxX: 150, maxY: 100 },
      { minX: 260, minY: 0, maxX: 360, maxY: 100 },
    ];
    const shift = shiftClearOf(content, chain, "right")!;
    expect(shift.dx).toBeGreaterThan(360);
  });

  it("reads zero when nothing is in the way, and nothing when nothing works", () => {
    expect(shiftClearOf(content, [{ minX: 900, minY: 900, maxX: 950, maxY: 950 }], "right"))
      .toEqual({ dx: 0, dy: 0 });
    // Five boxes in a row: four passes is not enough to get past all of them.
    const wall = Array.from({ length: 5 }, (_, index) => ({
      minX: index * 400,
      minY: 0,
      maxX: index * 400 + 380,
      maxY: 100,
    }));
    expect(shiftClearOf(content, wall, "right")).toBeUndefined();
  });
});
