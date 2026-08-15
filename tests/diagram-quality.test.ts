import { describe, expect, it } from "vitest";

import { evaluateDiagramPlan } from "../src/renderer/diagram-quality";
import {
  contrastTrapPlan,
  rainbowPlan,
  strayColorPlan,
  strokeWidthSoupPlan,
} from "./fixtures/diagram-gallery";

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
