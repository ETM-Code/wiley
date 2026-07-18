import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ELK from "elkjs/lib/elk.bundled";
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";

import { bridge, type CanvasRequest } from "./bridge";

type JsonObject = Record<string, unknown>;
type SceneElement = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>[number];

type GraphShape = "rectangle" | "diamond" | "ellipse";
type GraphNode = {
  id: string;
  label: string;
  shape?: GraphShape;
  /** Compatibility for diagrams created before `shape` became canonical. */
  kind?: "box" | "diamond" | "ellipse";
  backgroundColor?: string;
  strokeColor?: string;
  rounded?: boolean;
};
type GraphEdge = { from: string; to: string; label?: string };
type DiagramLayout = {
  direction?: "RIGHT" | "DOWN";
  nodeSpacing?: number;
  layerSpacing?: number;
};
type LayoutParams = {
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  anchor?: string;
  layout?: DiagramLayout;
};
type AddParams = { elements: JsonObject[]; placeNear?: string; scrollTo?: boolean };
type PatchParams = {
  updates?: Array<{ id: string; props: JsonObject }>;
  deletes?: string[];
};
type ShapeParams = {
  shape: "rectangle" | "ellipse" | "diamond";
  width?: number;
  height?: number;
  label?: string;
  strokeColor?: string;
  backgroundColor?: string;
};

const elk = new ELK();
export const MODEL_GRID_SIZE = 20;
const DIAGRAM_NODE_WIDTH = 200;
const DIAGRAM_NODE_HEIGHT = 80;
const diagramPreviewElementIds = new Set<string>();
let latestDiagramPreviewVersion = 0;
let lastDiagramPreviewNodeCount = 0;

export function isDiagramPreviewActive(): boolean {
  return diagramPreviewElementIds.size > 0;
}

export function withoutDiagramPreviewElements<T extends { id?: unknown }>(elements: readonly T[]): T[] {
  return elements.filter((element) => typeof element.id !== "string" || !diagramPreviewElementIds.has(element.id));
}

function shouldStreamCanvas(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

function pauseForStreaming(milliseconds: number): Promise<void> {
  if (!shouldStreamCanvas()) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(() => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    resolve();
  }, milliseconds));
}

function reportCanvasStreamProgress(visibleElements: number, totalElements: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.wileyCanvasStream = `${visibleElements}/${totalElements}`;
  const entry = `${Math.round(performance.now())}:${visibleElements}/${totalElements}`;
  const previous = visibleElements === 0
    ? []
    : (document.documentElement.dataset.wileyCanvasStreamTrace ?? "").split("|").filter(Boolean);
  document.documentElement.dataset.wileyCanvasStreamTrace = [...previous, entry].slice(-128).join("|");
  document.dispatchEvent(new CustomEvent("wiley:canvas-stream-progress", {
    detail: { visibleElements, totalElements },
  }));
}

function reportDiagramPreviewProgress(nodes: number, edges: number, version: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.wileyDiagramPreview = `${nodes}/${edges}`;
  const entry = `${Math.round(performance.now())}:${nodes}/${edges}:${version}`;
  const previous = (document.documentElement.dataset.wileyDiagramPreviewTrace ?? "").split("|").filter(Boolean);
  document.documentElement.dataset.wileyDiagramPreviewTrace = [...previous, entry].slice(-128).join("|");
  document.dispatchEvent(new CustomEvent("wiley:diagram-preview-progress", {
    detail: { nodes, edges, version },
  }));
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function snapModelCoordinate(value: unknown, fallback = 0): number {
  return Math.round(finite(value, fallback) / MODEL_GRID_SIZE) * MODEL_GRID_SIZE;
}

function snapModelSize(value: unknown, fallback: number): number {
  return Math.max(MODEL_GRID_SIZE, snapModelCoordinate(value, fallback));
}

function snapModelGeometry(props: JsonObject): JsonObject {
  const snapped = { ...props };
  if ("x" in snapped) snapped.x = snapModelCoordinate(snapped.x);
  if ("y" in snapped) snapped.y = snapModelCoordinate(snapped.y);
  if ("width" in snapped) snapped.width = snapModelSize(snapped.width, MODEL_GRID_SIZE);
  if ("height" in snapped) snapped.height = snapModelSize(snapped.height, MODEL_GRID_SIZE);
  if (Array.isArray(snapped.points)) {
    snapped.points = snapped.points.map((point) => Array.isArray(point)
      ? [snapModelCoordinate(point[0]), snapModelCoordinate(point[1])]
      : point);
  }
  return snapped;
}

function gridResult() {
  return { gridSize: MODEL_GRID_SIZE, snapped: true };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function sceneSummary(elements: readonly SceneElement[]) {
  const textByContainer = new Map<string, string>();
  for (const element of elements) {
    const candidate = element as SceneElement & { text?: string; containerId?: string | null };
    if (candidate.type === "text" && candidate.containerId && candidate.text) {
      textByContainer.set(candidate.containerId, candidate.text);
    }
  }

  return elements.map((element) => {
    const candidate = element as SceneElement & {
      text?: string;
      startBinding?: { elementId?: string } | null;
      endBinding?: { elementId?: string } | null;
    };
    const connects =
      candidate.type === "arrow"
        ? {
            start: candidate.startBinding?.elementId ?? null,
            end: candidate.endBinding?.elementId ?? null,
          }
        : undefined;

    return {
      id: element.id,
      type: element.type,
      bbox: {
        x: Math.round(element.x),
        y: Math.round(element.y),
        w: Math.round(element.width),
        h: Math.round(element.height),
      },
      text: candidate.text ?? textByContainer.get(element.id),
      connects,
    };
  });
}

function placementOrigin(
  api: ExcalidrawImperativeAPI,
  anchor?: string,
  sourceElements: readonly SceneElement[] = api.getSceneElements(),
): { x: number; y: number } {
  const elements = sourceElements.filter(
    (element) => Number.isFinite(element.x) && Number.isFinite(element.y)
      && Number.isFinite(element.width) && Number.isFinite(element.height),
  );
  const anchored = anchor ? elements.find((element) => element.id === anchor) : undefined;
  if (anchored) {
    return {
      x: snapModelCoordinate(anchored.x + anchored.width + 100),
      y: snapModelCoordinate(anchored.y),
    };
  }

  if (elements.length === 0) {
    const state = api.getAppState();
    return {
      x: snapModelCoordinate(Math.max(80, -finite(state.scrollX) + 120)),
      y: snapModelCoordinate(Math.max(80, -finite(state.scrollY) + 120)),
    };
  }

  const right = Math.max(...elements.map((element) => element.x + element.width));
  const top = Math.min(...elements.map((element) => element.y));
  return { x: snapModelCoordinate(right + 120), y: snapModelCoordinate(top) };
}

function nodeToType(node: GraphNode): GraphShape {
  if (node.shape) return node.shape;
  if (node.kind === "diamond") return "diamond";
  if (node.kind === "ellipse") return "ellipse";
  return "rectangle";
}

async function addShape(api: ExcalidrawImperativeAPI, value: unknown) {
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

async function layoutDiagram(api: ExcalidrawImperativeAPI, value: unknown, preview = false) {
  const params = value as LayoutParams;
  const previewVersion = finite(asRecord(value).__previewVersion, 0);
  if (preview) {
    if (previewVersion <= latestDiagramPreviewVersion) return { stale: true };
    latestDiagramPreviewVersion = previewVersion;
  } else if (previewVersion > latestDiagramPreviewVersion) {
    latestDiagramPreviewVersion = previewVersion;
  }
  if (!Array.isArray(params?.nodes) || params.nodes.length === 0) {
    throw new Error("layout-diagram requires at least one node");
  }

  const nodeIds = new Set<string>();
  for (const node of params.nodes) {
    if (!node?.id || !node.label || nodeIds.has(node.id)) {
      throw new Error("Diagram nodes require unique ids and non-empty labels");
    }
    if (node.shape && !["rectangle", "diamond", "ellipse"].includes(node.shape)) {
      throw new Error(`Diagram node ${node.id} has an unsupported shape`);
    }
    nodeIds.add(node.id);
  }
  for (const edge of params.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Diagram edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
  }

  const direction = params.layout?.direction ?? "RIGHT";
  const nodeSpacing = Math.min(240, Math.max(40, snapModelCoordinate(params.layout?.nodeSpacing, 80)));
  const layerSpacing = Math.min(320, Math.max(60, snapModelCoordinate(params.layout?.layerSpacing, 120)));
  const layoutResult = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(MODEL_GRID_SIZE),
    },
    children: params.nodes.map((node) => ({
      id: node.id,
      width: DIAGRAM_NODE_WIDTH,
      height: DIAGRAM_NODE_HEIGHT,
    })),
    edges: (params.edges ?? []).map((edge, index) => ({
      id: `edge-${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  });

  const existing = withoutDiagramPreviewElements([...api.getSceneElements()]);
  const hadPreview = diagramPreviewElementIds.size > 0;
  const origin = placementOrigin(api, params.anchor, existing);
  const positions = new Map(
    (layoutResult.children ?? []).map((node) => [node.id, {
      x: snapModelCoordinate(node.x),
      y: snapModelCoordinate(node.y),
    }]),
  );
  const edgeSections = new Map(
    ((layoutResult.edges ?? []) as ElkExtendedEdge[]).map((edge) => [edge.id, edge.sections?.[0]]),
  );
  const idPrefix = `agent-${Date.now().toString(36)}`;
  const elementIdByNode = new Map(
    params.nodes.map((node, index) => [node.id, `${idPrefix}-node-${index}`]),
  );

  const nodeSkeletons: JsonObject[] = params.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const type = nodeToType(node);
    return {
      id: elementIdByNode.get(node.id),
      type,
      x: snapModelCoordinate(origin.x + position.x),
      y: snapModelCoordinate(origin.y + position.y),
      width: DIAGRAM_NODE_WIDTH,
      height: DIAGRAM_NODE_HEIGHT,
      strokeColor: node.strokeColor ?? "#1e1e1e",
      backgroundColor: node.backgroundColor ?? "transparent",
      ...(node.backgroundColor && node.backgroundColor !== "transparent" ? { fillStyle: "solid" } : {}),
      ...(type === "rectangle" && node.rounded ? { roundness: { type: 3 } } : {}),
      label: { text: node.label },
    };
  });
  const title = params.title?.trim();
  const graphWidth = snapModelSize(
    Math.max(360, ...[...positions.values()].map((position) => position.x + DIAGRAM_NODE_WIDTH)),
    360,
  );
  const skeletons: JsonObject[] = [
    ...(title ? [{
      id: `${idPrefix}-title`,
      type: "text",
      x: origin.x,
      y: snapModelCoordinate(Math.max(MODEL_GRID_SIZE, origin.y - 60)),
      width: graphWidth,
      height: 40,
      text: title,
      fontSize: 24,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
    }] : []),
    ...nodeSkeletons,
  ];
  skeletons.push(
    ...(params.edges ?? []).map((edge, index) => {
      const from = positions.get(edge.from) ?? { x: 0, y: 0 };
      const to = positions.get(edge.to) ?? { x: 0, y: 0 };
      const fromCenter = {
        x: origin.x + from.x + DIAGRAM_NODE_WIDTH / 2,
        y: origin.y + from.y + DIAGRAM_NODE_HEIGHT / 2,
      };
      const toCenter = {
        x: origin.x + to.x + DIAGRAM_NODE_WIDTH / 2,
        y: origin.y + to.y + DIAGRAM_NODE_HEIGHT / 2,
      };
      const dx = toCenter.x - fromCenter.x;
      const dy = toCenter.y - fromCenter.y;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const startX = horizontal
        ? fromCenter.x + Math.sign(dx || 1) * DIAGRAM_NODE_WIDTH / 2
        : fromCenter.x;
      const startY = horizontal
        ? fromCenter.y
        : fromCenter.y + Math.sign(dy || 1) * DIAGRAM_NODE_HEIGHT / 2;
      const endX = horizontal
        ? toCenter.x - Math.sign(dx || 1) * DIAGRAM_NODE_WIDTH / 2
        : toCenter.x;
      const endY = horizontal
        ? toCenter.y
        : toCenter.y - Math.sign(dy || 1) * DIAGRAM_NODE_HEIGHT / 2;
      const section = edgeSections.get(`edge-${index}`);
      const absoluteRoute = [
        { x: snapModelCoordinate(startX), y: snapModelCoordinate(startY) },
        ...(section?.bendPoints ?? []).map((point) => ({
          x: snapModelCoordinate(origin.x + point.x),
          y: snapModelCoordinate(origin.y + point.y),
        })),
        { x: snapModelCoordinate(endX), y: snapModelCoordinate(endY) },
      ].filter((point, pointIndex, points) => pointIndex === 0
        || point.x !== points[pointIndex - 1].x
        || point.y !== points[pointIndex - 1].y);
      const routeOrigin = absoluteRoute[0];
      return {
        id: `${idPrefix}-edge-${index}`,
        type: "arrow",
        x: routeOrigin.x,
        y: routeOrigin.y,
        points: absoluteRoute.map((point) => [point.x - routeOrigin.x, point.y - routeOrigin.y]),
        start: { id: elementIdByNode.get(edge.from) },
        end: { id: elementIdByNode.get(edge.to) },
        endArrowhead: "arrow",
        ...(edge.label ? { label: { text: edge.label } } : {}),
      };
    }),
  );

  const created = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
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
  const groupedIds = new Set([...nodeGroups, ...edgeGroups, standaloneTexts].flat().map((element) => element.id));
  const leftovers = created.filter((element) => !groupedIds.has(element.id));
  const result = {
    count: created.length,
    idMap: Object.fromEntries(params.nodes.map((node, index) => [
      node.id,
      convertedNodes[index]?.id ?? elementIdByNode.get(node.id),
    ])),
    validation: {
      title: title ? standaloneTexts.some((element) => (element as SceneElement & { text?: string }).text === title) : true,
      nodes: convertedNodes.length,
      edges: convertedEdges.length,
      shapes: Object.fromEntries(params.nodes.map((node, index) => [node.id, convertedNodes[index]?.type])),
      grid: gridResult(),
    },
  };
  if (preview) {
    // ELK is asynchronous. A newer JSON delta may have completed while this
    // layout was running, so only the latest requested version may paint.
    if (previewVersion !== latestDiagramPreviewVersion) return { stale: true };
    diagramPreviewElementIds.clear();
    for (const element of created) diagramPreviewElementIds.add(element.id);
    api.updateScene({
      elements: [...existing, ...created],
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    reportDiagramPreviewProgress(params.nodes.length, (params.edges ?? []).length, previewVersion);
    if (params.nodes.length !== lastDiagramPreviewNodeCount) {
      lastDiagramPreviewNodeCount = params.nodes.length;
      await api.scrollToContent(created, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        animate: false,
      });
    }
    return { preview: true, nodes: params.nodes.length, edges: (params.edges ?? []).length };
  }

  diagramPreviewElementIds.clear();
  lastDiagramPreviewNodeCount = 0;
  reportDiagramPreviewProgress(0, 0, previewVersion);
  const applyFinalScene = async () => {
    api.updateScene({
      elements: [...existing, ...created],
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
      elements: [...existing, ...streamed],
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
    reportCanvasStreamProgress(streamed.length, created.length);
  };

  // Keep each step above the normal human visual threshold while bounding the
  // total animation time for both small and large diagrams.
  streamed.push(...standaloneTexts);
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
    elements: [...existing, ...streamed],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  reportCanvasStreamProgress(streamed.length, created.length);

  return result;
}

function clearDiagramPreview(api: ExcalidrawImperativeAPI, value: unknown) {
  const version = finite(asRecord(value).__previewVersion, 0);
  if (version < latestDiagramPreviewVersion) return { stale: true };
  latestDiagramPreviewVersion = version;
  const cleared = diagramPreviewElementIds.size;
  const elements = withoutDiagramPreviewElements([...api.getSceneElements()]);
  diagramPreviewElementIds.clear();
  lastDiagramPreviewNodeCount = 0;
  if (cleared > 0) {
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }
  reportDiagramPreviewProgress(0, 0, version);
  return { cleared };
}

function sanitizeSkeletons(api: ExcalidrawImperativeAPI, value: unknown): AddParams {
  const params = value as AddParams;
  if (!Array.isArray(params?.elements) || params.elements.length === 0) {
    throw new Error("add-elements requires a non-empty elements array");
  }

  const existing = api.getSceneElements();
  const existingIds = new Set(existing.map((element) => element.id));
  const proposedIds = new Set(
    params.elements.map((item) => item.id).filter((id): id is string => typeof id === "string"),
  );
  const anchor = params.placeNear
    ? existing.find((element) => element.id === params.placeNear)
    : undefined;
  const anchorX = anchor ? anchor.x + anchor.width + 80 : 0;
  const anchorY = anchor?.y ?? 0;

  const elements = params.elements.map((source, index) => {
    const item = { ...source };
    item.x = snapModelCoordinate(finite(item.x, index * MODEL_GRID_SIZE) + anchorX);
    item.y = snapModelCoordinate(finite(item.y, index * MODEL_GRID_SIZE) + anchorY);
    item.width = snapModelSize(item.width, 160);
    item.height = snapModelSize(item.height, 60);
    if (Array.isArray(item.points)) {
      item.points = item.points.map((point) => Array.isArray(point)
        ? [snapModelCoordinate(point[0]), snapModelCoordinate(point[1])]
        : point);
    }

    if (item.type === "arrow") {
      for (const endpoint of ["start", "end"] as const) {
        const binding = asRecord(item[endpoint]);
        const id = binding.id;
        if (typeof id !== "string" || (!existingIds.has(id) && !proposedIds.has(id))) {
          delete item[endpoint];
        }
      }
    }
    return item;
  });

  return { ...params, elements };
}

async function addElements(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = sanitizeSkeletons(api, value);
  const created = convertToExcalidrawElements(
    params.elements as Parameters<typeof convertToExcalidrawElements>[0],
  );
  api.updateScene({
    elements: [...api.getSceneElements(), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  if (params.scrollTo !== false) {
    await api.scrollToContent(created, { fitToViewport: true, animate: true });
  }
  return { count: created.length, ids: created.map((element) => element.id), grid: gridResult() };
}

function applyPatch(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as PatchParams;
  const current = api.getSceneElements();
  const byId = new Map(current.map((element) => [element.id, element]));
  const deletes = new Set(Array.isArray(params?.deletes) ? params.deletes : []);
  const updates = new Map(
    (Array.isArray(params?.updates) ? params.updates : []).map((patch) => [patch.id, patch.props]),
  );
  const requestedIds = [...updates.keys(), ...deletes];
  const skipped = [...new Set(requestedIds.filter((id) => !byId.has(id)))];
  let updated = 0;
  let deleted = 0;

  const protectedProps = new Set(["id", "seed", "version", "versionNonce", "updated"]);
  const next = current.flatMap((element) => {
    if (deletes.has(element.id)) {
      deleted += 1;
      return [];
    }
    const requested = updates.get(element.id);
    if (!requested) return [element];
    const safeProps = snapModelGeometry(Object.fromEntries(
      Object.entries(asRecord(requested)).filter(([key]) => !protectedProps.has(key)),
    ));
    updated += 1;
    return [
      {
        ...element,
        ...safeProps,
        version: element.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      } as SceneElement,
    ];
  });

  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { updated, deleted, skipped, grid: gridResult() };
}

function mutationResult(api: ExcalidrawImperativeAPI, result: Record<string, unknown>) {
  return {
    ...result,
    __boardSnapshot: {
      elements: api.getSceneElements(),
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
      files: api.getFiles(),
    },
  };
}

export async function handleCanvasRequest(
  api: ExcalidrawImperativeAPI,
  request: CanvasRequest,
): Promise<unknown> {
  switch (request.op) {
    case "add-shape":
      return mutationResult(api, await addShape(api, request.params));
    case "get-scene-summary":
      return sceneSummary(api.getSceneElements());
    case "get-scene-full":
      return api.getSceneElements();
    case "export-png": {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
        mimeType: "image/png",
      });
      return uint8ToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    case "layout-diagram":
      return mutationResult(api, await layoutDiagram(api, request.params));
    case "preview-diagram":
      return layoutDiagram(api, request.params, true);
    case "clear-diagram-preview":
      return clearDiagramPreview(api, request.params);
    case "add-elements":
      return mutationResult(api, await addElements(api, request.params));
    case "clear-scene": {
      const cleared = api.getSceneElements().length;
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return mutationResult(api, { cleared });
    }
    case "apply-patch":
      return mutationResult(api, applyPatch(api, request.params));
    default:
      throw new Error(`Unknown canvas operation: ${String(request.op)}`);
  }
}

export function subscribeToCanvasRequests(
  getApi: () => ExcalidrawImperativeAPI | null,
  onError: (message: string) => void,
  onMutationState?: (active: boolean) => void,
): () => void {
  let activeMutations = 0;
  const mutationOperations = new Set<CanvasRequest["op"]>([
    "add-shape",
    "layout-diagram",
    "preview-diagram",
    "clear-diagram-preview",
    "add-elements",
    "clear-scene",
    "apply-patch",
  ]);
  return bridge.onCanvasRequest((request) => {
    const api = getApi();
    if (!api) {
      bridge.respondCanvasRequest({ id: request.id, error: "Canvas is not ready" });
      return;
    }

    const isMutation = mutationOperations.has(request.op);
    if (isMutation) {
      activeMutations += 1;
      onMutationState?.(true);
    }

    void handleCanvasRequest(api, request)
      .then((result) => bridge.respondCanvasRequest({ id: request.id, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        onError(message);
        bridge.respondCanvasRequest({ id: request.id, error: message });
      })
      .finally(() => {
        if (!isMutation) return;
        activeMutations = Math.max(0, activeMutations - 1);
        onMutationState?.(activeMutations > 0);
      });
  });
}
