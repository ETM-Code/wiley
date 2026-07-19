import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { bridge, type CanvasRequest } from "./bridge";
import {
  MODEL_GRID_SIZE,
  finiteNumber as finite,
  measureText,
  nodeToType,
  planBounds,
  planDiagramLayout,
  snapModelCoordinate,
  snapModelSize,
  translatePlan,
  type LayoutParams,
  type PlanBounds,
} from "./diagram-layout";

export { MODEL_GRID_SIZE, snapModelCoordinate } from "./diagram-layout";

type JsonObject = Record<string, unknown>;
type SceneElement = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>[number];

type AddParams = {
  elements: JsonObject[];
  placeNear?: string;
  placeDirection?: "right" | "left" | "above" | "below";
  scrollTo?: boolean;
};
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

type PlaceDirection = "right" | "left" | "above" | "below";
const PLACE_GAP = 120;

function finiteGeometry(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter(
    (element) => Number.isFinite(element.x) && Number.isFinite(element.y)
      && Number.isFinite(element.width) && Number.isFinite(element.height),
  );
}

function elementsBounds(elements: readonly SceneElement[]): PlanBounds | null {
  if (elements.length === 0) return null;
  return {
    minX: Math.min(...elements.map((element) => element.x)),
    minY: Math.min(...elements.map((element) => element.y)),
    maxX: Math.max(...elements.map((element) => element.x + element.width)),
    maxY: Math.max(...elements.map((element) => element.y + element.height)),
  };
}

/**
 * Places new content beside the anchor element (or the whole existing scene)
 * in the requested direction, offset so its own bounds clear the reference.
 */
function directionalOrigin(
  reference: PlanBounds,
  content: PlanBounds,
  direction: PlaceDirection,
  gap = PLACE_GAP,
): { x: number; y: number } {
  switch (direction) {
    case "left":
      return {
        x: snapModelCoordinate(reference.minX - gap - content.maxX),
        y: snapModelCoordinate(reference.minY - content.minY),
      };
    case "above":
      return {
        x: snapModelCoordinate(reference.minX - content.minX),
        y: snapModelCoordinate(reference.minY - gap - content.maxY),
      };
    case "below":
      return {
        x: snapModelCoordinate(reference.minX - content.minX),
        y: snapModelCoordinate(reference.maxY + gap - content.minY),
      };
    default:
      return {
        x: snapModelCoordinate(reference.maxX + gap - content.minX),
        y: snapModelCoordinate(reference.minY - content.minY),
      };
  }
}

function resolveDiagramOrigin(
  api: ExcalidrawImperativeAPI,
  anchor: string | undefined,
  direction: PlaceDirection,
  content: PlanBounds,
  sourceElements: readonly SceneElement[],
): { x: number; y: number } {
  const elements = finiteGeometry(sourceElements);
  const anchored = anchor ? elements.find((element) => element.id === anchor) : undefined;
  const reference = anchored
    ? elementsBounds([anchored])
    : elementsBounds(elements);
  if (!reference) {
    const state = api.getAppState();
    return {
      x: snapModelCoordinate(Math.max(80, -finite(state.scrollX) + 120)),
      y: snapModelCoordinate(Math.max(80, -finite(state.scrollY) + 120)),
    };
  }
  return directionalOrigin(reference, content, direction);
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
    if (previewVersion !== latestDiagramPreviewVersion) return { stale: true };
    const base = baseScene();
    diagramPreviewElementIds.clear();
    for (const element of created) diagramPreviewElementIds.add(element.id);
    api.updateScene({
      elements: [...base, ...created],
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
  let anchorX = 0;
  let anchorY = 0;
  if (anchor) {
    // Element coordinates are offsets; place the whole batch beside the
    // anchor in the requested direction so it clears the anchor's bounds.
    const proposed = elementsBounds(params.elements.map((item, index) => ({
      x: finite(item.x, index * MODEL_GRID_SIZE),
      y: finite(item.y, index * MODEL_GRID_SIZE),
      width: finite(item.width, 160),
      height: finite(item.height, 60),
    })) as unknown as readonly SceneElement[]) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const origin = directionalOrigin(
      elementsBounds([anchor])!,
      proposed,
      params.placeDirection ?? "right",
      80,
    );
    anchorX = origin.x;
    anchorY = origin.y;
  }

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
  const files = (value as { files?: Record<string, unknown> }).files;
  if (files && typeof files === "object" && Object.keys(files).length > 0) {
    api.addFiles(Object.values(files) as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
  }
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

const FONT_FAMILY_CSS: Record<number, string> = {
  1: "Virgil",
  2: "Helvetica",
  3: "Cascadia",
  5: "Excalifont",
  6: "Nunito",
  7: "Lilita One",
  8: "Comic Shanns",
};

type PatchableElement = SceneElement & {
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  lineHeight?: number;
  containerId?: string | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  points?: Array<[number, number]>;
};

function remeasuredTextBox(element: PatchableElement, text: string, fontSize: number) {
  const family = FONT_FAMILY_CSS[element.fontFamily ?? 5] ?? "Excalifont";
  const lineHeight = typeof element.lineHeight === "number" ? element.lineHeight : 1.25;
  const lines = String(text).split("\n");
  const width = lines.reduce((max, line) => Math.max(max, measureText(line, fontSize, family).width), 1);
  return { width, height: lines.length * fontSize * lineHeight };
}

/**
 * Patches by id, then repairs everything a raw scene write would leave
 * stale on human-drawn elements: bound labels follow moves/resizes, text
 * edits on a labelled shape land on its label with the box re-measured in
 * the element's real font, bound arrows keep their attached endpoints, and
 * deleting a shape removes its label and dangling bindings.
 */
type ConnectParams = {
  connections: Array<{ from: string; to: string; label?: string; bidirectional?: boolean }>;
};

function perimeterPoint(
  box: { x: number; y: number; width: number; height: number },
  towards: { x: number; y: number },
): { x: number; y: number } {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const dx = towards.x - centerX;
  const dy = towards.y - centerY;
  if (dx === 0 && dy === 0) return { x: centerX, y: centerY };
  const scaleX = dx !== 0 ? box.width / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? box.height / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

/**
 * Connects existing elements (including human-drawn ones) with bound arrows.
 * The route is computed here, perimeter to perimeter, and the bindings are
 * written explicitly so the arrows follow the shapes when either end moves.
 */
function connectElements(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as ConnectParams;
  if (!Array.isArray(params?.connections) || params.connections.length === 0) {
    throw new Error("connect-elements requires a non-empty connections array");
  }
  const scene = api.getSceneElements() as readonly PatchableElement[];
  const byId = new Map(scene.map((element) => [element.id, element]));
  const skeletons = params.connections.map((connection, index) => {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    if (!from) throw new Error(`connect-elements: unknown element id ${connection.from}`);
    if (!to) throw new Error(`connect-elements: unknown element id ${connection.to}`);
    if (connection.from === connection.to) {
      throw new Error("connect-elements cannot connect an element to itself");
    }
    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const startPoint = perimeterPoint(from, toCenter);
    const endPoint = perimeterPoint(to, fromCenter);
    return {
      id: `agent-connect-${index}-${crypto.randomUUID().slice(0, 8)}`,
      type: "arrow",
      x: startPoint.x,
      y: startPoint.y,
      points: [[0, 0], [endPoint.x - startPoint.x, endPoint.y - startPoint.y]],
      endArrowhead: "arrow",
      ...(connection.bidirectional ? { startArrowhead: "arrow" } : {}),
      strokeColor: "#1e1e1e",
      ...(connection.label?.trim() ? { label: { text: connection.label.trim() } } : {}),
    };
  });

  const created = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  );
  const arrows = created.filter((element) => element.type === "arrow");
  if (arrows.length !== params.connections.length) {
    throw new Error("connect-elements: rendered arrow count does not match the request");
  }
  const boundAdditions = new Map<string, Array<{ id: string; type: "arrow" }>>();
  for (const [index, connection] of params.connections.entries()) {
    const arrow = arrows[index] as PatchableElement;
    Object.assign(arrow, {
      startBinding: { elementId: connection.from, focus: 0, gap: 4 },
      endBinding: { elementId: connection.to, focus: 0, gap: 4 },
    });
    for (const endpoint of [connection.from, connection.to]) {
      const additions = boundAdditions.get(endpoint) ?? [];
      additions.push({ id: arrow.id, type: "arrow" });
      boundAdditions.set(endpoint, additions);
    }
  }
  const next = scene.map((element) => {
    const additions = boundAdditions.get(element.id);
    if (!additions) return element;
    return {
      ...element,
      boundElements: [...(element.boundElements ?? []), ...additions],
      version: element.version + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    } as SceneElement;
  });
  api.updateScene({
    elements: [...next, ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return {
    count: arrows.length,
    ids: arrows.map((element) => element.id),
    connections: params.connections.map((connection) => `${connection.from} -> ${connection.to}`),
  };
}

function applyPatch(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as PatchParams;
  const current = api.getSceneElements() as readonly PatchableElement[];
  const byId = new Map(current.map((element) => [element.id, element]));
  const deletes = new Set(Array.isArray(params?.deletes) ? params.deletes : []);
  for (const id of [...deletes]) {
    for (const bound of byId.get(id)?.boundElements ?? []) {
      if (bound?.type === "text") deletes.add(bound.id);
    }
  }
  const updates = new Map(
    (Array.isArray(params?.updates) ? params.updates : []).map((patch) => [patch.id, patch.props]),
  );
  const requestedIds = [...updates.keys(), ...deletes];
  const skipped = [...new Set(requestedIds.filter((id) => !byId.has(id)))];

  const protectedProps = new Set([
    "id", "seed", "version", "versionNonce", "updated", "boundElements", "containerId", "groupIds",
  ]);
  const primary = new Map<string, JsonObject>();
  const secondary = new Map<string, JsonObject>();
  const mergeSecondary = (id: string, props: JsonObject) => {
    if (deletes.has(id)) return;
    secondary.set(id, { ...(secondary.get(id) ?? {}), ...props });
  };
  const arrowShifts = new Map<string, { sdx: number; sdy: number; edx: number; edy: number }>();

  for (const [id, requested] of updates) {
    const element = byId.get(id);
    if (!element || deletes.has(id)) continue;
    const safeProps = snapModelGeometry(Object.fromEntries(
      Object.entries(asRecord(requested)).filter(([key]) => !protectedProps.has(key)),
    ));

    // A text edit aimed at a labelled shape belongs on its bound label.
    const boundTextId = (element.boundElements ?? []).find((bound) => bound?.type === "text")?.id;
    if (boundTextId && element.type !== "text" && ("text" in safeProps || "fontSize" in safeProps)) {
      const label = byId.get(boundTextId);
      if (label) {
        const text = typeof safeProps.text === "string" ? safeProps.text : label.text ?? "";
        const fontSize = finite(safeProps.fontSize, label.fontSize ?? 20);
        mergeSecondary(boundTextId, {
          ...(typeof safeProps.text === "string" ? { text, originalText: text } : {}),
          ...("fontSize" in safeProps ? { fontSize } : {}),
          ...remeasuredTextBox(label, text, fontSize),
        });
      }
      delete safeProps.text;
      delete safeProps.fontSize;
    }

    // Direct text edits re-measure the box so the stored bbox stays honest.
    if (element.type === "text" && ("text" in safeProps || "fontSize" in safeProps)
      && !("width" in safeProps) && !("height" in safeProps)) {
      const text = typeof safeProps.text === "string" ? safeProps.text : element.text ?? "";
      const fontSize = finite(safeProps.fontSize, element.fontSize ?? 20);
      Object.assign(safeProps, remeasuredTextBox(element, text, fontSize));
      if (typeof safeProps.text === "string") safeProps.originalText = safeProps.text;
    }

    const dx = "x" in safeProps ? finite(safeProps.x, element.x) - element.x : 0;
    const dy = "y" in safeProps ? finite(safeProps.y, element.y) - element.y : 0;
    const resized = "width" in safeProps || "height" in safeProps;
    if (dx || dy || resized) {
      const nextX = element.x + dx;
      const nextY = element.y + dy;
      const nextWidth = "width" in safeProps ? finite(safeProps.width, element.width) : element.width;
      const nextHeight = "height" in safeProps ? finite(safeProps.height, element.height) : element.height;
      for (const bound of element.boundElements ?? []) {
        if (bound?.type !== "text" || updates.has(bound.id)) continue;
        const label = byId.get(bound.id);
        if (!label) continue;
        mergeSecondary(bound.id, {
          x: nextX + (nextWidth - label.width) / 2,
          y: nextY + (nextHeight - label.height) / 2,
        });
      }
      if (dx || dy) {
        for (const other of current) {
          if (other.type !== "arrow" || updates.has(other.id) || deletes.has(other.id)) continue;
          const startBound = other.startBinding?.elementId === id;
          const endBound = other.endBinding?.elementId === id;
          if (!startBound && !endBound) continue;
          const shift = arrowShifts.get(other.id) ?? { sdx: 0, sdy: 0, edx: 0, edy: 0 };
          if (startBound) {
            shift.sdx += dx;
            shift.sdy += dy;
          }
          if (endBound) {
            shift.edx += dx;
            shift.edy += dy;
          }
          arrowShifts.set(other.id, shift);
        }
      }
    }
    primary.set(id, safeProps);
  }

  for (const [arrowId, shift] of arrowShifts) {
    const arrow = byId.get(arrowId);
    const points = arrow?.points;
    if (!arrow || !Array.isArray(points) || points.length < 2) continue;
    const nextPoints = points.map((point, index) => {
      if (index === 0) return [0, 0];
      const endDx = index === points.length - 1 ? shift.edx : 0;
      const endDy = index === points.length - 1 ? shift.edy : 0;
      return [point[0] - shift.sdx + endDx, point[1] - shift.sdy + endDy];
    });
    mergeSecondary(arrowId, {
      x: arrow.x + shift.sdx,
      y: arrow.y + shift.sdy,
      points: nextPoints,
    });
  }

  // Arrows must not keep bindings to elements that no longer exist.
  for (const element of current) {
    if (element.type !== "arrow" || deletes.has(element.id)) continue;
    if (element.startBinding?.elementId && deletes.has(element.startBinding.elementId)) {
      mergeSecondary(element.id, { startBinding: null });
    }
    if (element.endBinding?.elementId && deletes.has(element.endBinding.elementId)) {
      mergeSecondary(element.id, { endBinding: null });
    }
  }

  let updated = 0;
  let deleted = 0;
  let adjusted = 0;
  const next = current.flatMap((element) => {
    if (deletes.has(element.id)) {
      deleted += 1;
      return [];
    }
    const primaryProps = primary.get(element.id);
    const secondaryProps = secondary.get(element.id);
    if (!primaryProps && !secondaryProps) return [element];
    if (primaryProps) updated += 1;
    else adjusted += 1;
    return [
      {
        ...element,
        ...(primaryProps ?? {}),
        ...(secondaryProps ?? {}),
        version: element.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      } as SceneElement,
    ];
  });

  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { updated, deleted, adjusted, skipped, grid: gridResult() };
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
    case "connect-elements":
      return mutationResult(api, connectElements(api, request.params));
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
    "connect-elements",
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
