import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  createPiTools,
  diagramToolText,
  summarizeDiagramQuality,
  type PiToolHost,
} from "../src/main/pi/tools";

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

/**
 * The shape vocabulary is an enum the model can only discover from the prose:
 * the schema rejects anything outside it, but a rejection costs a whole model
 * round trip. A live run lost one to `shape: "cylinder"` on a database node,
 * which is the obvious guess when the description never says what is on offer.
 */
describe("the diagram tools' node shape vocabulary", () => {
  const shapesIn = (tool: ToolDefinition): string[] => {
    const parameters = tool.parameters as {
      properties: { nodes: { items?: { properties: { shape: { anyOf: Array<{ const: string }> } } } } };
    };
    const items = parameters.properties.nodes.items;
    return (items?.properties.shape.anyOf ?? []).map((entry) => entry.const);
  };

  it("offers exactly the four shapes the layout can draw", () => {
    const tools = createPiTools({} as PiToolHost, "root");
    const draw = tools.find((tool) => tool.name === "draw_diagram")!;
    expect(shapesIn(draw)).toEqual(["rectangle", "diamond", "ellipse", "text"]);
  });

  it("names every accepted shape in the description of each tool taking nodes", () => {
    const tools = createPiTools({} as PiToolHost, "root");
    for (const name of ["draw_diagram", "update_diagram"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      for (const shape of shapesIn(tools.find((c) => c.name === "draw_diagram")!)) {
        expect(tool.description, `${name} never mentions the ${shape} shape`).toContain(shape);
      }
    }
  });

  it("rules out the shapes a model reaches for that the schema would reject", () => {
    const tools = createPiTools({} as PiToolHost, "root");
    const draw = tools.find((tool) => tool.name === "draw_diagram")!;
    expect(shapesIn(draw)).not.toContain("cylinder");
    expect(draw.description).toMatch(/no cylinder, hexagon, or parallelogram/);
  });
});
