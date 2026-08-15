import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planDiff, type DiffElement } from "../src/renderer/diagram-diff";
import { planDiagramLayout, type LayoutParams } from "../src/renderer/diagram-layout";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 200, y: 200 };
const DIAGRAM_ID = "wd-test";

/** The board as it would look after drawing this graph, bound labels and all. */
async function drawn(params: LayoutParams): Promise<DiffElement[]> {
  const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
  return plan.skeletons.flatMap((skeleton) => {
    const element = skeleton as DiffElement;
    const label = (skeleton.label as { text?: string } | undefined)?.text;
    if (!label) return [element];
    return [element, {
      id: `${element.id}-label`,
      type: "text",
      x: finiteCentre(element, "x"),
      y: finiteCentre(element, "y"),
      width: 40,
      height: 24,
      text: label,
      containerId: element.id,
    }];
  });
}

function finiteCentre(element: DiffElement, axis: "x" | "y"): number {
  const base = element[axis] ?? 0;
  const span = axis === "x" ? element.width ?? 0 : element.height ?? 0;
  return base + span / 2;
}

const base: LayoutParams = {
  nodes: [
    { id: "a", label: "Accept" },
    { id: "b", label: "Queue" },
    { id: "c", label: "Deliver" },
  ],
  edges: [{ from: "a", to: "b", label: "enqueue" }, { from: "b", to: "c", label: "drain" }],
};

describe("planDiff", () => {
  it("reports a pure move as survivors going nowhere new but everywhere else", async () => {
    const before = await drawn(base);
    const plan = await planDiagramLayout(
      { ...base, layout: { direction: "DOWN" } },
      ORIGIN,
      DIAGRAM_ID,
    );
    const diff = planDiff(before, plan);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.relabels).toEqual([]);
    expect(diff.survivors).toHaveLength(plan.skeletons.length);
    // A different direction has to have moved something.
    expect(diff.survivors.some((survivor) => survivor.from.x !== survivor.to.x
      || survivor.from.y !== survivor.to.y)).toBe(true);
  });

  it("treats a node added and one removed as exactly that", async () => {
    const before = await drawn(base);
    const plan = await planDiagramLayout({
      nodes: [
        { id: "a", label: "Accept" },
        { id: "b", label: "Queue" },
        { id: "d", label: "Retry" },
      ],
      edges: [{ from: "a", to: "b", label: "enqueue" }, { from: "b", to: "d", label: "retry" }],
    }, ORIGIN, DIAGRAM_ID);
    const diff = planDiff(before, plan);
    expect(diff.additions.some((id) => id.includes("-n-d-"))).toBe(true);
    expect(diff.removals.some((id) => id.includes("-n-c-"))).toBe(true);
    expect(diff.survivors.map((survivor) => survivor.id).some((id) => id.includes("-n-a-"))).toBe(true);
  });

  it("reports a relabel with the text element that carries it", async () => {
    const before = await drawn(base);
    const plan = await planDiagramLayout({
      ...base,
      nodes: [
        { id: "a", label: "Accept" },
        { id: "b", label: "Buffer" },
        { id: "c", label: "Deliver" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const diff = planDiff(before, plan);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.relabels).toHaveLength(1);
    expect(diff.relabels[0]).toMatchObject({ from: "Queue", to: "Buffer" });
    expect(diff.relabels[0].labelId).toBe(`${diff.relabels[0].id}-label`);
  });

  it("reads a renamed key as one element leaving and another arriving", async () => {
    const before = await drawn(base);
    const plan = await planDiagramLayout({
      nodes: [
        { id: "accept", label: "Accept" },
        { id: "b", label: "Queue" },
        { id: "c", label: "Deliver" },
      ],
      edges: [{ from: "accept", to: "b", label: "enqueue" }, { from: "b", to: "c", label: "drain" }],
    }, ORIGIN, DIAGRAM_ID);
    const diff = planDiff(before, plan);
    expect(diff.additions.some((id) => id.includes("-n-accept-"))).toBe(true);
    expect(diff.removals.some((id) => id.includes("-n-a-"))).toBe(true);
    expect(diff.relabels).toEqual([]);
    // Its bound label leaves with it rather than being stranded.
    const departedNode = diff.removals.find((id) => id.includes("-n-a-"))!;
    expect(diff.removals).toContain(`${departedNode}-label`);
  });

  it("keeps a node that only changed container as a survivor", async () => {
    const before = await drawn({
      containers: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
      nodes: [
        { id: "a", label: "Accept", container: "one" },
        { id: "b", label: "Queue", container: "two" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const plan = await planDiagramLayout({
      containers: [{ id: "one", label: "One" }, { id: "two", label: "Two" }],
      nodes: [
        { id: "a", label: "Accept", container: "two" },
        { id: "b", label: "Queue", container: "two" },
      ],
      edges: [{ from: "a", to: "b" }],
    }, ORIGIN, DIAGRAM_ID);
    const diff = planDiff(before, plan);
    // "one" holds nobody now, so it is the only thing that leaves.
    expect(diff.removals.every((id) => id.includes("-one-"))).toBe(true);
    expect(diff.additions).toEqual([]);
    expect(diff.survivors.map((survivor) => survivor.id).filter((id) => id.includes("-n-a-")))
      .toHaveLength(1);
  });

  it("ignores elements belonging to somebody else's diagram", async () => {
    const before = await drawn(base);
    const plan = await planDiagramLayout(base, ORIGIN, DIAGRAM_ID);
    const foreign: DiffElement = {
      id: "human-box",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    };
    const stranger: DiffElement = {
      id: "wd-other-n-x",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      customData: { wiley: { diagram: "wd-other", role: "node", key: "x" } },
    };
    const diff = planDiff([...before, foreign, stranger], plan);
    expect(diff.removals).toEqual([]);
    expect(diff.additions).toEqual([]);
  });
});
