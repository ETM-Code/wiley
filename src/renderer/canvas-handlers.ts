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

type GraphNode = { id: string; label: string; kind?: "box" | "diamond" | "ellipse" };
type GraphEdge = { from: string; to: string; label?: string };
type LayoutParams = { nodes: GraphNode[]; edges: GraphEdge[]; anchor?: string };
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

function pauseForStreaming(milliseconds: number): Promise<void> {
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

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function placementOrigin(api: ExcalidrawImperativeAPI, anchor?: string): { x: number; y: number } {
  const elements = api.getSceneElements().filter(
    (element) => Number.isFinite(element.x) && Number.isFinite(element.y)
      && Number.isFinite(element.width) && Number.isFinite(element.height),
  );
  const anchored = anchor ? elements.find((element) => element.id === anchor) : undefined;
  if (anchored) return { x: anchored.x + anchored.width + 100, y: anchored.y };

  if (elements.length === 0) {
    const state = api.getAppState();
    return {
      x: Math.max(80, -finite(state.scrollX) + 120),
      y: Math.max(80, -finite(state.scrollY) + 120),
    };
  }

  const right = Math.max(...elements.map((element) => element.x + element.width));
  const top = Math.min(...elements.map((element) => element.y));
  return { x: right + 120, y: top };
}

function kindToType(kind?: GraphNode["kind"]): "rectangle" | "diamond" | "ellipse" {
  if (kind === "diamond") return "diamond";
  if (kind === "ellipse") return "ellipse";
  return "rectangle";
}

async function addShape(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as ShapeParams;
  if (!["rectangle", "ellipse", "diamond"].includes(params?.shape)) {
    throw new Error("add-shape requires rectangle, ellipse, or diamond");
  }
  const width = Math.min(800, Math.max(24, finite(params.width, 220)));
  const height = Math.min(800, Math.max(24, finite(params.height, width)));
  const state = api.getAppState();
  const center = viewportCoordsToSceneCoords(
    { clientX: state.width / 2, clientY: state.height / 2 },
    state,
  );
  const skeleton = {
    id: `agent-shape-${crypto.randomUUID()}`,
    type: params.shape,
    x: center.x - width / 2,
    y: center.y - height / 2,
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
  return { count: created.length, ids: created.map((element) => element.id), center };
}

async function layoutDiagram(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as LayoutParams;
  if (!Array.isArray(params?.nodes) || params.nodes.length === 0) {
    throw new Error("layout-diagram requires at least one node");
  }

  const nodeIds = new Set<string>();
  for (const node of params.nodes) {
    if (!node?.id || !node.label || nodeIds.has(node.id)) {
      throw new Error("Diagram nodes require unique ids and non-empty labels");
    }
    nodeIds.add(node.id);
  }
  for (const edge of params.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Diagram edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
  }

  const layout = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "72",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
    },
    children: params.nodes.map((node) => ({ id: node.id, width: 180, height: 72 })),
    edges: (params.edges ?? []).map((edge, index) => ({
      id: `edge-${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  });

  const origin = placementOrigin(api, params.anchor);
  const positions = new Map(
    (layout.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
  );
  const edgeSections = new Map(
    ((layout.edges ?? []) as ElkExtendedEdge[]).map((edge) => [edge.id, edge.sections?.[0]]),
  );
  const idPrefix = `agent-${Date.now().toString(36)}`;
  const elementIdByNode = new Map(
    params.nodes.map((node, index) => [node.id, `${idPrefix}-node-${index}`]),
  );

  const skeletons: JsonObject[] = params.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    return {
      id: elementIdByNode.get(node.id),
      type: kindToType(node.kind),
      x: origin.x + position.x,
      y: origin.y + position.y,
      width: 180,
      height: 72,
      label: { text: node.label },
    };
  });
  skeletons.push(
    ...(params.edges ?? []).map((edge, index) => {
      const from = positions.get(edge.from) ?? { x: 0, y: 0 };
      const to = positions.get(edge.to) ?? { x: 0, y: 0 };
      const fromCenter = { x: origin.x + from.x + 90, y: origin.y + from.y + 36 };
      const toCenter = { x: origin.x + to.x + 90, y: origin.y + to.y + 36 };
      const dx = toCenter.x - fromCenter.x;
      const dy = toCenter.y - fromCenter.y;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const startX = horizontal ? fromCenter.x + Math.sign(dx || 1) * 90 : fromCenter.x;
      const startY = horizontal ? fromCenter.y : fromCenter.y + Math.sign(dy || 1) * 36;
      const endX = horizontal ? toCenter.x - Math.sign(dx || 1) * 90 : toCenter.x;
      const endY = horizontal ? toCenter.y : toCenter.y - Math.sign(dy || 1) * 36;
      const section = edgeSections.get(`edge-${index}`);
      const routed = section?.startPoint && section.endPoint
        ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        : undefined;
      const routeOrigin = routed?.[0];
      return {
        id: `${idPrefix}-edge-${index}`,
        type: "arrow",
        x: routeOrigin ? origin.x + routeOrigin.x : startX,
        y: routeOrigin ? origin.y + routeOrigin.y : startY,
        points: routed && routeOrigin
          ? routed.map((point) => [point.x - routeOrigin.x, point.y - routeOrigin.y])
          : [[0, 0], [endX - startX, endY - startY]],
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
  const existing = [...api.getSceneElements()];
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
  const nodeGroups = convertedNodes.map((element) => [
    element,
    ...(labelsByContainer.get(element.id) ?? []),
  ]);
  const edgeGroups = convertedEdges.map((element) => [
    element,
    ...(labelsByContainer.get(element.id) ?? []),
  ]);
  const groupedIds = new Set([...nodeGroups, ...edgeGroups].flat().map((element) => element.id));
  const leftovers = created.filter((element) => !groupedIds.has(element.id));
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
  const nodeDelay = Math.max(70, Math.min(160, Math.round(1_200 / Math.max(1, nodeGroups.length))));
  for (let index = 0; index < nodeGroups.length; index++) {
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

  return {
    count: created.length,
    idMap: Object.fromEntries(params.nodes.map((node, index) => [
      node.id,
      convertedNodes[index]?.id ?? elementIdByNode.get(node.id),
    ])),
  };
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
    item.x = finite(item.x, index * 24) + anchorX;
    item.y = finite(item.y, index * 24) + anchorY;
    item.width = Math.max(1, finite(item.width, 160));
    item.height = Math.max(1, finite(item.height, 64));

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
  return { count: created.length, ids: created.map((element) => element.id) };
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
    const safeProps = Object.fromEntries(
      Object.entries(asRecord(requested)).filter(([key]) => !protectedProps.has(key)),
    );
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
  return { updated, deleted, skipped };
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
