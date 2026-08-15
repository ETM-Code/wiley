import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  MODEL_GRID_SIZE,
  finiteNumber as finite,
  snapModelCoordinate,
  snapModelSize,
} from "../diagram-layout";
import { asRecord, directionalOrigin, elementsBounds, finiteGeometry, gridResult } from "./geometry";
import type { JsonObject, SceneElement } from "./types";

type AddParams = {
  elements: JsonObject[];
  placeNear?: string;
  placeDirection?: "right" | "left" | "above" | "below";
  scrollTo?: boolean;
};

export function sanitizeSkeletons(api: ExcalidrawImperativeAPI, value: unknown): AddParams {
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

  // Models place standalone headings by eye and land them on top of nodes.
  // Nudge any free text clear of existing elements instead of rendering the
  // collision.
  const obstacles = finiteGeometry(existing).map((element) => ({
    id: element.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  }));
  for (const item of elements) {
    if (item.type !== "text" || typeof item.containerId === "string") continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const box = {
        x: finite(item.x),
        y: finite(item.y),
        width: finite(item.width, 160),
        height: finite(item.height, 40),
      };
      const hit = obstacles.find((obstacle) =>
        box.x < obstacle.x + obstacle.width
        && obstacle.x < box.x + box.width
        && box.y < obstacle.y + obstacle.height
        && obstacle.y < box.y + box.height);
      if (!hit) break;
      item.y = snapModelCoordinate(hit.y - box.height - 20);
    }
  }

  return { ...params, elements };
}

export async function addElements(api: ExcalidrawImperativeAPI, value: unknown) {
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
