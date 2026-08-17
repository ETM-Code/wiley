import { describe, expect, it } from "vitest";

import { reconstructSpec } from "../src/renderer/canvas/diagram-reconstruct";
import { inferHumanGraph, type SketchElement } from "../src/renderer/canvas/human-graph";
import {
  humanElementIdOf,
  humanNodeId,
  materializeHumanNodes,
  splitHumanSpec,
} from "../src/renderer/canvas/human-merge";
import { sceneSummary } from "../src/renderer/canvas/scene-summary";
import type { SceneElement } from "../src/renderer/canvas/types";
import { buildBoardContext, buildTaskMessage } from "../src/main/pi/prompt-context";

const DIAGRAM = "wd-flow-1";

function stamp(role: string, key?: string) {
  return { customData: { wiley: { diagram: DIAGRAM, role, theme: "slate", ...(key ? { key } : {}) } } };
}

/** An agent diagram of one node, plus a human box the agent already reached. */
function boardWithBridge(): SceneElement[] {
  return [
    {
      id: `${DIAGRAM}-n-api`,
      type: "rectangle",
      x: 0,
      y: 0,
      width: 160,
      height: 80,
      ...stamp("node", "api"),
    },
    {
      id: "label-api",
      type: "text",
      x: 10,
      y: 10,
      width: 40,
      height: 20,
      text: "API",
      containerId: `${DIAGRAM}-n-api`,
    },
    { id: "human-box", type: "rectangle", x: 400, y: 0, width: 120, height: 60 },
    { id: "human-text", type: "text", x: 420, y: 20, width: 40, height: 20, text: "Login", containerId: "human-box" },
    {
      id: `${DIAGRAM}-e-bridge`,
      type: "arrow",
      x: 160,
      y: 40,
      width: 240,
      height: 0,
      points: [[0, 0], [240, 0]],
      startBinding: { elementId: `${DIAGRAM}-n-api` },
      endBinding: { elementId: "human-box" },
      ...stamp("edge", "api__human-box__0"),
    },
  ] as unknown as SceneElement[];
}

describe("human node ids", () => {
  it("round-trips an element id", () => {
    expect(humanElementIdOf(humanNodeId("abc"))).toBe("abc");
    expect(humanElementIdOf("api")).toBeUndefined();
  });
});

describe("reconstructSpec with the human sketch", () => {
  it("drops an arrow into the sketch when the sketch is not supplied", () => {
    const spec = reconstructSpec(boardWithBridge(), DIAGRAM);
    expect(spec.nodes.map((node) => node.id)).toEqual(["api"]);
    expect(spec.edges).toEqual([]);
  });

  it("rebuilds it as an edge to a human node carrying the real element id", () => {
    const board = boardWithBridge();
    const human = inferHumanGraph(board as unknown as SketchElement[]);
    const spec = reconstructSpec(board, DIAGRAM, { human });

    expect(spec.edges).toEqual([{ from: "api", to: "human:human-box" }]);
    const node = spec.nodes.find((candidate) => candidate.id === "human:human-box");
    expect(node).toMatchObject({ origin: "human", elementId: "human-box", label: "Login" });
  });

  it("never adds a human node the diagram does not touch", () => {
    const board = [
      ...boardWithBridge(),
      { id: "stray", type: "rectangle", x: 900, y: 900, width: 100, height: 50 },
    ] as unknown as SceneElement[];
    const spec = reconstructSpec(board, DIAGRAM, { human: inferHumanGraph(board as unknown as SketchElement[]) });
    expect(spec.nodes.map((node) => node.id)).toEqual(["api", "human:human-box"]);
  });
});

describe("scene summary containment", () => {
  it("keeps an enclosing shape and its members available to later turns", () => {
    const summary = sceneSummary([
      { id: "login", type: "rectangle", x: 100, y: 100, width: 160, height: 60 } as SceneElement,
      { id: "dashboard", type: "rectangle", x: 320, y: 100, width: 180, height: 60 } as SceneElement,
      { id: "ring", type: "ellipse", x: 50, y: 50, width: 500, height: 180 } as SceneElement,
    ]);
    expect(summary.humanGraph.nodes.find((node) => node.id === "ring")).toMatchObject({
      encloses: ["login", "dashboard"],
    });
  });
});

describe("materializeHumanNodes", () => {
  const human = inferHumanGraph(boardWithBridge() as unknown as SketchElement[]);

  it("fills in a human node an edge names but the spec never declared", () => {
    const spec = materializeHumanNodes({
      nodes: [{ id: "api", label: "API" }],
      edges: [{ from: "api", to: "human:human-box" }],
    }, human);
    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[1]).toMatchObject({
      id: "human:human-box",
      label: "Login",
      origin: "human",
      elementId: "human-box",
    });
  });

  it("attaches real geometry to a human node the spec declared by hand", () => {
    const spec = materializeHumanNodes({
      nodes: [{ id: "human:human-box", label: "Renamed" }],
      edges: [],
    }, human);
    expect(spec.nodes[0]).toMatchObject({
      origin: "human",
      elementId: "human-box",
      label: "Renamed",
    });
  });

  it("reads a bare element id as the same request and rewrites the edge", () => {
    const spec = materializeHumanNodes({
      nodes: [{ id: "api", label: "API" }],
      edges: [{ from: "api", to: "human-box" }],
    }, human);
    expect(spec.edges).toEqual([{ from: "api", to: "human:human-box" }]);
    expect(spec.nodes[1].elementId).toBe("human-box");
  });

  it("lets an agent node keep an id a human element happens to share", () => {
    const spec = materializeHumanNodes({
      nodes: [{ id: "human-box", label: "Mine" }, { id: "api", label: "API" }],
      edges: [{ from: "api", to: "human-box" }],
    }, human);
    expect(spec.edges).toEqual([{ from: "api", to: "human-box" }]);
    expect(spec.nodes.every((node) => node.origin === undefined)).toBe(true);
  });

  it("fails loudly on an id with no element behind it", () => {
    expect(() => materializeHumanNodes({
      nodes: [{ id: "api", label: "API" }],
      edges: [{ from: "api", to: "human:nope" }],
    }, human)).toThrow(/human:nope/);
  });
});

describe("splitHumanSpec", () => {
  it("keeps human nodes and the edges touching them out of the layout", () => {
    const split = splitHumanSpec({
      nodes: [
        { id: "api", label: "API" },
        { id: "db", label: "DB" },
        { id: "human:human-box", label: "Login", origin: "human", elementId: "human-box" },
      ],
      edges: [
        { from: "api", to: "db" },
        { from: "api", to: "human:human-box", label: "calls" },
      ],
    });
    expect(split.agentSpec.nodes.map((node) => node.id)).toEqual(["api", "db"]);
    expect(split.agentSpec.edges).toEqual([{ from: "api", to: "db" }]);
    expect(split.humanNodes.has("human:human-box")).toBe(true);
    expect(split.crossEdges).toHaveLength(1);
    expect(split.crossEdges[0].edge.label).toBe("calls");
    expect(split.crossEdges[0].key).toMatch(/__0$/);
  });
});

describe("scene reads carry the sketch", () => {
  it("puts the inferred graph in the scene summary", () => {
    const summary = sceneSummary(boardWithBridge());
    expect(summary.humanGraph.nodes).toEqual([
      { id: "human-box", shape: "rectangle", label: "Login", bbox: { x: 400, y: 0, w: 120, h: 60 } },
    ]);
    expect(summary.humanGraph.edges).toEqual([]);
  });
});

describe("board context carries the sketch", () => {
  const board = {
    revision: 1,
    elements: boardWithBridge() as unknown as Array<Record<string, unknown>>,
    appState: {},
  };

  it("lists the human graph beside the agent's diagrams", () => {
    expect(buildBoardContext(board).humanGraph.nodes).toEqual([
      { id: "human-box", shape: "rectangle", label: "Login", bbox: { x: 400, y: 0, w: 120, h: 60 } },
    ]);
  });

  it("summarizes it on one line inside the diagrams block", () => {
    const message = buildTaskMessage({
      task: "extend it",
      userWords: "extend my sketch",
      transcriptEntries: [],
      board,
    });
    expect(message).toContain('human sketch: 1 shapes ("Login"), 0 connectors');
  });
});
