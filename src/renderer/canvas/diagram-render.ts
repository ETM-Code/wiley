import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  finiteNumber as finite,
  nodeToType,
  planBounds,
  planDiagramLayout,
  snapModelCoordinate,
  snapModelSize,
  translatePlan,
  type DiagramPlan,
  type LayoutParams,
} from "../diagram-layout";
import { evaluateDiagramPlan, type DiagramQualityReport } from "../diagram-quality";
import { readDiagramStamp } from "../../shared/diagram-stamp";
import { deriveDiagramId, titleElementId } from "../diagram-spec";
import { asRecord, gridResult, resolveDiagramOrigin } from "./geometry";
import {
  diagramPreviewElementIds,
  diagramPreviewStream,
  diagramPreviewVersions,
  reportDiagramPreviewProgress,
  withoutDiagramPreviewElements,
} from "./preview-state";
import { pauseForStreaming, reportCanvasStreamProgress, shouldStreamCanvas } from "./streaming";
import type { SceneElement } from "./types";

type ShapeParams = {
  shape: "rectangle" | "ellipse" | "diamond";
  width?: number;
  height?: number;
  label?: string;
  strokeColor?: string;
  backgroundColor?: string;
};

export async function addShape(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as ShapeParams;
  if (!["rectangle", "ellipse", "diamond"].includes(params?.shape)) {
    throw new Error("add-shape requires rectangle, ellipse, or diamond");
  }
  const width = Math.min(800, snapModelSize(params.width, 220));
  const height = Math.min(800, snapModelSize(params.height, width));
  const state = api.getAppState();
  const center = viewportCoordsToSceneCoords(
    { clientX: state.width / 2, clientY: state.height / 2 },
    state,
  );
  const skeleton = {
    id: `agent-shape-${crypto.randomUUID()}`,
    type: params.shape,
    x: snapModelCoordinate(center.x - width / 2),
    y: snapModelCoordinate(center.y - height / 2),
    width,
    height,
    strokeColor: params.strokeColor ?? "#1e1e1e",
    backgroundColor: params.backgroundColor ?? "transparent",
    ...(params.label?.trim() ? { label: { text: params.label.trim() } } : {}),
  };
  const created = convertToExcalidrawElements(
    [skeleton] as Parameters<typeof convertToExcalidrawElements>[0],
  );
  if (created.some((element) => !Number.isFinite(element.x) || !Number.isFinite(element.y)
    || !Number.isFinite(element.width) || !Number.isFinite(element.height))) {
    throw new Error("Diagram layout produced invalid element geometry");
  }
  api.updateScene({
    elements: [...api.getSceneElements(), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return {
    count: created.length,
    ids: created.map((element) => element.id),
    center: { x: skeleton.x + width / 2, y: skeleton.y + height / 2 },
    grid: gridResult(),
  };
}

/**
 * Above this the checks cost more than they are worth: they are quadratic in
 * element count and the agent is not going to redraw a 200-element diagram
 * over a crowded port anyway.
 */
export const QUALITY_EVALUATION_LIMIT = 120;

/**
 * The last gate before a diagram reaches the board.
 *
 * Everything in the report is worth telling the agent about, but only two
 * findings mean the picture is actually wrong: boxes on top of each other and
 * an arrow driven through a box it does not belong to. Both survive the
 * repair pass only when something upstream is broken, so they fail the call
 * rather than shipping a diagram the user has to squint at.
 */
export function assertDiagramQuality(plan: DiagramPlan): DiagramQualityReport | undefined {
  if (plan.skeletons.length > QUALITY_EVALUATION_LIMIT) return undefined;
  const quality = evaluateDiagramPlan(plan);
  const defects = [...quality.nodeOverlaps, ...quality.edgesThroughNodes];
  if (defects.length > 0) {
    throw new Error(`Diagram quality check failed: ${defects.slice(0, 3).join("; ")}`);
  }
  return quality;
}

/** Monotonic even when two diagrams are requested within the same millisecond. */
let lastDiagramSeed = 0;

function nextDiagramSeed(): number {
  lastDiagramSeed = Math.max(Date.now(), lastDiagramSeed + 1);
  return lastDiagramSeed;
}

export async function layoutDiagram(api: ExcalidrawImperativeAPI, value: unknown, preview = false) {
  const params = value as LayoutParams;
  const previewVersion = finite(asRecord(value).__previewVersion, 0);
  if (preview) {
    if (previewVersion <= diagramPreviewVersions.latest) return { stale: true };
    diagramPreviewVersions.latest = previewVersion;
  } else if (previewVersion > diagramPreviewVersions.latest) {
    diagramPreviewVersions.latest = previewVersion;
  }
  const hadPreview = diagramPreviewElementIds.size > 0;
  const previousPreviewIds = new Set(diagramPreviewElementIds);
  // A streaming preview claims one diagram id and every later frame, plus
  // the final commit, reuses it: same ids, so updateScene replaces the
  // provisional elements in place instead of stacking copies.
  const diagramId = diagramPreviewStream.diagramId ?? deriveDiagramId(params, nextDiagramSeed());
  if (preview) diagramPreviewStream.diagramId = diagramId;
  // Plan at the origin first: above/left placement needs the diagram's own
  // bounds before an anchor-relative position can be chosen.
  const plan = await planDiagramLayout(params, { x: 0, y: 0 }, diagramId);
  const origin = resolveDiagramOrigin(
    api,
    params.anchor,
    params.anchorDirection ?? "right",
    planBounds(plan),
    withoutDiagramPreviewElements([...api.getSceneElements()]),
  );
  translatePlan(plan, origin.x, origin.y);
  // Previews are redrawn on every JSON delta and are throwaway by design, so
  // they never pay for the checks.
  const quality = preview ? undefined : assertDiagramQuality(plan);
  const title = params.title?.trim();

  // Derived ids are only safe while nothing else owns them. The converter
  // drops a duplicate id with nothing but a console error, so a foreign
  // element sitting on one of these ids has to fail the request loudly.
  const expectedIds = plan.skeletons.map((skeleton) => String(skeleton.id));
  const claimed = new Set(expectedIds);
  const foreign = [...api.getSceneElements()].filter((element) => claimed.has(element.id)
    && !previousPreviewIds.has(element.id)
    && readDiagramStamp(element)?.diagram !== diagramId);
  if (foreign.length > 0) {
    const sample = foreign.slice(0, 3).map((element) => element.id).join(", ");
    throw new Error(`Diagram id collision: ${sample} already on the board outside this diagram`);
  }

  const created = convertToExcalidrawElements(
    plan.skeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
  const createdIds = new Set(created.map((element) => element.id));
  // The human may draw while ELK runs or while elements stream in. Always
  // rebase onto the live scene instead of a snapshot captured at entry.
  const baseScene = () => [...api.getSceneElements()].filter(
    (element) => !previousPreviewIds.has(element.id) && !createdIds.has(element.id),
  );
  if (created.some((element) => !Number.isFinite(element.x) || !Number.isFinite(element.y)
    || !Number.isFinite(element.width) || !Number.isFinite(element.height))) {
    throw new Error("Diagram layout produced invalid element geometry");
  }
  // Bound labels are created by the converter rather than requested, so they
  // are the only elements without an id we chose. Group them by container.
  const labelsByContainer = new Map<string, SceneElement[]>();
  for (const element of created) {
    const candidate = element as SceneElement & { containerId?: string | null };
    if (element.type !== "text" || !candidate.containerId) continue;
    const labels = labelsByContainer.get(candidate.containerId) ?? [];
    labels.push(element);
    labelsByContainer.set(candidate.containerId, labels);
  }
  const convertedById = new Map(created.map((element) => [element.id, element]));
  const expectedCount = plan.skeletons.length + plan.skeletons.filter(
    (skeleton) => (skeleton.label as { text?: string } | undefined)?.text,
  ).length;
  if (created.length !== expectedCount) {
    throw new Error(`Diagram validation failed: converted ${created.length} elements, expected ${expectedCount}`);
  }
  for (const id of expectedIds) {
    if (!convertedById.has(id)) {
      throw new Error(`Diagram validation failed: element ${id} was dropped during conversion`);
    }
  }

  const edgeIdByIndex = new Map<number, string>();
  const edgeLabelIdByIndex = new Map<number, string>();
  for (const [id, entry] of plan.roles) {
    if (entry.edgeIndex === undefined) continue;
    if (entry.role === "edge") edgeIdByIndex.set(entry.edgeIndex, id);
    if (entry.role === "edgeLabel") edgeLabelIdByIndex.set(entry.edgeIndex, id);
  }
  const convertedNodes = params.nodes.map(
    (node) => convertedById.get(plan.elementIdByNode.get(node.id)!)!,
  );
  const convertedEdges = (params.edges ?? []).map(
    (_edge, index) => convertedById.get(edgeIdByIndex.get(index)!)!,
  );
  for (const [index, node] of params.nodes.entries()) {
    const rendered = convertedNodes[index] as SceneElement & {
      backgroundColor?: string;
      strokeColor?: string;
      roundness?: unknown;
    };
    const expectedType = nodeToType(node);
    if (rendered.type !== expectedType) {
      throw new Error(`Diagram validation failed: ${node.id} rendered as ${rendered.type}, expected ${expectedType}`);
    }
    if (node.backgroundColor && rendered.backgroundColor !== node.backgroundColor) {
      throw new Error(`Diagram validation failed: ${node.id} lost its background color`);
    }
    if (node.strokeColor && rendered.strokeColor !== node.strokeColor) {
      throw new Error(`Diagram validation failed: ${node.id} lost its stroke color`);
    }
    if (node.rounded && expectedType === "rectangle" && !rendered.roundness) {
      throw new Error(`Diagram validation failed: ${node.id} lost its rounded corners`);
    }
  }
  for (const [index, edge] of (params.edges ?? []).entries()) {
    if (convertedEdges[index]?.type !== "arrow") {
      throw new Error(`Diagram validation failed: ${edge.from} -> ${edge.to} did not render as an arrow`);
    }
  }

  const nodeGroups = convertedNodes.map((element) => [
    element,
    ...(labelsByContainer.get(element.id) ?? []),
  ]);
  const edgeGroups = convertedEdges.map((element, index) => {
    const label = convertedById.get(edgeLabelIdByIndex.get(index) ?? "");
    return [
      element,
      ...(labelsByContainer.get(element.id) ?? []),
      ...(label ? [label] : []),
    ];
  });
  const titleElement = title ? convertedById.get(titleElementId(diagramId)) : undefined;
  const titleTexts = titleElement ? [titleElement] : [];
  const groupedIds = new Set([...nodeGroups, ...edgeGroups, titleTexts].flat().map((element) => element.id));
  const leftovers = created.filter((element) => !groupedIds.has(element.id));
  const result = {
    count: created.length,
    diagramId,
    layout: plan.layout,
    ...(quality ? { quality } : {}),
    idMap: Object.fromEntries(params.nodes.map(
      (node) => [node.id, plan.elementIdByNode.get(node.id)],
    )),
    validation: {
      title: title ? titleTexts.some((element) => (element as SceneElement & { text?: string }).text === title) : true,
      nodes: convertedNodes.length,
      edges: convertedEdges.length,
      edgeLabels: plan.edgeLabelCount,
      shapes: Object.fromEntries(params.nodes.map((node, index) => [node.id, convertedNodes[index]?.type])),
      grid: gridResult(),
    },
  };
  if (preview) {
    // ELK is asynchronous. A newer JSON delta may have completed while this
    // layout was running, so only the latest requested version may paint.
    if (previewVersion !== diagramPreviewVersions.latest) return { stale: true };
    const base = baseScene();
    diagramPreviewElementIds.clear();
    for (const element of created) diagramPreviewElementIds.add(element.id);
    api.updateScene({
      elements: [...base, ...created],
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    reportDiagramPreviewProgress(params.nodes.length, (params.edges ?? []).length, previewVersion);
    if (params.nodes.length !== diagramPreviewVersions.lastNodeCount) {
      diagramPreviewVersions.lastNodeCount = params.nodes.length;
      await api.scrollToContent(created, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        animate: false,
      });
    }
    return { preview: true, diagramId, nodes: params.nodes.length, edges: (params.edges ?? []).length };
  }

  diagramPreviewElementIds.clear();
  diagramPreviewVersions.lastNodeCount = 0;
  diagramPreviewStream.diagramId = null;
  reportDiagramPreviewProgress(0, 0, previewVersion);
  const applyFinalScene = async () => {
    api.updateScene({
      elements: [...baseScene(), ...created],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    reportCanvasStreamProgress(created.length, created.length);
    await api.scrollToContent(created, {
      fitToViewport: true,
      viewportZoomFactor: 0.9,
      animate: false,
    });
    return result;
  };

  if (hadPreview || !shouldStreamCanvas()) return applyFinalScene();

  const streamed: SceneElement[] = [];
  reportCanvasStreamProgress(0, created.length);
  const updateProgress = () => {
    api.updateScene({
      elements: [...baseScene(), ...streamed],
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    reportCanvasStreamProgress(streamed.length, created.length);
  };

  // Keep each step above the normal human visual threshold while bounding the
  // total animation time for both small and large diagrams.
  streamed.push(...titleTexts);
  const nodeDelay = Math.max(70, Math.min(160, Math.round(1_200 / Math.max(1, nodeGroups.length))));
  for (let index = 0; index < nodeGroups.length; index++) {
    if (!shouldStreamCanvas()) return applyFinalScene();
    streamed.push(...nodeGroups[index]);
    updateProgress();
    if (index === 0) {
      await api.scrollToContent(created, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        animate: false,
      });
    }
    await pauseForStreaming(nodeDelay);
  }

  const edgeBatchSize = 2;
  const edgeDelay = Math.max(35, Math.round(500 / Math.max(1, Math.ceil(edgeGroups.length / edgeBatchSize))));
  for (let index = 0; index < edgeGroups.length; index += edgeBatchSize) {
    if (!shouldStreamCanvas()) return applyFinalScene();
    streamed.push(...edgeGroups.slice(index, index + edgeBatchSize).flat());
    updateProgress();
    await pauseForStreaming(edgeDelay);
  }

  streamed.push(...leftovers);
  api.updateScene({
    elements: [...baseScene(), ...streamed],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  reportCanvasStreamProgress(streamed.length, created.length);

  return result;
}
