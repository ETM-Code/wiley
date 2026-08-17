/**
 * Evolving a diagram that is already on the board.
 *
 * A redraw under the same diagram id produces the same element ids for the
 * same graph, so an update is not a delete and a redraw: the survivors are the
 * very same elements, and they travel to their new places. What leaves fades
 * out first, the survivors move, and the new parts arrive last, which is the
 * order that reads as an edit rather than a flicker.
 */

import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { readDiagramStamp } from "../../shared/diagram-stamp";
import {
  guardFrameAutoFit,
  planBounds,
  planDiagramLayout,
  restoreTextNodeGeometry,
  snapModelCoordinate,
  translatePlan,
  type DiagramPlan,
  type LayoutParams,
  type PlanBounds,
} from "../diagram-layout";
import { planDiff, tweenGeometry, type DiffElement, type DiffGeometry } from "../diagram-diff";
import { evaluateConvertedScene, mergeQualityReports } from "../diagram-quality";
import type { Box } from "../diagram-routes";
import {
  assertDiagramQuality,
  assertQualityClearOfHuman,
  assertRenderedQuality,
  humanCollisionError,
  placementCollisions,
  QUALITY_EVALUATION_LIMIT,
} from "./diagram-render";
import { diagramElements, mergeSpec, reconstructSpec, resolveTargetDiagram } from "./diagram-reconstruct";
import { elementsBounds, finiteGeometry, PLACE_GAP } from "./geometry";
import { inferHumanGraph, type HumanGraph, type SketchElement } from "./human-graph";
import {
  canonicalHumanEdges,
  humanElementIdOf,
  humanNodeId,
  humanObstacles,
  materializeHumanNodes,
  planHumanEdges,
  splitHumanSpec,
  type HumanEdgeBinding,
} from "./human-merge";
import { pauseForStreaming, reportCanvasStreamProgress, shouldStreamCanvas } from "./streaming";
import type { SceneElement } from "./types";
import { isVisible, panIntoView } from "./viewport";

export type UpdateDiagramParams = Partial<LayoutParams> & {
  /** The diagram's own id, or the id of any element inside it. */
  diagram?: string;
  mode?: "replace" | "merge";
  keepPosition?: boolean;
};

/** Fade, travel, arrive: budgeted so the whole edit stays inside 1.6 seconds. */
const PRUNE_MS = 140;
const MOVE_MS = 420;
const MOVE_FRAMES = 14;
const ADD_BUDGET_MS = 700;

type Labelled = SceneElement & { containerId?: string | null; opacity?: number };

function boundLabelsOf(
  elements: readonly SceneElement[],
  owners: ReadonlySet<string>,
): SceneElement[] {
  return elements.filter((element) => {
    const candidate = element as Labelled;
    return candidate.type === "text"
      && typeof candidate.containerId === "string"
      && owners.has(candidate.containerId);
  });
}

function boundsOf(elements: readonly SceneElement[]): PlanBounds | null {
  return elementsBounds(finiteGeometry(elements));
}

function overlaps(a: PlanBounds, b: PlanBounds, margin: number): boolean {
  return a.minX < b.maxX + margin && b.minX < a.maxX + margin
    && a.minY < b.maxY + margin && b.minY < a.maxY + margin;
}

/**
 * Keeps the diagram's top-left where the user last saw it. A redraw that grew
 * into somebody else's work slides along whichever axis it grew on, far enough
 * to clear everything, and says by how much.
 */
export function placeUpdatedPlan(
  plan: DiagramPlan,
  previous: PlanBounds,
  foreign: readonly PlanBounds[],
): { dx: number; dy: number } | undefined {
  const content = planBounds(plan);
  translatePlan(
    plan,
    snapModelCoordinate(previous.minX - content.minX),
    snapModelCoordinate(previous.minY - content.minY),
  );
  const placed = planBounds(plan);
  const clashes = foreign.filter((box) => overlaps(placed, box, 0));
  if (clashes.length === 0) return undefined;
  // Grew wider than it grew taller, so it moves sideways; otherwise down.
  const horizontal = (placed.maxX - placed.minX) - (previous.maxX - previous.minX)
    >= (placed.maxY - placed.minY) - (previous.maxY - previous.minY);
  const shift = horizontal
    ? Math.max(...clashes.map((box) => box.maxX - placed.minX))
    : Math.max(...clashes.map((box) => box.maxY - placed.minY));
  const delta = snapModelCoordinate(shift + PLACE_GAP);
  const dx = horizontal ? delta : 0;
  const dy = horizontal ? 0 : delta;
  translatePlan(plan, dx, dy);
  return { dx, dy };
}

/** Where every agent node ended up, keyed the way the spec names it. */
function agentNodeBoxes(plan: DiagramPlan): Map<string, Box> {
  const skeletonById = new Map(plan.skeletons.map((skeleton) => [String(skeleton.id), skeleton]));
  const boxes = new Map<string, Box>();
  for (const [nodeId, elementId] of plan.elementIdByNode) {
    const skeleton = skeletonById.get(elementId);
    if (!skeleton) continue;
    boxes.set(nodeId, {
      id: nodeId,
      x: Number(skeleton.x ?? 0),
      y: Number(skeleton.y ?? 0),
      width: Number(skeleton.width ?? 0),
      height: Number(skeleton.height ?? 0),
    });
  }
  return boxes;
}

/** Every shape of the person's, as a box a route has to stay out of. */
export function humanSketchBoxes(graph: HumanGraph): Map<string, Box> {
  return new Map(graph.nodes.map((node) => [humanNodeId(node.elementId), {
    id: humanNodeId(node.elementId),
    x: node.bounds.x,
    y: node.bounds.y,
    width: node.bounds.width,
    height: node.bounds.height,
  }]));
}

/**
 * Records the connecting arrows on the person's own elements, and takes off
 * the record of any that this update removed. Nothing else about their
 * element is touched, and the whole thing is idempotent, so replaying it on
 * every animation frame cannot stack duplicate entries.
 */
export function withHumanBindings(
  elements: readonly SceneElement[],
  additions: ReadonlyMap<string, string[]>,
  departed: ReadonlySet<string> = new Set(),
): SceneElement[] {
  if (additions.size === 0 && departed.size === 0) return [...elements];
  return elements.map((element) => {
    const bound = (element as SceneElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
    }).boundElements ?? [];
    const kept = bound.filter((entry) => !departed.has(entry?.id));
    const missing = (additions.get(element.id) ?? [])
      .filter((id) => !kept.some((entry) => entry?.id === id))
      .map((id) => ({ id, type: "arrow" as const }));
    if (missing.length === 0 && kept.length === bound.length) return element;
    // Excalidraw reconciles by version, so an edit that does not bump it can
    // be dropped, leaving an arrow bound to a shape with no record of it.
    return {
      ...element,
      boundElements: [...kept, ...missing],
      version: (element as SceneElement & { version: number }).version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as SceneElement;
  });
}

/**
 * The converter can only bind an arrow to an element in its own batch, and a
 * shape the person drew is not in the batch. Its end of the arrow is written
 * on afterwards, the same way connect_shapes does it.
 */
export function bindHumanEndpoints(
  created: readonly SceneElement[],
  bindings: readonly HumanEdgeBinding[],
): void {
  if (bindings.length === 0) return;
  const byId = new Map(created.map((element) => [element.id, element]));
  for (const binding of bindings) {
    const arrow = byId.get(binding.arrowId);
    if (!arrow) continue;
    if (binding.startElementId) {
      Object.assign(arrow, { startBinding: { elementId: binding.startElementId, focus: 0, gap: 4 } });
    }
    if (binding.endElementId) {
      Object.assign(arrow, { endBinding: { elementId: binding.endElementId, focus: 0, gap: 4 } });
    }
  }
}

function withGeometry(element: SceneElement, geometry: DiffGeometry): SceneElement {
  return {
    ...element,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    ...(geometry.points ? { points: geometry.points } : {}),
  } as SceneElement;
}

export async function updateDiagram(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as UpdateDiagramParams;
  const scene = [...api.getSceneElements()];
  const diagramId = resolveTargetDiagram(scene, params.diagram);
  const owned = diagramElements(scene, diagramId);
  const ownedIds = new Set(owned.map((element) => element.id));
  const before = [...owned, ...boundLabelsOf(scene, ownedIds)];
  const beforeIds = new Set(before.map((element) => element.id));

  const requested: Partial<LayoutParams> = {
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.theme !== undefined ? { theme: params.theme } : {}),
    ...(params.layout !== undefined ? { layout: params.layout } : {}),
    ...(params.nodes ? { nodes: params.nodes } : {}),
    ...(params.edges ? { edges: params.edges } : {}),
    ...(params.containers ? { containers: params.containers } : {}),
  };
  // The person's sketch is read fresh every time: a request may name one of
  // their boxes by id, and an arrow this diagram already runs into the sketch
  // only reconstructs as an edge while the reading is to hand.
  const sketch = inferHumanGraph(scene as unknown as SketchElement[]);
  const existing = reconstructSpec(scene, diagramId, { human: sketch });
  // Endpoints are spelled the one way before anything matches on them: an
  // edge reconstructed as `human:abc` and one requested as `abc` are the same
  // edge, and merging them as two would draw the connection twice.
  const declared = new Set([
    ...existing.nodes.map((node) => node.id),
    ...(requested.nodes ?? []).map((node) => node.id),
  ]);
  const asked: Partial<LayoutParams> = {
    ...requested,
    ...(requested.edges ? { edges: canonicalHumanEdges(requested.edges, sketch, declared) } : {}),
  };
  const merged = params.mode === "merge"
    ? mergeSpec(existing, asked)
    : {
        ...asked,
        nodes: asked.nodes ?? [],
        edges: asked.edges ?? [],
      } as LayoutParams;
  const spec = materializeHumanNodes(merged, sketch);
  const split = splitHumanSpec(spec);

  const plan = await planDiagramLayout(split.agentSpec, { x: 0, y: 0 }, diagramId);
  const previous = boundsOf(before) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const foreignElements = finiteGeometry(scene.filter((element) => !beforeIds.has(element.id)));
  const foreignBoxes = foreignElements.map((element) => ({
    minX: element.x,
    minY: element.y,
    maxX: element.x + element.width,
    maxY: element.y + element.height,
  }));
  const placedFirst = params.keepPosition === false
    ? undefined
    : placeUpdatedPlan(plan, previous, foreignBoxes);

  // The person's boxes and captions are regions this diagram has to respect,
  // minus the ones it is deliberately attached to: an arrow reaching a shape
  // has to be allowed to touch it.
  const attached = new Set(split.crossEdges.flatMap(({ edge }) => [
    humanElementIdOf(edge.from),
    humanElementIdOf(edge.to),
  ]).filter((id): id is string => Boolean(id)));
  // A frame the person drew around the target has to be crossed to reach it,
  // so treating it as forbidden would make every framed shape unreachable and
  // no shift could ever fix it.
  for (const node of sketch.nodes) {
    if (node.encloses?.some((id) => attached.has(id))) attached.add(node.elementId);
  }
  // A caption bound to an attached shape lives inside it and is exempt with it.
  for (const element of scene as Labelled[]) {
    if (typeof element.containerId === "string" && attached.has(element.containerId)) {
      attached.add(element.id);
    }
  }
  const obstacles = humanObstacles(scene as unknown as SketchElement[])
    .filter((obstacle) => !attached.has(obstacle.id));
  const placed = planBounds(plan);
  // It slides on along whichever axis it grew on, the same axis placeUpdatedPlan
  // would have used.
  const grewWide = (placed.maxX - placed.minX) - (previous.maxX - previous.minX)
    >= (placed.maxY - placed.minY) - (previous.maxY - previous.minY);
  // Clearing the sketch has to settle before the connecting arrows are drawn:
  // an arrow bound to somebody's element cannot be translated afterwards.
  const cleared = assertQualityClearOfHuman(
    plan,
    obstacles,
    grewWide ? "right" : "below",
    foreignBoxes,
  );
  const shifted = placedFirst || cleared.shifted
    ? {
        dx: (placedFirst?.dx ?? 0) + (cleared.shifted?.dx ?? 0),
        dy: (placedFirst?.dy ?? 0) + (cleared.shifted?.dy ?? 0),
      }
    : undefined;
  // Only after the last translate: a frame nudged off zero and then slid back
  // onto it by a clearing shift would hand itself to the converter's auto-fit.
  guardFrameAutoFit(plan);

  // The connecting arrows come last, because the sketch sits at absolute
  // coordinates the layout never had a say over: only once the plan is
  // finally placed do both ends of such an arrow exist in the same space.
  const sketchBoxes = humanSketchBoxes(sketch);
  // Everything else with a real footprint: the person's other shapes and any
  // other diagram already on the board, so a connecting arrow reaching into
  // the sketch does not cut straight through somebody else's work.
  const otherWork = finiteGeometry(scene.filter((element) => !beforeIds.has(element.id)
    && !sketchBoxes.has(humanNodeId(element.id))
    && element.type !== "arrow"
    && element.type !== "line"
    && element.type !== "freedraw"))
    .map((element) => ({
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    }));
  const humanEdges = planHumanEdges(plan, split.crossEdges, {
    agentBoxes: agentNodeBoxes(plan),
    humanBoxes: new Map([...split.humanNodes.keys()]
      .map((id) => [id, sketchBoxes.get(id)])
      .filter((entry): entry is [string, Box] => Boolean(entry[1]))),
    // A frame the arrow has to enter is not something to route around.
    blockers: [...sketchBoxes.values(), ...otherWork]
      .filter((box) => !attached.has(box.id) && !attached.has(humanElementIdOf(box.id) ?? box.id)),
  });
  plan.skeletons.push(...humanEdges.skeletons);
  const boundAdditions = new Map<string, string[]>();
  for (const binding of humanEdges.bindings) {
    for (const elementId of [binding.startElementId, binding.endElementId]) {
      if (!elementId) continue;
      boundAdditions.set(elementId, [...(boundAdditions.get(elementId) ?? []), binding.arrowId]);
    }
  }
  const quality = assertDiagramQuality(plan, obstacles);
  // The connecting arrows were routed around the sketch, so anything of the
  // person's they still land on is a real problem rather than one a shift
  // could have solved, and the plan can no longer move: it is bound to them.
  const landed = quality ? placementCollisions(quality) : [];
  if (landed.length > 0) throw humanCollisionError(landed);

  const claimed = new Set(plan.skeletons.map((skeleton) => String(skeleton.id)));
  const collisions = scene.filter((element) => claimed.has(element.id)
    && !beforeIds.has(element.id)
    && readDiagramStamp(element)?.diagram !== diagramId);
  if (collisions.length > 0) {
    const sample = collisions.slice(0, 3).map((element) => element.id).join(", ");
    throw new Error(`Diagram id collision: ${sample} already on the board outside this diagram`);
  }

  const created = convertToExcalidrawElements(
    plan.skeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
  if (created.some((element) => !Number.isFinite(element.x) || !Number.isFinite(element.y)
    || !Number.isFinite(element.width) || !Number.isFinite(element.height))) {
    throw new Error("Diagram layout produced invalid element geometry");
  }
  restoreTextNodeGeometry(plan, created as unknown as Parameters<typeof restoreTextNodeGeometry>[1]);
  bindHumanEndpoints(created as unknown as SceneElement[], humanEdges.bindings);
  const diff = planDiff(scene as unknown as DiffElement[], plan);
  const rendered = quality && created.length <= QUALITY_EVALUATION_LIMIT
    ? mergeQualityReports(
        quality,
        evaluateConvertedScene(created as unknown as Parameters<typeof evaluateConvertedScene>[0], plan),
      )
    : quality;
  if (rendered) assertRenderedQuality(rendered);

  const createdIds = new Set(created.map((element) => element.id));
  // Always rebased on the live scene: the human may be drawing while this runs.
  const foreignScene = () => withHumanBindings(
    [...api.getSceneElements()].filter(
      (element) => !beforeIds.has(element.id) && !createdIds.has(element.id),
    ),
    boundAdditions,
    new Set(diff.removals),
  );
  const foreignCount = foreignScene().length;
  const moved = diff.survivors.filter((survivor) => survivor.from.x !== survivor.to.x
    || survivor.from.y !== survivor.to.y
    || survivor.from.width !== survivor.to.width
    || survivor.from.height !== survivor.to.height);
  const result = {
    diagramId,
    layout: plan.layout,
    counts: {
      added: diff.additions.length,
      removed: diff.removals.length,
      moved: moved.length,
      relabeled: diff.relabels.length,
    },
    ...(rendered ? { quality: rendered } : {}),
    ...(shifted ? { shifted } : {}),
  };

  /**
   * An update never refits the view. The diagram is already on the board and
   * the person is already looking at whatever they chose to look at; zooming
   * the board out to frame an edit is how a small change came to feel like
   * the whole drawing moving. The one exception is an edit the person cannot
   * see at all, and even then the view only slides: the scale they picked is
   * theirs to keep.
   */
  const showIfHidden = async () => {
    const bounds = boundsOf(created as unknown as SceneElement[]);
    if (!bounds || isVisible(api, bounds)) return;
    await panIntoView(api, created as unknown as SceneElement[]);
  };

  const applyFinalScene = async () => {
    api.updateScene({
      elements: [...foreignScene(), ...created],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    reportCanvasStreamProgress(created.length, created.length);
    await showIfHidden();
    return result;
  };
  if (!shouldStreamCanvas()) return applyFinalScene();

  const survivorIds = new Set(diff.survivors.map((survivor) => survivor.id));
  const removalIds = new Set(diff.removals);
  const labelOwner = new Map<string, string>();
  for (const element of before as Labelled[]) {
    if (element.type === "text" && typeof element.containerId === "string") {
      labelOwner.set(element.id, element.containerId);
    }
  }
  const staying = before.filter((element) => survivorIds.has(element.id)
    || survivorIds.has(labelOwner.get(element.id) ?? ""));
  const leaving = before.filter((element) => removalIds.has(element.id));
  const paint = (elements: readonly SceneElement[], capture: (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction]) => {
    api.updateScene({ elements: [...foreignScene(), ...elements], captureUpdate: capture });
  };
  /** A hand-drawn arrival or deletion mid-tween ends the animation early. */
  const disturbed = () => foreignScene().length !== foreignCount;

  reportCanvasStreamProgress(0, created.length);
  for (const opacity of [60, 25]) {
    if (leaving.length === 0 || disturbed()) break;
    paint(
      [...staying, ...leaving.map((element) => ({ ...element, opacity } as SceneElement))],
      CaptureUpdateAction.EVENTUALLY,
    );
    await pauseForStreaming(PRUNE_MS / 2);
  }

  const geometryById = new Map(diff.survivors.map((survivor) => [survivor.id, survivor]));
  const labelDelta = (ownerId: string, progress: number) => {
    const survivor = geometryById.get(ownerId);
    if (!survivor) return { dx: 0, dy: 0 };
    const now = tweenGeometry(survivor.from, survivor.to, progress);
    return { dx: now.x - survivor.from.x, dy: now.y - survivor.from.y };
  };
  for (let frame = 1; frame <= MOVE_FRAMES && moved.length > 0; frame++) {
    if (disturbed()) return applyFinalScene();
    const progress = frame / MOVE_FRAMES;
    paint(staying.map((element) => {
      const survivor = geometryById.get(element.id);
      // Bindings are never touched mid-tween; only geometry moves.
      if (survivor) return withGeometry(element, tweenGeometry(survivor.from, survivor.to, progress));
      const owner = labelOwner.get(element.id);
      if (!owner) return element;
      const { dx, dy } = labelDelta(owner, progress);
      return { ...element, x: element.x + dx, y: element.y + dy } as SceneElement;
    }), CaptureUpdateAction.EVENTUALLY);
    await pauseForStreaming(MOVE_MS / MOVE_FRAMES);
  }

  const settled = created.filter((element) => survivorIds.has(element.id)
    || survivorIds.has((element as Labelled).containerId ?? ""));
  const additions = created.filter((element) => !settled.includes(element));
  const arriving = additions.filter((element) => element.type !== "arrow"
    && !(element.type === "text" && typeof (element as Labelled).containerId === "string"
      && created.some((owner) => owner.id === (element as Labelled).containerId && owner.type === "arrow")));
  const connecting = additions.filter((element) => !arriving.includes(element));
  const groups = arriving.map((element) => [
    element,
    ...created.filter((label) => (label as Labelled).containerId === element.id),
  ].filter((entry, index, all) => all.indexOf(entry) === index));

  const shown = [...settled];
  const step = Math.max(40, Math.round(ADD_BUDGET_MS / Math.max(1, groups.length + 1)));
  for (const group of groups) {
    if (disturbed()) return applyFinalScene();
    for (const element of group) if (!shown.includes(element)) shown.push(element);
    paint(shown, CaptureUpdateAction.EVENTUALLY);
    reportCanvasStreamProgress(shown.length, created.length);
    await pauseForStreaming(step);
  }
  if (connecting.length > 0 && !disturbed()) {
    paint([...shown, ...connecting], CaptureUpdateAction.EVENTUALLY);
    await pauseForStreaming(step);
  }

  return applyFinalScene();
}
