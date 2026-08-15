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

  it("carries theme, role, emphasis, and edge styling through to the preview", () => {
    expect(stableDiagramPreview({
      theme: "ocean",
      nodes: [
        { id: "a", label: "Ingest", role: "primary", emphasis: "strong" },
        { id: "b", label: "Store", role: "muted", emphasis: "quiet" },
      ],
      edges: [
        { from: "a", to: "b", style: "dashed", weight: "strong", color: "danger", arrow: "both" },
      ],
    })).toEqual({
      theme: "ocean",
      nodes: [
        { id: "a", label: "Ingest", role: "primary", emphasis: "strong" },
        { id: "b", label: "Store", role: "muted", emphasis: "quiet" },
      ],
      edges: [
        { from: "a", to: "b", style: "dashed", weight: "strong", color: "danger", arrow: "both" },
      ],
    });
  });

  it("carries the layout algorithm and the new directions", () => {
    expect(stableDiagramPreview({
      nodes: [{ id: "a", label: "Root", shape: "text" }],
      layout: { algorithm: "tree", direction: "UP" },
    })).toEqual({
      nodes: [{ id: "a", label: "Root", shape: "text" }],
      edges: [],
      layout: { algorithm: "tree", direction: "UP" },
    });
  });

  it("drops half-streamed enum tokens rather than guessing", () => {
    expect(stableDiagramPreview({
      theme: "oce",
      nodes: [{ id: "a", label: "Ingest", role: "prim", emphasis: "stro", shape: "te" }],
      edges: [{ from: "a", to: "a", style: "das", weight: "quie", arrow: "bot" }],
      layout: { algorithm: "rad" },
    })).toEqual({
      nodes: [{ id: "a", label: "Ingest" }],
      edges: [{ from: "a", to: "a" }],
    });
  });

  it("waits until at least one complete node exists", () => {
    expect(stableDiagramPreview({ nodes: [{ id: "partial" }] })).toBeUndefined();
    expect(stableDiagramPreview({})).toBeUndefined();
  });
});
