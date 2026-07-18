import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ELK from "elkjs/lib/elk.bundled";

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
  const elements = api.getSceneElements();
  const anchored = anchor ? elements.find((element) => element.id === anchor) : undefined;
  if (anchored) return { x: anchored.x + anchored.width + 100, y: anchored.y };

  if (elements.length === 0) {
    const state = api.getAppState();
    return { x: Math.max(80, -state.scrollX + 120), y: Math.max(80, -state.scrollY + 120) };
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
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "64",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
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
    ...(params.edges ?? []).map((edge, index) => ({
      id: `${idPrefix}-edge-${index}`,
      type: "arrow",
      start: { id: elementIdByNode.get(edge.from) },
      end: { id: elementIdByNode.get(edge.to) },
      ...(edge.label ? { label: { text: edge.label } } : {}),
    })),
  );

  const created = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  );
  api.updateScene({
    elements: [...api.getSceneElements(), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  await api.scrollToContent(created, { fitToViewport: true, animate: true });

  return {
    count: created.length,
    idMap: Object.fromEntries(elementIdByNode),
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

export async function handleCanvasRequest(
  api: ExcalidrawImperativeAPI,
  request: CanvasRequest,
): Promise<unknown> {
  switch (request.op) {
    case "add-shape":
      return addShape(api, request.params);
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
      return layoutDiagram(api, request.params);
    case "add-elements":
      return addElements(api, request.params);
    case "apply-patch":
      return applyPatch(api, request.params);
    default:
      throw new Error(`Unknown canvas operation: ${String(request.op)}`);
  }
}

export function subscribeToCanvasRequests(
  getApi: () => ExcalidrawImperativeAPI | null,
  onError: (message: string) => void,
): () => void {
  return bridge.onCanvasRequest((request) => {
    const api = getApi();
    if (!api) {
      bridge.respondCanvasRequest({ id: request.id, error: "Canvas is not ready" });
      return;
    }

    void handleCanvasRequest(api, request)
      .then((result) => bridge.respondCanvasRequest({ id: request.id, result }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        onError(message);
        bridge.respondCanvasRequest({ id: request.id, error: message });
      });
  });
}
