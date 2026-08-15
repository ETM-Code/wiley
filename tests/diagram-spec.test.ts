import { describe, expect, it } from "vitest";

import {
  deriveDiagramId,
  edgeElementId,
  edgeKey,
  edgeLabelElementId,
  edgeOrdinals,
  nodeElementId,
  slug,
  titleElementId,
} from "../src/renderer/diagram-spec";
import { planningDiagram } from "./fixtures/diagram-gallery";

describe("slug", () => {
  it("is lowercase, dash-separated, and free of leading or trailing dashes", () => {
    expect(slug("  Voice Assistant / Orchestrator  ")).toMatch(/^voice-assistant-orchestrator-[0-9a-z]{6}$/);
  });

  it("is deterministic for the same input", () => {
    expect(slug("Local Coder • Tests")).toBe(slug("Local Coder • Tests"));
  });

  it("keeps the readable half within 40 characters", () => {
    const readable = slug("a".repeat(200)).split("-")[0];
    expect(readable).toHaveLength(40);
  });

  it("separates two labels that are identical for the first 40 characters", () => {
    const first = slug(`${"pipeline stage ".repeat(4)}alpha`);
    const second = slug(`${"pipeline stage ".repeat(4)}beta`);
    expect(first.split("-").slice(0, -1)).toEqual(second.split("-").slice(0, -1));
    expect(first).not.toBe(second);
  });

  it("still produces an id when nothing survives normalization", () => {
    expect(slug("···")).toMatch(/^[0-9a-z]{6}$/);
    expect(slug("···")).not.toBe(slug("~~~"));
  });

  it("spreads distinct inputs across distinct slugs", () => {
    const slugs = new Set(Array.from({ length: 2_000 }, (_unused, index) => slug(`node ${index}`)));
    expect(slugs.size).toBe(2_000);
  });
});

describe("deriveDiagramId", () => {
  it("is reproducible from the same params and seed", () => {
    expect(deriveDiagramId(planningDiagram, 1)).toBe(deriveDiagramId(planningDiagram, 1));
  });

  it("names the diagram after its title", () => {
    expect(deriveDiagramId(planningDiagram, 1)).toMatch(/^wd-voice-coding-architecture-[0-9a-z]{6}-1$/);
  });

  it("falls back to the first node label when there is no title", () => {
    const id = deriveDiagramId({ nodes: [{ id: "a", label: "Ingest Queue" }], edges: [] }, 2);
    expect(id).toMatch(/^wd-ingest-queue-[0-9a-z]{6}-2$/);
  });

  it("separates two diagrams drawn from identical params", () => {
    expect(deriveDiagramId(planningDiagram, 1)).not.toBe(deriveDiagramId(planningDiagram, 2));
  });
});

describe("element ids", () => {
  const diagramId = deriveDiagramId(planningDiagram, 7);

  it("derives one distinct id per node", () => {
    const ids = planningDiagram.nodes.map((node) => nodeElementId(diagramId, node.id));
    expect(new Set(ids).size).toBe(planningDiagram.nodes.length);
    expect(ids.every((id) => id.startsWith(`${diagramId}-n-`))).toBe(true);
  });

  it("numbers parallel edges so their ids stay distinct", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ];
    const ordinals = edgeOrdinals(edges);
    expect(ordinals).toEqual([0, 0, 1, 0]);
    const ids = edges.map((edge, index) => edgeElementId(diagramId, edgeKey(edge, ordinals[index])));
    expect(new Set(ids).size).toBe(edges.length);
  });

  it("keeps an edge and its label on the same key but different ids", () => {
    const key = edgeKey({ from: "a", to: "b" }, 0);
    expect(edgeElementId(diagramId, key)).not.toBe(edgeLabelElementId(diagramId, key));
    expect(edgeLabelElementId(diagramId, key)).toBe(`${diagramId}-el-${key}`);
  });

  it("gives the title one fixed id per diagram", () => {
    expect(titleElementId(diagramId)).toBe(`${diagramId}-title`);
  });

  it("never collides across the whole planning diagram", () => {
    const ordinals = edgeOrdinals(planningDiagram.edges);
    const ids = [
      titleElementId(diagramId),
      ...planningDiagram.nodes.map((node) => nodeElementId(diagramId, node.id)),
      ...planningDiagram.edges.map((edge, index) => edgeElementId(diagramId, edgeKey(edge, ordinals[index]))),
      ...planningDiagram.edges.map((edge, index) => edgeLabelElementId(diagramId, edgeKey(edge, ordinals[index]))),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
