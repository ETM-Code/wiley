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

  it("shows a container only once every node claiming it has arrived", () => {
    const streaming = stableDiagramPreview({
      containers: [{ id: "edge", label: "Edge tier", role: "primary", render: "group" }],
      nodes: [
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "waf", container: "edge" },
      ],
      edges: [],
    });
    expect(streaming).toEqual({
      nodes: [{ id: "cdn", label: "CDN" }],
      edges: [],
    });

    expect(stableDiagramPreview({
      containers: [{ id: "edge", label: "Edge tier", role: "primary", render: "group" }],
      nodes: [
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "waf", label: "WAF", container: "edge" },
      ],
      edges: [{ from: "cdn", to: "waf" }],
    })).toEqual({
      containers: [{ id: "edge", label: "Edge tier", role: "primary", render: "group" }],
      nodes: [
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "waf", label: "WAF", container: "edge" },
      ],
      edges: [{ from: "cdn", to: "waf" }],
    });
  });

  it("withholds a parent whose nested container is still waiting on a member", () => {
    expect(stableDiagramPreview({
      containers: [
        { id: "cloud", label: "Cloud" },
        { id: "vpc", label: "VPC", parent: "cloud" },
      ],
      nodes: [
        { id: "dns", label: "DNS", container: "cloud" },
        { id: "app", container: "vpc" },
      ],
      edges: [],
    })).toEqual({ nodes: [{ id: "dns", label: "DNS" }], edges: [] });
  });

  it("drops an empty container, an unrooted one, and a half-streamed render token", () => {
    expect(stableDiagramPreview({
      containers: [
        { id: "empty", label: "Nothing here" },
        { id: "orphan", label: "Orphan", parent: "not-streamed-yet" },
        { id: "tier", label: "Tier", render: "fra" },
      ],
      nodes: [{ id: "a", label: "A", container: "tier" }],
      edges: [],
    })).toEqual({
      containers: [{ id: "tier", label: "Tier" }],
      nodes: [{ id: "a", label: "A", container: "tier" }],
      edges: [],
    });
  });

  it("waits until at least one complete node exists", () => {
    expect(stableDiagramPreview({ nodes: [{ id: "partial" }] })).toBeUndefined();
    expect(stableDiagramPreview({})).toBeUndefined();
  });
});
