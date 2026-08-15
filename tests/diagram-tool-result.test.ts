import { describe, expect, it } from "vitest";

import { diagramToolText, summarizeDiagramQuality } from "../src/main/pi/tools";

const cleanReport = {
  nodeOverlaps: [],
  labelCollisions: [],
  edgesThroughNodes: [],
  sharedPorts: [],
  crowdedPorts: [],
  overlappingParallelSegments: [],
  offGrid: [],
  styleCoherence: [],
};

describe("summarizeDiagramQuality", () => {
  it("says how many checks passed when nothing tripped", () => {
    expect(summarizeDiagramQuality(cleanReport)).toBe("clean on 8 checks");
  });

  it("names only the checks that found something", () => {
    expect(summarizeDiagramQuality({
      ...cleanReport,
      crowdedPorts: ["hub @ 8.0px (e1, e2)"],
      styleCoherence: ["a", "b"],
    })).toBe("1 crowdedPorts, 2 styleCoherence");
  });

  it("stays quiet when there is no report", () => {
    expect(summarizeDiagramQuality(undefined)).toBeUndefined();
    expect(summarizeDiagramQuality({})).toBeUndefined();
  });
});

describe("diagramToolText", () => {
  it("collapses the report to one line and keeps the rest of the result", () => {
    const text = diagramToolText({
      diagramId: "wd-x",
      count: 12,
      layout: { requested: "radial", used: "layered", reason: "radial could not lay this graph out" },
      quality: cleanReport,
    }).content[0].text;
    expect(JSON.parse(text)).toEqual({
      diagramId: "wd-x",
      count: 12,
      layout: { requested: "radial", used: "layered", reason: "radial could not lay this graph out" },
      quality: "clean on 8 checks",
    });
  });

  it("passes anything without a report straight through", () => {
    expect(diagramToolText({ stale: true }).content[0].text).toBe(JSON.stringify({ stale: true }));
    expect(diagramToolText("plain").content[0].text).toBe("plain");
  });
});
