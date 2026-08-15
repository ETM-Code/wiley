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
  snapModelCoordinate,
  translatePlan,
  type DiagramPlan,
  type LayoutParams,
  type PlanBounds,
} from "../diagram-layout";
import { planDiff, tweenGeometry, type DiffElement, type DiffGeometry } from "../diagram-diff";
import { evaluateConvertedScene, mergeQualityReports } from "../diagram-quality";
import { assertDiagramQuality, QUALITY_EVALUATION_LIMIT } from "./diagram-render";
import { diagramElements, mergeSpec, reconstructSpec, resolveTargetDiagram } from "./diagram-reconstruct";
import { elementsBounds, finiteGeometry, PLACE_GAP } from "./geometry";
import { pauseForStreaming, reportCanvasStreamProgress, shouldStreamCanvas } from "./streaming";
import type { SceneElement } from "./types";

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
  const spec = params.mode === "merge"
    ? mergeSpec(reconstructSpec(scene, diagramId), requested)
    : {
        ...requested,
        nodes: requested.nodes ?? [],
        edges: requested.edges ?? [],
      } as LayoutParams;

  const plan = await planDiagramLayout(spec, { x: 0, y: 0 }, diagramId);
  const previous = boundsOf(before) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const foreignElements = finiteGeometry(scene.filter((element) => !beforeIds.has(element.id)));
  const shifted = params.keepPosition === false
    ? undefined
    : placeUpdatedPlan(
        plan,
        previous,
        foreignElements.map((element) => ({
          minX: element.x,
          minY: element.y,
          maxX: element.x + element.width,
          maxY: element.y + element.height,
        })),
      );
  guardFrameAutoFit(plan);
  const quality = assertDiagramQuality(plan);

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
  const diff = planDiff(scene as unknown as DiffElement[], plan);
  const rendered = quality && created.length <= QUALITY_EVALUATION_LIMIT
    ? mergeQualityReports(
        quality,
        evaluateConvertedScene(created as unknown as Parameters<typeof evaluateConvertedScene>[0], plan),
      )
    : quality;

  const createdIds = new Set(created.map((element) => element.id));
  // Always rebased on the live scene: the human may be drawing while this runs.
  const foreignScene = () => [...api.getSceneElements()].filter(
    (element) => !beforeIds.has(element.id) && !createdIds.has(element.id),
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

  const applyFinalScene = async () => {
    api.updateScene({
      elements: [...foreignScene(), ...created],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    reportCanvasStreamProgress(created.length, created.length);
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
