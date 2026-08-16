import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CAPTION_ENDPOINT_GAP,
  MODEL_GRID_SIZE,
  boundLabelAnchor,
  boundLabelRoom,
  measureText,
  nodeDimensions,
  planDiagramLayout,
  restoreTextNodeGeometry,
  wrapLabel,
  type LayoutParams,
} from "../src/renderer/diagram-layout";
import {
  PASSING_CLEARANCE,
  absoluteArrowPoints,
  pointsToSegments,
  type Point,
  type Segment,
} from "../src/renderer/diagram-routes";
import { evaluateDiagramPlan } from "../src/renderer/diagram-quality";
import { THEMES } from "../src/renderer/diagram-theme";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";
import { planningDiagram, stressGraphs } from "./fixtures/diagram-gallery";

beforeAll(() => installExcalifontMeasurer());
afterAll(() => uninstallExcalifontMeasurer());

const ORIGIN = { x: 200, y: 200 };
const DIAGRAM_ID = "wd-test";

describe("diagram layout quality", () => {
  it.each(stressGraphs)("lays out $name without overlaps, shared ports, or collisions", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const report = evaluateDiagramPlan(plan);
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.sharedPorts).toEqual([]);
    expect(report.overlappingParallelSegments).toEqual([]);
    expect(report.crowdedPorts).toEqual([]);
    expect(report.offGrid).toEqual([]);
    expect(report.styleCoherence).toEqual([]);
    expect(report.containerContainment).toEqual([]);
    expect(report.containerIntrusion).toEqual([]);
    expect(report.edgesThroughContainers).toEqual([]);
  });

  it.each(stressGraphs)("produces complete, finite geometry for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    expect(plan.nodeCount).toBe(params.nodes.length);
    expect(plan.edgeCount).toBe(params.edges.length);
    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows).toHaveLength(params.edges.length);
    for (const arrow of arrows) {
      expect(arrow.start).toBeTruthy();
      expect(arrow.end).toBeTruthy();
      expect((arrow.points as number[][]).length).toBeGreaterThanOrEqual(2);
    }
    for (const skeleton of plan.skeletons) {
      for (const key of ["x", "y", "width", "height"] as const) {
        if (key in skeleton) expect(Number.isFinite(skeleton[key])).toBe(true);
      }
    }
  });

  it.each(stressGraphs)("labels every emitted element with a semantic role for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    for (const skeleton of plan.skeletons) {
      expect(plan.roles.get(String(skeleton.id))).toBeTruthy();
    }
    const counts = { node: 0, edge: 0, edgeLabel: 0, title: 0 };
    for (const entry of plan.roles.values()) {
      if (entry.role in counts) counts[entry.role as keyof typeof counts] += 1;
    }
    expect(counts.node).toBe(params.nodes.length);
    expect(counts.edge).toBe(params.edges.length);
    expect(counts.edgeLabel).toBe(plan.edgeLabelCount);
    expect(counts.title).toBe(params.title ? 1 : 0);
  });

  it.each(stressGraphs)("stamps derived ids and diagram customData on every element of $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    expect(plan.diagramId).toBe(DIAGRAM_ID);
    const ids = plan.skeletons.map((skeleton) => String(skeleton.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const skeleton of plan.skeletons) {
      const role = plan.roles.get(String(skeleton.id))!;
      expect(String(skeleton.id).startsWith(`${DIAGRAM_ID}-`)).toBe(true);
      expect(skeleton.customData).toEqual({
        wiley: {
          diagram: DIAGRAM_ID,
          role: role.role,
          theme: plan.theme,
          ...(role.key ? { key: role.key } : {}),
          ...(role.container ? { container: role.container } : {}),
        },
      });
    }
  });

  it.each(stressGraphs)("honours the requested layout algorithm for $name", async ({ params }) => {
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const requested = params.layout?.algorithm ?? "layered";
    expect(plan.layout).toMatchObject({ requested, used: requested });
    expect(plan.layout.reason).toBeUndefined();
  });

  it("exercises every layout algorithm across the gallery", () => {
    const used = new Set(stressGraphs.map(({ params }) => params.layout?.algorithm ?? "layered"));
    expect([...used].sort()).toEqual(["force", "layered", "radial", "stress", "tree"]);
  });

  it("exercises both label modes across the gallery", async () => {
    const modes = { bound: 0, standalone: 0 };
    for (const { params } of stressGraphs) {
      const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
      for (const entry of plan.roles.values()) {
        if (entry.role !== "edgeLabel") continue;
        if (entry.bound) modes.bound += 1;
        else modes.standalone += 1;
      }
    }
    expect(modes.bound).toBeGreaterThan(0);
    expect(modes.standalone).toBeGreaterThan(0);
  });

  it("exercises more than one theme across the gallery", () => {
    const themed = new Set(stressGraphs.map(({ params }) => params.theme).filter(Boolean));
    expect(themed.size).toBeGreaterThanOrEqual(3);
  });

  it("derives the same element ids for the same request", async () => {
    const first = await planDiagramLayout(planningDiagram, ORIGIN);
    const second = await planDiagramLayout(planningDiagram, ORIGIN, first.diagramId);
    expect(second.skeletons.map((skeleton) => skeleton.id))
      .toEqual(first.skeletons.map((skeleton) => skeleton.id));
  });

  it("fits every wrapped label line inside its node's usable width", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    const nodesById = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    for (const node of planningDiagram.nodes) {
      const skeleton = nodesById.get(plan.elementIdByNode.get(node.id)!);
      expect(skeleton).toBeTruthy();
      const factor = node.shape === "diamond" ? 2 : node.shape === "ellipse" ? Math.SQRT2 : 1;
      const usable = (skeleton!.width as number) / factor - 16;
      for (const line of wrapLabel(node.label)) {
        expect(measureText(line, 20).width).toBeLessThanOrEqual(usable);
      }
    }
  });

  it("grows a node's connector side with its edge degree on the axis edges attach to", () => {
    const quiet = nodeDimensions({ id: "a", label: "Hub" }, 1, "RIGHT");
    const busy = nodeDimensions({ id: "a", label: "Hub" }, 8, "RIGHT");
    expect(busy.height).toBeGreaterThan(quiet.height);
    expect(busy.height).toBeGreaterThanOrEqual(9 * 28);
    // DOWN layouts attach edges along the top and bottom, so width grows.
    const busyDown = nodeDimensions({ id: "a", label: "Hub" }, 8, "DOWN");
    expect(busyDown.width).toBeGreaterThanOrEqual(9 * 28);
    expect(busyDown.height).toBeLessThan(busy.height);
  });

  it("grows the same axis for a direction and its mirror", () => {
    const node = { id: "a", label: "Hub" };
    // LEFT mirrors RIGHT: connectors still land on the vertical sides.
    expect(nodeDimensions(node, 8, "LEFT")).toEqual(nodeDimensions(node, 8, "RIGHT"));
    // UP mirrors DOWN: connectors land on the horizontal sides.
    expect(nodeDimensions(node, 8, "UP")).toEqual(nodeDimensions(node, 8, "DOWN"));
    expect(nodeDimensions(node, 8, "UP").width).toBeGreaterThanOrEqual(9 * 28);
    expect(nodeDimensions(node, 8, "LEFT").height).toBeGreaterThanOrEqual(9 * 28);
  });

  it("lays LEFT and UP out along the axis they name", async () => {
    const chain = (direction: "RIGHT" | "LEFT" | "DOWN" | "UP") => planDiagramLayout({
      layout: { direction },
      nodes: [{ id: "a", label: "First" }, { id: "b", label: "Second" }],
      edges: [{ from: "a", to: "b" }],
    }, ORIGIN, DIAGRAM_ID);
    const at = (plan: Awaited<ReturnType<typeof chain>>, id: string) => {
      const skeleton = plan.skeletons.find((entry) => entry.id === plan.elementIdByNode.get(id))!;
      return { x: skeleton.x as number, y: skeleton.y as number };
    };
    const left = await chain("LEFT");
    expect(at(left, "b").x).toBeLessThan(at(left, "a").x);
    expect(at(left, "b").y).toBe(at(left, "a").y);
    const up = await chain("UP");
    expect(at(up, "b").y).toBeLessThan(at(up, "a").y);
    expect(at(up, "b").x).toBe(at(up, "a").x);
  });

  it("folds a flow that would otherwise come out as a ribbon", async () => {
    const chain = (count: number) => planDiagramLayout({
      layout: { algorithm: "layered", direction: "RIGHT" },
      nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, label: `Step ${index + 1}` })),
      edges: Array.from({ length: count - 1 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    }, ORIGIN, DIAGRAM_ID);
    const rows = (plan: Awaited<ReturnType<typeof chain>>) => new Set(
      [...plan.elementIdByNode.values()]
        .map((id) => plan.skeletons.find((skeleton) => skeleton.id === id)!.y),
    ).size;

    // Four boxes in a row is a drawing. Sixteen is a ribbon nobody can read
    // without scrolling, and it comes back on more than one row.
    expect(rows(await chain(4))).toBe(1);
    expect(rows(await chain(16))).toBeGreaterThan(1);
  });

  it("folds a long chain onto a serpentine grid with straight turns", async () => {
    const count = 12;
    const plan = await planDiagramLayout({
      layout: { algorithm: "layered", direction: "DOWN" },
      nodes: Array.from({ length: count }, (_, index) => ({ id: `n${index}`, label: `Step ${index + 1}` })),
      edges: Array.from({ length: count - 1 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    }, ORIGIN, DIAGRAM_ID);
    const box = (id: string) => plan.skeletons
      .find((skeleton) => skeleton.id === plan.elementIdByNode.get(id))!;
    const columns = [...new Set(Array.from({ length: count }, (_, index) => box(`n${index}`).x))];
    expect(columns.length).toBeGreaterThan(1);
    // A DOWN flow stacks its ranks on rows and folds them across columns, so
    // each column reads downwards and the next one reads back up.
    const columnOf = (id: string) => columns.indexOf(box(id).x as number);
    const rankInColumn = Array.from({ length: count }, (_, index) => index)
      .filter((index) => columnOf(`n${index}`) === columnOf("n0"));
    const descending = rankInColumn.every((index, at) => at === 0
      || (box(`n${index}`).y as number) > (box(`n${rankInColumn[at - 1]}`).y as number));
    expect(descending).toBe(true);

    // The turn is the whole point of the serpentine: the last box of a column
    // and the first of the next are neighbours, not opposite ends of the
    // board, so the connector between them is one straight run.
    const turns = Array.from({ length: count - 1 }, (_, index) => index)
      .filter((index) => columnOf(`n${index}`) !== columnOf(`n${index + 1}`));
    expect(turns.length).toBe(columns.length - 1);
    for (const index of turns) {
      const arrow = plan.skeletons.find((skeleton) => skeleton.type === "arrow"
        && (skeleton.start as { id: string }).id === plan.elementIdByNode.get(`n${index}`))!;
      expect((arrow.points as number[][]).length).toBe(2);
      expect(Math.abs(columnOf(`n${index + 1}`) - columnOf(`n${index}`))).toBe(1);
    }
    const report = evaluateDiagramPlan(plan);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.nodeOverlaps).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.crowdedPorts).toEqual([]);
  });

  it("places a folded chain identically on every run", async () => {
    const params: LayoutParams = {
      layout: { algorithm: "layered", direction: "RIGHT" },
      nodes: Array.from({ length: 14 }, (_, index) => ({ id: `n${index}`, label: `Stage ${index + 1}` })),
      edges: Array.from({ length: 13 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    };
    const first = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const second = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    expect(second.skeletons).toEqual(first.skeletons);
  });

  it("keeps a flow that loops back in the shape its direction asked for", async () => {
    // A serpentine grid has a lane for a step along the row and for the turn
    // into the row below, and for nothing else. This pipeline loops back three
    // ranks, and folded, that loop has to cut across the middle of the board
    // and cross whatever the grid put in its way. So it does not fold: the
    // ranks stay in the order the direction asked for and the loop runs back
    // along the outside, which is where a reader looks for one.
    const plan = await planDiagramLayout({
      title: "Ingest pipeline",
      layout: { algorithm: "layered", direction: "RIGHT" },
      nodes: [
        { id: "src", label: "Source APIs" },
        { id: "queue", label: "Kafka topic" },
        { id: "clean", label: "Normalise" },
        { id: "enrich", label: "Enrich" },
        { id: "valid", label: "Valid?", shape: "diamond" },
        { id: "dlq", label: "Dead letter" },
        { id: "load", label: "Load to warehouse" },
        { id: "dash", label: "Dashboards" },
      ],
      edges: [
        { from: "src", to: "queue" },
        { from: "queue", to: "clean" },
        { from: "clean", to: "enrich" },
        { from: "enrich", to: "valid" },
        { from: "valid", to: "load", label: "yes" },
        { from: "valid", to: "dlq", label: "no" },
        { from: "dlq", to: "clean", label: "replay", style: "dashed" },
        { from: "load", to: "dash" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const boxAt = (id: string) => plan.skeletons.find(
      (skeleton) => skeleton.id === plan.elementIdByNode.get(id),
    )!;
    // Every stage stands to the right of the one before it: the reading order
    // is the flow's own order, with nowhere for the eye to jump back to.
    const chain = ["src", "queue", "clean", "enrich", "valid", "load", "dash"];
    for (let index = 1; index < chain.length; index++) {
      expect(Number(boxAt(chain[index]).x)).toBeGreaterThan(Number(boxAt(chain[index - 1]).x));
    }
    for (const arrow of plan.skeletons.filter((skeleton) => skeleton.type === "arrow")) {
      expect(arrow.roundness).toBeUndefined();
    }
    // And no connector crosses another one anywhere on the board.
    const routes = plan.skeletons
      .filter((skeleton) => skeleton.type === "arrow")
      .map((arrow) => pointsToSegments(absoluteArrowPoints(arrow)));
    const crosses = (one: Segment, other: Segment): boolean => {
      const side = (p: Point, q: Point, r: Point) => Math.sign(
        (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x),
      );
      const [a, b] = [{ x: one.x1, y: one.y1 }, { x: one.x2, y: one.y2 }];
      const [c, d] = [{ x: other.x1, y: other.y1 }, { x: other.x2, y: other.y2 }];
      const [d1, d2, d3, d4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
      return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
    };
    for (let first = 0; first < routes.length; first++) {
      for (let second = first + 1; second < routes.length; second++) {
        for (const one of routes[first]) {
          for (const other of routes[second]) expect(crosses(one, other)).toBe(false);
        }
      }
    }
    const report = evaluateDiagramPlan(plan);
    expect(report.edgesThroughNodes).toEqual([]);
    expect(report.labelCollisions).toEqual([]);
    expect(report.nodeOverlaps).toEqual([]);
  });

  it.each(["force", "stress", "radial", "tree"] as const)(
    "places %s identically on every run",
    async (algorithm) => {
      const params: LayoutParams = {
        layout: { algorithm },
        nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index}`, label: `Node ${index + 1}` })),
        edges: [
          { from: "n0", to: "n1", label: "a" },
          { from: "n0", to: "n2" },
          { from: "n1", to: "n3", label: "b" },
          { from: "n1", to: "n4" },
          { from: "n2", to: "n5" },
          { from: "n2", to: "n6", label: "c" },
        ],
      };
      const first = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
      const second = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
      expect(second.skeletons).toEqual(first.skeletons);
      expect(second.layout).toEqual(first.layout);
    },
  );

  it("rings a star's spokes at even bearings", async () => {
    const spokes = 7;
    const plan = await planDiagramLayout({
      layout: { algorithm: "radial" },
      nodes: [
        { id: "hub", label: "Event bus" },
        ...Array.from({ length: spokes }, (_, index) => ({ id: `s${index}`, label: `Spoke ${index + 1}` })),
      ],
      edges: Array.from({ length: spokes }, (_, index) => ({ from: "hub", to: `s${index}` })),
    }, ORIGIN, DIAGRAM_ID);
    const centre = (id: string) => {
      const box = plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get(id))!;
      return {
        x: (box.x as number) + (box.width as number) / 2,
        y: (box.y as number) + (box.height as number) / 2,
      };
    };
    const hub = centre("hub");
    const bearings = Array.from({ length: spokes }, (_, index) => {
      const point = centre(`s${index}`);
      return (Math.atan2(point.y - hub.y, point.x - hub.x) * 180) / Math.PI;
    }).sort((a, b) => a - b);
    const gaps = bearings.map((bearing, index) => (index === 0
      ? bearing - bearings[bearings.length - 1] + 360
      : bearing - bearings[index - 1]));
    // Every spoke a turn of the circle apart, give or take the grid it snaps
    // to. Bunched angles are what left two corners of a hub board empty.
    for (const gap of gaps) expect(Math.abs(gap - 360 / spokes)).toBeLessThan(6);
    expect(evaluateDiagramPlan(plan).edgesThroughNodes).toEqual([]);
  });

  it("draws a star's centre with weight and leaves every spoke whole", async () => {
    const spokes = 7;
    const plan = await planDiagramLayout({
      layout: { algorithm: "radial" },
      nodes: [
        { id: "hub", label: "Event bus", role: "primary" },
        ...Array.from({ length: spokes }, (_, index) => ({ id: `s${index}`, label: `Spoke ${index + 1}` })),
      ],
      edges: Array.from({ length: spokes }, (_, index) => ({
        from: "hub",
        to: `s${index}`,
        label: "events",
      })),
    }, ORIGIN, DIAGRAM_ID);
    const box = (id: string) => plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get(id))!;
    const hub = box("hub");
    // A hub owes its spokes no room along one edge: they leave on bearings all
    // the way round it. Paying for it anyway drew a centre three times taller
    // than it was wide, which reads as a column rather than a hub.
    expect(hub.width as number).toBeGreaterThan(hub.height as number);
    for (let index = 0; index < spokes; index++) {
      const spoke = box(`s${index}`);
      expect((hub.width as number) * (hub.height as number))
        .toBeGreaterThan((spoke.width as number) * (spoke.height as number));
    }
    // Every caption stands beside its spoke. A bound one is seated in a gap cut
    // out of the line, and a board that does that to all seven has no spoke
    // drawn whole.
    for (const skeleton of plan.skeletons.filter((one) => one.type === "arrow")) {
      expect(skeleton.label).toBeUndefined();
    }
    expect(plan.skeletons.filter(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "edgeLabel",
    )).toHaveLength(spokes);
  });

  it("reports the direction an undirected algorithm ignored", async () => {
    const plan = await planDiagramLayout({
      layout: { algorithm: "force", direction: "UP" },
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    }, ORIGIN, DIAGRAM_ID);
    expect(plan.layout).toEqual({ requested: "force", used: "force", ignoredDirection: "UP" });
  });

  it("falls back to layered and says why when an algorithm refuses the graph", async () => {
    // radial only accepts a tree; a cycle is not one.
    const plan = await planDiagramLayout({
      layout: { algorithm: "radial" },
      nodes: Array.from({ length: 4 }, (_, index) => ({ id: `n${index}`, label: `Node ${index}` })),
      edges: [
        { from: "n0", to: "n1" },
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "n0" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    expect(plan.layout.requested).toBe("radial");
    expect(plan.layout.used).toBe("layered");
    expect(plan.layout.reason).toMatch(/radial/);
    expect(evaluateDiagramPlan(plan).edgesThroughNodes).toEqual([]);
  });

  it("bends a repaired route and marks it round so the hull check applies", async () => {
    const plan = await planDiagramLayout({
      layout: { algorithm: "stress" },
      nodes: Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, label: `Node ${index + 1}` })),
      edges: [
        { from: "n0", to: "n4" },
        { from: "n1", to: "n5" },
        { from: "n2", to: "n6" },
        { from: "n3", to: "n7" },
        { from: "n0", to: "n7" },
        { from: "n1", to: "n6" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    for (const arrow of arrows) {
      const points = arrow.points as number[][];
      // Every bent route carries roundness; every straight one does not.
      expect(Boolean(arrow.roundness)).toBe(points.length > 2);
    }
    expect(evaluateDiagramPlan(plan).edgesThroughNodes).toEqual([]);
  });

  it("rejects an algorithm outside the supported set", async () => {
    await expect(planDiagramLayout({
      layout: { algorithm: "spectral" as never },
      nodes: [{ id: "a", label: "A" }],
      edges: [],
    }, ORIGIN, DIAGRAM_ID)).rejects.toThrow(/algorithm/);
  });

  it("rejects a direction outside the supported set", async () => {
    await expect(planDiagramLayout({
      layout: { direction: "SIDEWAYS" as never },
      nodes: [{ id: "a", label: "A" }],
      edges: [],
    }, ORIGIN, DIAGRAM_ID)).rejects.toThrow(/direction/);
  });

  it("keeps the title clear of nodes, labels, and its own headroom band", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    const title = plan.skeletons.find(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "title",
    )!;
    expect(title).toBeTruthy();
    expect(title.textAlign).toBe("left");
    const nodeTops = plan.skeletons
      .filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node")
      .map((skeleton) => skeleton.y as number);
    // Full headroom band between the title and the top row of nodes.
    expect((title.y as number) + (title.height as number)).toBeLessThanOrEqual(Math.min(...nodeTops) - 40);
  });

  it("centres the title on the drawing rather than on the origin", async () => {
    // A tree hangs its apex in the middle, so a title pinned to the origin
    // ends up in the far corner with nothing under it.
    const plan = await planDiagramLayout({
      title: "Product org",
      layout: { algorithm: "tree", direction: "DOWN" },
      nodes: [
        { id: "root", label: "Chief executive" },
        ...Array.from({ length: 3 }, (_, index) => ({ id: `lead${index}`, label: `Lead ${index + 1}` })),
        ...Array.from({ length: 6 }, (_, index) => ({ id: `team${index}`, label: `Team ${index + 1}` })),
      ],
      edges: [
        ...Array.from({ length: 3 }, (_, index) => ({ from: "root", to: `lead${index}` })),
        ...Array.from({ length: 6 }, (_, index) => ({ from: `lead${Math.floor(index / 2)}`, to: `team${index}` })),
      ],
    }, ORIGIN, DIAGRAM_ID);
    const title = plan.skeletons.find(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "title",
    )!;
    const nodes = plan.skeletons.filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node");
    const left = Math.min(...nodes.map((skeleton) => skeleton.x as number));
    const right = Math.max(...nodes.map((skeleton) => (skeleton.x as number) + (skeleton.width as number)));
    const titleMiddle = (title.x as number) + (title.width as number) / 2;
    expect(Math.abs(titleMiddle - (left + right) / 2)).toBeLessThanOrEqual(MODEL_GRID_SIZE);
    expect(title.x as number).toBeGreaterThan(left);
  });

  it("measures the title's headroom against what stands under it", async () => {
    // A mind map's topmost ink is a leaf off in one corner, so a headroom band
    // measured against the whole board's top hangs the title a corner's height
    // clear of the branch it actually names.
    const plan = await planDiagramLayout({
      title: "Launch planning",
      layout: { algorithm: "tree", direction: "RIGHT" },
      nodes: [
        { id: "root", label: "Launch", shape: "ellipse" },
        { id: "market", label: "Positioning", rounded: true },
        { id: "product", label: "Product", rounded: true },
        { id: "ops", label: "Operations", rounded: true },
        { id: "story", label: "Story", shape: "text" },
        { id: "pricing", label: "Pricing", shape: "text" },
        { id: "beta", label: "Beta feedback", shape: "text" },
        { id: "docs", label: "Docs", shape: "text" },
        { id: "support", label: "Support rota", shape: "text" },
        { id: "billing", label: "Billing switch", shape: "text" },
      ],
      edges: [
        { from: "root", to: "market" },
        { from: "root", to: "product" },
        { from: "root", to: "ops" },
        { from: "market", to: "story" },
        { from: "market", to: "pricing" },
        { from: "product", to: "beta" },
        { from: "product", to: "docs" },
        { from: "ops", to: "support" },
        { from: "ops", to: "billing" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const title = plan.skeletons.find(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "title",
    )!;
    const titleBottom = (title.y as number) + (title.height as number);
    const titleLeft = title.x as number;
    const titleRight = titleLeft + (title.width as number);
    const nodes = plan.skeletons.filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "node");
    const under = nodes.filter((skeleton) => (skeleton.x as number) + (skeleton.width as number) >= titleLeft
      && (skeleton.x as number) <= titleRight);
    expect(under.length).toBeGreaterThan(0);
    const gap = Math.min(...under.map((skeleton) => skeleton.y as number)) - titleBottom;
    expect(gap).toBeGreaterThanOrEqual(40);
    expect(gap).toBeLessThanOrEqual(60 + MODEL_GRID_SIZE);
    // And still above every last thing on the board.
    expect(titleBottom).toBeLessThan(Math.min(...nodes.map((skeleton) => skeleton.y as number)));
  });

  it("measures with the real Excalifont, not the fallback estimate", () => {
    const wide = measureText("WWWW", 20).width;
    const narrow = measureText("iiii", 20).width;
    // The fallback estimate is width-per-character; the real font is not.
    expect(wide).not.toBeCloseTo(narrow, 5);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("styles nodes, edges, and the title from the requested theme", async () => {
    const plan = await planDiagramLayout({
      title: "Pipeline",
      theme: "ocean",
      nodes: [
        { id: "a", label: "Ingest", role: "primary" },
        { id: "b", label: "Archive", role: "muted", emphasis: "quiet" },
        { id: "c", label: "Alert", role: "danger", emphasis: "strong" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c", label: "on failure", style: "dashed", weight: "strong", color: "danger", arrow: "both" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const theme = THEMES.ocean;
    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const node = (id: string) => byId.get(plan.elementIdByNode.get(id)!)!;

    expect(node("a")).toMatchObject({
      backgroundColor: theme.entries.primary.fill,
      strokeColor: theme.entries.primary.stroke,
      strokeWidth: 1,
      opacity: 100,
      fillStyle: "solid",
      label: { text: "Ingest", strokeColor: "#1e1e1e" },
    });
    expect(node("b")).toMatchObject({ backgroundColor: theme.entries.muted.soft, opacity: 70 });
    expect(node("c")).toMatchObject({ backgroundColor: theme.entries.danger.fill, strokeWidth: 2 });

    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows[0]).toMatchObject({
      strokeColor: theme.edgeColor,
      strokeStyle: "solid",
      startArrowhead: null,
      endArrowhead: "arrow",
    });
    expect(arrows[1]).toMatchObject({
      strokeColor: theme.entries.danger.stroke,
      strokeStyle: "dashed",
      strokeWidth: 2,
      startArrowhead: "arrow",
      endArrowhead: "arrow",
    });
    const title = plan.skeletons.find((skeleton) => plan.roles.get(String(skeleton.id))?.role === "title")!;
    expect(title.strokeColor).toBe(theme.titleColor);
    expect(plan.theme).toBe("ocean");
    expect([...plan.explicitColors]).toEqual([]);
  });

  it("brings an unroled node into a board that is mostly coloured", async () => {
    const board = (roledCount: number) => planDiagramLayout({
      theme: "slate",
      nodes: Array.from({ length: 4 }, (_, index) => ({
        id: `n${index}`,
        label: `Stage ${index + 1}`,
        ...(index < roledCount ? { role: "primary" as const } : {}),
      })),
      edges: Array.from({ length: 3 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    }, ORIGIN, DIAGRAM_ID);
    const fill = (plan: Awaited<ReturnType<typeof board>>, id: string) =>
      plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get(id))!.backgroundColor;

    // Nothing is coloured, so nothing is: the unfilled look is the neutral
    // theme working as intended.
    expect(fill(await board(0), "n3")).toBe("transparent");
    // One filled box among four is the focal point the request asked for, and
    // the rest stay out of its way.
    expect(fill(await board(1), "n3")).toBe("transparent");
    // Once most of the board is coloured, a bare box reads as an oversight.
    expect(fill(await board(3), "n3")).toBe(THEMES.slate.entries.muted.fill);
  });

  it("keeps explicit colours and records them as deliberate", async () => {
    const plan = await planDiagramLayout({
      theme: "forest",
      nodes: [
        { id: "a", label: "Custom", role: "primary", backgroundColor: "#123456", strokeColor: "#654321" },
        { id: "b", label: "Themed", role: "primary" },
      ],
      edges: [{ from: "a", to: "b", color: "#abcdef" }],
    }, ORIGIN, DIAGRAM_ID);
    const node = plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get("a"))!;
    expect(node).toMatchObject({ backgroundColor: "#123456", strokeColor: "#654321" });
    // Dark override flips the bound label to paper so it stays readable.
    expect(node.label).toEqual({ text: "Custom", strokeColor: "#ffffff" });
    expect([...plan.explicitColors].sort()).toEqual(["#123456", "#654321", "#abcdef"]);
  });

  it("rejects role, emphasis, and edge styling values outside the vocabulary", async () => {
    const base = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] } as LayoutParams;
    await expect(planDiagramLayout(
      { ...base, nodes: [{ id: "a", label: "A", role: "chartreuse" as never }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/role/);
    await expect(planDiagramLayout(
      { ...base, edges: [{ from: "a", to: "b", weight: "heavy" as never }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/weight/);
    await expect(planDiagramLayout(
      { ...base, edges: [{ from: "a", to: "b", color: "puce" }] },
      ORIGIN,
      DIAGRAM_ID,
    )).rejects.toThrow(/colour/);
  });

  it("measures the room a bound label would sit in the way Excalidraw does", () => {
    // An even point count centres the label on the middle segment.
    const straight = [{ x: 0, y: 0 }, { x: 300, y: 0 }];
    expect(boundLabelAnchor(straight)).toEqual({ x: 150, y: 0 });
    expect(boundLabelRoom(straight)).toBe(300);
    const zigzag = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 400, y: 40 }];
    expect(boundLabelAnchor(zigzag)).toEqual({ x: 100, y: 20 });
    expect(boundLabelRoom(zigzag)).toBe(40);
    // An odd count centres it on the middle point, where the shorter of the
    // two neighbouring runs decides how much room there really is.
    const bent = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 30 }];
    expect(boundLabelAnchor(bent)).toEqual({ x: 200, y: 0 });
    expect(boundLabelRoom(bent)).toBe(60);
  });

  it("binds a label the route can carry and stands a long one beside it", async () => {
    const plan = await planDiagramLayout({
      // The layered engine widens a layer to fit an edge label, so the route
      // that cannot carry one is a straight run between fixed placements. On
      // a run this short only a caption of two or three characters leaves the
      // arrowhead room at each end.
      layout: { algorithm: "stress" },
      nodes: [
        { id: "a", label: "Source" },
        { id: "b", label: "Sink" },
        { id: "c", label: "Archive" },
      ],
      edges: [
        { from: "a", to: "b", label: "ok" },
        { from: "b", to: "c", label: "every accepted revision with its author and timestamp" },
      ],
    }, ORIGIN, DIAGRAM_ID);

    const arrows = plan.skeletons.filter((skeleton) => skeleton.type === "arrow");
    expect(arrows[0].label).toEqual({
      text: "ok",
      strokeColor: "#1e1e1e",
      fontSize: 16,
      fontFamily: 5,
    });
    expect(arrows[1].label).toBeUndefined();
    // The standalone label keeps its own element; the bound one keeps only an
    // identity, and both are counted.
    const standalone = plan.skeletons.filter(
      (skeleton) => plan.roles.get(String(skeleton.id))?.role === "edgeLabel",
    );
    expect(standalone).toHaveLength(1);
    expect(standalone[0].text).toBe("every accepted revision with its author and timestamp");
    expect(plan.edgeLabelCount).toBe(2);
    expect([...plan.roles.values()].filter((entry) => entry.bound)).toHaveLength(1);
  });

  it("honours an explicit label mode over what the route would choose", async () => {
    const params = (labelMode: "bound" | "standalone"): LayoutParams => ({
      nodes: [{ id: "a", label: "Source" }, { id: "b", label: "Sink" }],
      edges: [{
        from: "a",
        to: "b",
        label: "every accepted revision with its author and timestamp",
        labelMode,
      }],
    });
    const forcedBound = await planDiagramLayout(params("bound"), ORIGIN, DIAGRAM_ID);
    expect(forcedBound.skeletons.find((skeleton) => skeleton.type === "arrow")!.label)
      .toMatchObject({ text: "every accepted revision with its author and timestamp" });

    const forcedStandalone = await planDiagramLayout({
      nodes: [{ id: "a", label: "Source" }, { id: "b", label: "Sink" }],
      edges: [{ from: "a", to: "b", label: "hi", labelMode: "standalone" }],
    }, ORIGIN, DIAGRAM_ID);
    expect(forcedStandalone.skeletons.find((skeleton) => skeleton.type === "arrow")!.label)
      .toBeUndefined();
    expect(forcedStandalone.skeletons.some(
      (skeleton) => forcedStandalone.roles.get(String(skeleton.id))?.role === "edgeLabel",
    )).toBe(true);

    await expect(planDiagramLayout({
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", labelMode: "floating" as never }],
    }, ORIGIN, DIAGRAM_ID)).rejects.toThrow(/labelMode/);
  });

  it("nests members inside their container and groups them with it", async () => {
    const plan = await planDiagramLayout({
      theme: "ocean",
      containers: [
        { id: "edge", label: "Edge tier", role: "primary" },
        { id: "core", label: "Core services", role: "accent" },
      ],
      nodes: [
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "waf", label: "WAF", container: "edge" },
        { id: "api", label: "API", container: "core" },
        { id: "db", label: "Database", container: "core" },
        { id: "client", label: "Client" },
      ],
      edges: [
        { from: "client", to: "cdn" },
        { from: "cdn", to: "waf", label: "filter" },
        { from: "waf", to: "api", label: "proxy" },
      ],
    }, ORIGIN, DIAGRAM_ID);

    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const region = byId.get(plan.containers.get("edge")!.elementId)!;
    expect(region.type).toBe("rectangle");
    expect(region.backgroundColor).toBe(THEMES.ocean.entries.primary.soft);
    for (const nodeId of ["cdn", "waf"]) {
      const node = byId.get(plan.elementIdByNode.get(nodeId)!)!;
      expect(node.x as number).toBeGreaterThanOrEqual(region.x as number);
      expect(node.y as number).toBeGreaterThanOrEqual(region.y as number);
      expect((node.x as number) + (node.width as number))
        .toBeLessThanOrEqual((region.x as number) + (region.width as number));
      expect((node.y as number) + (node.height as number))
        .toBeLessThanOrEqual((region.y as number) + (region.height as number));
      expect(node.groupIds).toEqual(region.groupIds);
    }
    // The two regions are laid out side by side rather than on top of one
    // another, and the outsider stays out of both.
    const core = byId.get(plan.containers.get("core")!.elementId)!;
    expect((region.x as number) + (region.width as number)).toBeLessThan(core.x as number);
    const client = byId.get(plan.elementIdByNode.get("client")!)!;
    expect(client.groupIds).toBeUndefined();
    // An edge inside one region joins it; an edge across regions belongs to
    // neither.
    const edgeGroups = plan.skeletons
      .filter((skeleton) => plan.roles.get(String(skeleton.id))?.role === "edge")
      .map((skeleton) => skeleton.groupIds);
    expect(edgeGroups).toEqual([undefined, region.groupIds, undefined]);
    // The label sits in the container's top band, above its first member.
    const label = byId.get(`${DIAGRAM_ID}-cl-edge-${String(region.id).split("-c-edge-")[1]}`);
    expect(label?.text).toBe("Edge tier");
  });

  it("lines sibling regions up on the band they share", async () => {
    const plan = await planDiagramLayout({
      layout: { algorithm: "layered", direction: "RIGHT" },
      containers: [
        { id: "client", label: "Client" },
        { id: "edge", label: "Edge" },
        { id: "core", label: "Core" },
      ],
      nodes: [
        { id: "browser", label: "Browser", container: "client" },
        { id: "mobile", label: "Mobile app", container: "client" },
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "api", label: "API", container: "core" },
        { id: "token", label: "Token issuer", container: "core" },
        { id: "audit", label: "Audit log", container: "core" },
      ],
      edges: [
        { from: "browser", to: "cdn" },
        { from: "mobile", to: "cdn" },
        { from: "cdn", to: "api" },
        { from: "api", to: "token" },
        { from: "api", to: "audit" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const region = (id: string) => byId.get(plan.containers.get(id)!.elementId)!;
    const tops = ["client", "edge", "core"].map((id) => region(id).y);
    const bottoms = ["client", "edge", "core"]
      .map((id) => (region(id).y as number) + (region(id).height as number));
    // Three regions across one flow are a row, and a row has one top edge.
    expect(new Set(tops).size).toBe(1);
    expect(new Set(bottoms).size).toBe(1);
    // Growing to the band never swallows a member of another region.
    for (const [nodeId, owner] of [["browser", "client"], ["cdn", "edge"], ["audit", "core"]] as const) {
      const node = byId.get(plan.elementIdByNode.get(nodeId)!)!;
      const box = region(owner);
      expect(node.x as number).toBeGreaterThanOrEqual(box.x as number);
      expect((node.x as number) + (node.width as number))
        .toBeLessThanOrEqual((box.x as number) + (box.width as number));
    }
  });

  it("spaces a region's members like the rest of the board and keeps crossings clear", async () => {
    const nodeSpacing = 100;
    const plan = await planDiagramLayout({
      layout: { algorithm: "layered", direction: "RIGHT", nodeSpacing },
      containers: [
        { id: "client", label: "Client" },
        { id: "edge", label: "Edge" },
      ],
      nodes: [
        { id: "browser", label: "Browser", container: "client" },
        { id: "mobile", label: "Mobile app", container: "client" },
        { id: "cdn", label: "CDN", container: "edge" },
        { id: "gateway", label: "API gateway", container: "edge" },
      ],
      edges: [
        { from: "browser", to: "cdn" },
        // Skips a layer, so it has to pass whatever sits in the one between.
        { from: "mobile", to: "gateway" },
        { from: "cdn", to: "gateway" },
      ],
    }, ORIGIN, DIAGRAM_ID);
    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const node = (id: string) => byId.get(plan.elementIdByNode.get(id)!)!;
    // ELK does not hand a region the root's spacing on its own, and its own
    // default is a quarter of this. Members of a region are members of the
    // same board and stand the same distance apart.
    const browser = node("browser");
    const mobile = node("mobile");
    const gap = (mobile.y as number) - ((browser.y as number) + (browser.height as number));
    expect(gap).toBeGreaterThanOrEqual(nodeSpacing - MODEL_GRID_SIZE);
    // The default is 10px, which is what let a connector tuck under the box
    // it was passing and still read as going through it.
    expect(evaluateDiagramPlan(plan).edgesThroughNodes).toEqual([]);
    const cdn = node("cdn");
    const crossing = plan.skeletons.find((skeleton) => skeleton.type === "arrow"
      && (skeleton.start as { id: string }).id === plan.elementIdByNode.get("mobile")
      && (skeleton.end as { id: string }).id === plan.elementIdByNode.get("gateway"))!;
    const left = cdn.x as number;
    const right = left + (cdn.width as number);
    const top = cdn.y as number;
    const bottom = top + (cdn.height as number);
    const runs = pointsToSegments(absoluteArrowPoints(crossing));
    // Measured independently of the check itself: no part of the route that
    // lies across the box's width may sit within the halo above or below it.
    for (const run of runs.filter((one) => Math.max(one.x1, one.x2) > left && Math.min(one.x1, one.x2) < right)) {
      for (const y of [run.y1, run.y2]) {
        expect(y < top - PASSING_CLEARANCE || y > bottom + PASSING_CLEARANCE).toBe(true);
      }
    }
  });

  it("nests a container inside a container and reports the whole tree", async () => {
    const plan = await planDiagramLayout({
      containers: [
        { id: "cloud", label: "Cloud" },
        { id: "vpc", label: "VPC", parent: "cloud", role: "primary" },
      ],
      nodes: [
        { id: "dns", label: "DNS", container: "cloud" },
        { id: "app", label: "App server", container: "vpc" },
        { id: "cache", label: "Cache", container: "vpc" },
      ],
      edges: [
        { from: "dns", to: "app" },
        { from: "app", to: "cache" },
      ],
    }, ORIGIN, DIAGRAM_ID);

    const byId = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
    const cloud = byId.get(plan.containers.get("cloud")!.elementId)!;
    const vpc = byId.get(plan.containers.get("vpc")!.elementId)!;
    expect(plan.containers.get("vpc")!.parent).toBe("cloud");
    expect(vpc.x as number).toBeGreaterThan(cloud.x as number);
    expect((vpc.x as number) + (vpc.width as number))
      .toBeLessThanOrEqual((cloud.x as number) + (cloud.width as number));
    // Innermost group first, exactly the order Excalidraw nests them in.
    expect(byId.get(plan.elementIdByNode.get("app")!)!.groupIds).toEqual([
      ...(vpc.groupIds as string[]),
    ]);
    expect((vpc.groupIds as string[]).length).toBe(2);
    expect((cloud.groupIds as string[]).length).toBe(1);
    // The outer region is drawn before the inner one, so it sits behind it.
    const order = plan.skeletons.map((skeleton) => String(skeleton.id));
    expect(order.indexOf(String(cloud.id))).toBeLessThan(order.indexOf(String(vpc.id)));
  });

  it("emits a frame with explicit geometry and its members immediately in front", async () => {
    const plan = await planDiagramLayout({
      containers: [{ id: "board", label: "Sprint board", render: "frame" }],
      nodes: [
        { id: "todo", label: "To do", container: "board" },
        { id: "doing", label: "Doing", container: "board" },
        { id: "outside", label: "Backlog" },
      ],
      edges: [{ from: "outside", to: "todo" }, { from: "todo", to: "doing" }],
    }, ORIGIN, DIAGRAM_ID);

    const frame = plan.skeletons.find((skeleton) => skeleton.type === "frame")!;
    expect(frame.name).toBe("Sprint board");
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(typeof frame[key]).toBe("number");
      expect(frame[key]).not.toBe(0);
    }
    const memberIds = ["todo", "doing"].map((id) => plan.elementIdByNode.get(id)!);
    expect(frame.children).toEqual(memberIds);
    const order = plan.skeletons.map((skeleton) => String(skeleton.id));
    // The frame closes the array, directly behind the members it owns.
    expect(order.slice(-3)).toEqual([...memberIds, String(frame.id)]);
    // A frame owns its members through frameId, so it never groups them.
    for (const id of memberIds) {
      expect(plan.skeletons.find((skeleton) => skeleton.id === id)!.groupIds).toBeUndefined();
    }
    expect(plan.roles.get(String(frame.id))).toEqual({ role: "container", key: "board" });
  });

  it("falls back to layered and says why when containers meet an undirected algorithm", async () => {
    const plan = await planDiagramLayout({
      layout: { algorithm: "force" },
      containers: [{ id: "box", label: "Box" }],
      nodes: [{ id: "a", label: "A", container: "box" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b" }],
    }, ORIGIN, DIAGRAM_ID);
    expect(plan.layout).toEqual({
      requested: "force",
      used: "layered",
      reason: "force cannot lay out containers",
    });
  });

  it("rejects container declarations Excalidraw or the layout cannot honour", async () => {
    const nodes = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    const attempt = (containers: unknown, extra: Partial<LayoutParams> = {}) => planDiagramLayout(
      { nodes, edges: [], containers, ...extra } as LayoutParams,
      ORIGIN,
      DIAGRAM_ID,
    );

    await expect(attempt([{ id: "x" }, { id: "x" }])).rejects.toThrow(/declared twice/);
    await expect(attempt([{ id: "a" }])).rejects.toThrow(/collides with a node id/);
    await expect(attempt([{ id: "x", parent: "ghost" }])).rejects.toThrow(/unknown parent/);
    await expect(attempt([
      { id: "one" },
      { id: "two", parent: "one" },
      { id: "three", parent: "two" },
    ])).rejects.toThrow(/nests deeper than 2/);
    await expect(attempt([
      { id: "outer" },
      { id: "inner", parent: "outer", render: "frame" },
    ])).rejects.toThrow(/frame inside another container/);
    await expect(attempt([
      { id: "outer", render: "frame" },
      { id: "inner", parent: "outer" },
    ])).rejects.toThrow(/frame while holding another container/);
    await expect(attempt([{ id: "x", render: "panel" }])).rejects.toThrow(/render/);
    await expect(attempt([{ id: "x", role: "chartreuse" }])).rejects.toThrow(/role/);
    await expect(attempt(
      [{ id: "x" }],
      { nodes: [{ id: "a", label: "A", container: "ghost" }] },
    )).rejects.toThrow(/unknown container/);
  });

  it("emits a text node as a standalone text element with no box or bound label", async () => {
    const plan = await planDiagramLayout({
      theme: "grape",
      nodes: [
        { id: "note", label: "A standing caption that has to wrap across more than one line", shape: "text", role: "accent" },
        { id: "box", label: "Worker" },
      ],
      edges: [{ from: "note", to: "box" }],
    }, ORIGIN, DIAGRAM_ID);
    const note = plan.skeletons.find((skeleton) => skeleton.id === plan.elementIdByNode.get("note"))!;
    expect(note.type).toBe("text");
    expect(note.label).toBeUndefined();
    expect(note.backgroundColor).toBe("transparent");
    expect(note.strokeColor).toBe(THEMES.grape.entries.accent.stroke);
    expect(String(note.text).split("\n").length).toBeGreaterThan(1);
    // The measured block is the layout box, so the caption never overlaps.
    const lines = String(note.text).split("\n");
    const widest = Math.max(...lines.map((line) => measureText(line, 20).width));
    expect(note.width).toBe(Math.ceil(widest));
    expect(note.height).toBe(Math.ceil(lines.length * 20 * 1.3));
  });

  it("gives emoji a square tile advance in both measurement fallbacks", () => {
    const rocket = measureText("🚀", 20).width;
    // The fontkit measurer has no Excalifont glyph for an emoji and must not
    // fall back to the notdef advance of the first subset.
    expect(rocket).toBeCloseTo(24, 6);
    expect(measureText("🚀🚀", 20).width).toBeCloseTo(48, 6);

    uninstallExcalifontMeasurer();
    try {
      // The naive estimate has to agree; a canvas-less environment otherwise
      // sizes an emoji like an average letter.
      expect(measureText("🚀", 20).width).toBeCloseTo(24, 6);
      expect(measureText("aa", 20).width).toBeCloseTo(24.8, 6);
    } finally {
      installExcalifontMeasurer();
    }
  });

  it("sizes an emoji label wider than the same label without it", () => {
    expect(measureText("🚀 Ship", 20).width).toBeGreaterThan(measureText("Ship", 20).width + 20);
  });

  it("puts a text-shaped node back where the layout drew it after conversion", async () => {
    const params: LayoutParams = {
      layout: { algorithm: "tree", direction: "RIGHT" },
      nodes: [
        { id: "root", label: "Launch" },
        { id: "leaf", label: "Story", shape: "text" },
      ],
      edges: [{ from: "root", to: "leaf" }],
    };
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const leafId = plan.elementIdByNode.get("leaf")!;
    const skeleton = plan.skeletons.find((candidate) => candidate.id === leafId)!;
    const centre = (skeleton.y as number) + (skeleton.height as number) / 2;
    // What the converter hands back: it drags the bound caption onto the
    // arrow's far endpoint and re-measures the line box.
    const created = [{ id: leafId, type: "text", x: skeleton.x as number, y: -400, height: 25 }];
    restoreTextNodeGeometry(plan, created);
    expect(created[0].x).toBe(skeleton.x);
    expect(created[0].y + created[0].height / 2).toBeCloseTo(centre, 6);
  });

  it("stops an arrow short of a caption instead of landing on its first glyph", async () => {
    const params: LayoutParams = {
      layout: { algorithm: "tree", direction: "RIGHT" },
      nodes: [
        { id: "root", label: "Launch" },
        { id: "leaf", label: "Story", shape: "text" },
        { id: "boxed", label: "Docs" },
      ],
      edges: [{ from: "root", to: "leaf" }, { from: "root", to: "boxed" }],
    };
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const skeletonOf = (node: string) => plan.skeletons.find(
      (candidate) => candidate.id === plan.elementIdByNode.get(node),
    )!;
    const tipOf = (target: string) => {
      const arrow = plan.skeletons.find((skeleton) => skeleton.type === "arrow"
        && (skeleton.end as { id?: string }).id === plan.elementIdByNode.get(target))!;
      const points = arrow.points as number[][];
      return { x: (arrow.x as number) + points.at(-1)![0], y: (arrow.y as number) + points.at(-1)![1] };
    };
    const caption = skeletonOf("leaf");
    const tip = tipOf("leaf");
    const clearance = Math.hypot(
      Math.max(caption.x as number, tip.x) - tip.x,
      Math.max(caption.y as number, Math.min(tip.y, (caption.y as number) + (caption.height as number)))
        - tip.y,
    );
    // A diagonal approach spends part of the gap on the other axis, so the
    // clearance from the box is a shade under the gap along the route.
    expect(clearance).toBeGreaterThan(CAPTION_ENDPOINT_GAP * 0.6);
    expect(clearance).toBeLessThanOrEqual(CAPTION_ENDPOINT_GAP);
    // A boxed node has a border to meet, so it keeps the contact.
    const boxed = skeletonOf("boxed");
    expect(tipOf("boxed").x).toBeCloseTo(boxed.x as number, 6);
  });

  it("leaves elements that are not text nodes alone when restoring captions", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    const boxed = plan.skeletons.find((skeleton) => skeleton.type === "rectangle")!;
    const created = [{ id: String(boxed.id), type: "rectangle", x: 999, y: 999, height: 60 }];
    restoreTextNodeGeometry(plan, created);
    expect(created[0]).toMatchObject({ x: 999, y: 999 });
  });

  it("does not stretch a flow to make room for a label that rides its arrow", async () => {
    const chain = (labelled: boolean): LayoutParams => ({
      layout: { algorithm: "layered", direction: "DOWN" },
      nodes: ["one", "two", "three", "four"].map((id) => ({ id, label: id })),
      edges: [["one", "two"], ["two", "three"], ["three", "four"]].map(([from, to]) => ({
        from,
        to,
        ...(labelled ? { label: "yes" } : {}),
      })),
    });
    const heightOf = async (params: LayoutParams) => {
      const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
      const boxes = plan.skeletons.filter(
        (skeleton) => plan.roles.get(String(skeleton.id))?.role === "node",
      );
      const top = Math.min(...boxes.map((box) => box.y as number));
      const bottom = Math.max(...boxes.map((box) => (box.y as number) + (box.height as number)));
      return bottom - top;
    };
    const plain = await heightOf(chain(false));
    const labelled = await heightOf(chain(true));
    // A three-word label used to buy itself a whole extra layer per edge.
    expect(labelled).toBe(plain);
  });

  it("keeps a flow reading forwards when a feedback edge closes the loop", async () => {
    const params: LayoutParams = {
      layout: { algorithm: "layered", direction: "RIGHT" },
      nodes: [
        { id: "ingest", label: "Ingest" },
        { id: "clean", label: "Clean" },
        { id: "check", label: "Check", shape: "diamond" },
        { id: "load", label: "Load" },
      ],
      edges: [
        { from: "ingest", to: "clean" },
        { from: "clean", to: "check" },
        { from: "check", to: "load" },
        // The edge that closes the loop is declared last, the way the story is
        // told. Reversing an earlier one instead lays the flow out backwards.
        { from: "check", to: "clean", label: "retry" },
      ],
    };
    const plan = await planDiagramLayout(params, ORIGIN, DIAGRAM_ID);
    const xOf = (node: string) => {
      const skeleton = plan.skeletons.find(
        (candidate) => candidate.id === plan.elementIdByNode.get(node),
      );
      return skeleton!.x as number;
    };
    expect(xOf("ingest")).toBeLessThan(xOf("clean"));
    expect(xOf("clean")).toBeLessThan(xOf("check"));
    expect(xOf("check")).toBeLessThan(xOf("load"));
    // The feedback edge stays a short hop between neighbours instead of
    // wrapping the whole drawing.
    const retry = plan.skeletons.find((skeleton) => skeleton.type === "arrow"
      && (skeleton.start as { id?: string }).id === plan.elementIdByNode.get("check"))!;
    const span = Math.max(...(retry.points as number[][]).map(([x]) => Math.abs(x)));
    expect(span).toBeLessThan(xOf("load") - xOf("ingest"));
  });

  it("snaps node geometry to the hidden model grid", async () => {
    const plan = await planDiagramLayout(planningDiagram, ORIGIN, DIAGRAM_ID);
    for (const skeleton of plan.skeletons) {
      if (skeleton.type === "text" || skeleton.type === "arrow") continue;
      expect((skeleton.x as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.y as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.width as number) % MODEL_GRID_SIZE).toBe(0);
      expect((skeleton.height as number) % MODEL_GRID_SIZE).toBe(0);
    }
  });
});
