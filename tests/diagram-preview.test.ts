import { describe, expect, it } from "vitest";

import { stableDiagramPreview } from "../src/main/diagram-preview";

describe("streaming diagram arguments", () => {
  it("keeps the valid JSON prefix and drops incomplete references", () => {
    expect(stableDiagramPreview({
      title: "Permit flo",
      nodes: [
        { id: "start", label: "Application", shape: "rectangle", rounded: true },
        { id: "check", label: "Complete?", shape: "dia" },
        { id: "", label: "unfinished" },
      ],
      edges: [
        { from: "start", to: "check", label: "review" },
        { from: "check", to: "missing" },
      ],
      layout: { direction: "DO", nodeSpacing: 80, layerSpacing: Number.NaN },
    })).toEqual({
      title: "Permit flo",
      nodes: [
        { id: "start", label: "Application", shape: "rectangle", rounded: true },
        { id: "check", label: "Complete?" },
      ],
      edges: [{ from: "start", to: "check", label: "review" }],
      layout: { nodeSpacing: 80 },
    });
  });

  it("waits until at least one complete node exists", () => {
    expect(stableDiagramPreview({ nodes: [{ id: "partial" }] })).toBeUndefined();
    expect(stableDiagramPreview({})).toBeUndefined();
  });
});
