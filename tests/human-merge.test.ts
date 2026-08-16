import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planDiagramLayout, type LayoutParams } from "../src/renderer/diagram-layout";
import { evaluateDiagramPlan } from "../src/renderer/diagram-quality";
import { humanNodeId, planHumanEdges } from "../src/renderer/canvas/human-merge";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 0, y: 0 };

/**
 * The connectors an update draws into the person's sketch are placed by a
 * second pass, after ELK has finished with the agent's own graph. That pass
 * has to see everything the first one already put on the board.
 */
describe("connectors into the human sketch", () => {
  const spec: LayoutParams = {
    layout: { algorithm: "layered", direction: "RIGHT" },
    nodes: [
      { id: "gateway", label: "Gateway" },
      { id: "auth", label: "Auth" },
    ],
    edges: [{ from: "gateway", to: "auth", label: "verifies the session" }],
  };

  it("keeps every label clear of the ones the diagram already carries", async () => {
    const plan = await planDiagramLayout(spec, ORIGIN, "wd-merge");
    // The diagram's own caption stands beside its route, so it exists only as
    // a skeleton. The second pass has to read it from there.
    expect(plan.skeletons.filter(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "edgeLabel",
    ).map((skeleton) => skeleton.text)).toEqual(["verifies the session"]);
    const agentBoxes = new Map(plan.skeletons
      .filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node")
      .map((skeleton) => [
        plan.roles.get(String(skeleton.id))!.key!,
        {
          id: String(skeleton.id),
          x: skeleton.x as number,
          y: skeleton.y as number,
          width: skeleton.width as number,
          height: skeleton.height as number,
        },
      ]));

    // Two of the person's shapes sitting one above the other, so both
    // connectors run through the same channel and both labels want the
    // middle of it.
    const humanBoxes = new Map([
      [humanNodeId("sketch-a"), { id: "sketch-a", x: 620, y: -60, width: 160, height: 80 }],
      [humanNodeId("sketch-b"), { id: "sketch-b", x: 620, y: 60, width: 160, height: 80 }],
    ]);
    const crossEdges = [
      { edge: { from: "auth", to: humanNodeId("sketch-a"), label: "issues token" }, key: "auth__sketch-a" },
      { edge: { from: "auth", to: humanNodeId("sketch-b"), label: "writes session" }, key: "auth__sketch-b" },
    ];

    const drawn = planHumanEdges(plan, crossEdges, { agentBoxes, humanBoxes, blockers: [] });
    plan.skeletons.push(...drawn.skeletons);
    const report = evaluateDiagramPlan(plan);
    expect(report.labelCollisions).toEqual([]);
  });

  it("will not ride an arrow through a label the diagram already placed", async () => {
    const boxesOf = (plan: Awaited<ReturnType<typeof planDiagramLayout>>) => new Map(plan.skeletons
      .filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node")
      .map((skeleton) => [
        plan.roles.get(String(skeleton.id))!.key!,
        {
          id: String(skeleton.id),
          x: skeleton.x as number,
          y: skeleton.y as number,
          width: skeleton.width as number,
          height: skeleton.height as number,
        },
      ]));
    const humanBoxes = new Map([
      [humanNodeId("sketch-a"), { id: "sketch-a", x: 900, y: 0, width: 160, height: 80 }],
    ]);
    const crossEdges = [
      { edge: { from: "auth", to: humanNodeId("sketch-a"), label: "signs in" }, key: "auth__sketch-a" },
    ];
    const labelled = (plan: Awaited<ReturnType<typeof planDiagramLayout>>) => {
      const drawn = planHumanEdges(plan, crossEdges, {
        agentBoxes: boxesOf(plan),
        humanBoxes,
        blockers: [],
      });
      const arrow = drawn.skeletons.find((skeleton) => skeleton.type === "arrow")!;
      return { bound: Boolean(arrow.label), route: arrow };
    };

    const open = await planDiagramLayout(spec, ORIGIN, "wd-merge");
    const first = labelled(open);
    expect(first.bound).toBe(true);

    // Now the diagram already carries a label exactly where that one would
    // ride. A bound label has no skeleton, so this is the only record of it.
    const anchor = {
      x: (first.route.x as number) + ((first.route.points as number[][]).at(-1)![0]) / 2,
      y: (first.route.y as number) + ((first.route.points as number[][]).at(-1)![1]) / 2,
    };
    const crowded = await planDiagramLayout(spec, ORIGIN, "wd-merge");
    crowded.boundLabelBoxes.push({
      id: "wd-merge-el-existing",
      x: anchor.x - 60,
      y: anchor.y - 20,
      width: 120,
      height: 40,
    });
    expect(labelled(crowded).bound).toBe(false);
  });
});
