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
  type LayoutParams,
} from "../diagram-layout";
import { asRecord, gridResult, resolveDiagramOrigin } from "./geometry";
import {
  diagramPreviewElementIds,
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
  // Plan at the origin first: above/left placement needs the diagram's own
  // bounds before an anchor-relative position can be chosen.
  const plan = await planDiagramLayout(params, { x: 0, y: 0 });
  const origin = resolveDiagramOrigin(
    api,
    params.anchor,
    params.anchorDirection ?? "right",
    planBounds(plan),
    withoutDiagramPreviewElements([...api.getSceneElements()]),
  );
  translatePlan(plan, origin.x, origin.y);
  const title = params.title?.trim();

  const created = convertToExcalidrawElements(
    plan.skeletons as Parameters<typeof convertToExcalidrawElements>[0],
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
  // Excalidraw intentionally regenerates skeleton ids. Group converted primary
  // elements with their bound labels using the converted container ids instead
  // of trying to match the original skeleton ids.
  const labelsByContainer = new Map<string, SceneElement[]>();
  for (const element of created) {
    const candidate = element as SceneElement & { containerId?: string | null };
    if (element.type !== "text" || !candidate.containerId) continue;
    const labels = labelsByContainer.get(candidate.containerId) ?? [];
    labels.push(element);
    labelsByContainer.set(candidate.containerId, labels);
  }
  const convertedNodes = created
    .filter((element) => element.type !== "text" && element.type !== "arrow")
    .slice(0, params.nodes.length);
  const convertedEdges = created.filter((element) => element.type === "arrow");
  if (convertedNodes.length !== params.nodes.length || convertedEdges.length !== (params.edges ?? []).length) {
    throw new Error("Diagram validation failed: rendered element counts do not match the request");
  }
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
  const nodeGroups = convertedNodes.map((element) => [
    element,
    ...(labelsByContainer.get(element.id) ?? []),
  ]);
  const edgeGroups = convertedEdges.map((element) => [
    element,
    ...(labelsByContainer.get(element.id) ?? []),
  ]);
  const standaloneTexts = created.filter((element) => {
    const candidate = element as SceneElement & { containerId?: string | null };
    return element.type === "text" && !candidate.containerId;
  });
  // Standalone texts convert in skeleton order: title first, then one label
  // per labelled edge. Attach each label to its edge so they stream together.
  const titleTexts = standaloneTexts.slice(0, title ? 1 : 0);
  const edgeLabelTexts = standaloneTexts.slice(title ? 1 : 0);
  const labelledEdgeIndexes = (params.edges ?? [])
    .map((edge, index) => (edge.label?.trim() ? index : -1))
    .filter((index) => index >= 0);
  labelledEdgeIndexes.forEach((edgeIndex, labelIndex) => {
    const label = edgeLabelTexts[labelIndex];
    if (label && edgeGroups[edgeIndex]) edgeGroups[edgeIndex].push(label);
  });
  const groupedIds = new Set([...nodeGroups, ...edgeGroups, titleTexts].flat().map((element) => element.id));
  const leftovers = created.filter((element) => !groupedIds.has(element.id));
  const result = {
    count: created.length,
    idMap: Object.fromEntries(params.nodes.map((node, index) => [
      node.id,
      convertedNodes[index]?.id ?? plan.elementIdByNode.get(node.id),
    ])),
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
    return { preview: true, nodes: params.nodes.length, edges: (params.edges ?? []).length };
  }

  diagramPreviewElementIds.clear();
  diagramPreviewVersions.lastNodeCount = 0;
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
