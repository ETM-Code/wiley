import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { finiteNumber as finite, measureText, wrapLabel } from "../diagram-layout";
import { asRecord, gridResult, perimeterPoint, snapModelGeometry } from "./geometry";
import type { JsonObject, SceneElement } from "./types";

type PatchParams = {
  updates?: Array<{ id: string; props?: JsonObject } & JsonObject>;
  deletes?: string[];
};

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

/**
 * Connects existing elements (including human-drawn ones) with bound arrows.
 * The route is computed here, perimeter to perimeter, and the bindings are
 * written explicitly so the arrows follow the shapes when either end moves.
 */
export function connectElements(api: ExcalidrawImperativeAPI, value: unknown) {
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

export function applyPatch(api: ExcalidrawImperativeAPI, value: unknown) {
  const params = value as PatchParams;
  const current = api.getSceneElements() as readonly PatchableElement[];
  const byId = new Map(current.map((element) => [element.id, element]));
  const deletes = new Set(Array.isArray(params?.deletes) ? params.deletes : []);
  for (const id of [...deletes]) {
    for (const bound of byId.get(id)?.boundElements ?? []) {
      if (bound?.type === "text") deletes.add(bound.id);
    }
  }
  // Models frequently send {id, text} instead of {id, props:{text}}; both
  // must work, silently counting the flat shape as a no-op would lie.
  const updates = new Map(
    (Array.isArray(params?.updates) ? params.updates : []).map((patch) => {
      const { id, props, ...rest } = patch;
      return [String(id), (props && typeof props === "object" ? props : rest) as JsonObject];
    }),
  );
  const requestedIds = [...updates.keys(), ...deletes];
  const skipped = [...new Set(requestedIds.filter((id) => !byId.has(id)))];

  // Identity and structural bookkeeping the renderer owns. customData carries
  // the diagram stamp every later lookup depends on; frameId and index belong
  // to Excalidraw's own scene ordering.
  const protectedProps = new Set([
    "id", "seed", "version", "versionNonce", "updated", "boundElements", "containerId", "groupIds",
    "customData", "frameId", "index",
  ]);
  const primary = new Map<string, JsonObject>();
  const secondary = new Map<string, JsonObject>();
  const mergeSecondary = (id: string, props: JsonObject) => {
    if (deletes.has(id)) return;
    secondary.set(id, { ...(secondary.get(id) ?? {}), ...props });
  };
  const arrowShifts = new Map<string, { sdx: number; sdy: number; edx: number; edy: number }>();
  const createdLabels: SceneElement[] = [];

  for (const [id, requested] of updates) {
    const element = byId.get(id);
    if (!element || deletes.has(id)) continue;
    const safeProps = snapModelGeometry(Object.fromEntries(
      Object.entries(asRecord(requested)).filter(([key]) => !protectedProps.has(key)),
    ));

    // A text edit aimed at a shape belongs on its bound label; shapes with
    // no label yet get a real bound label created for them.
    const boundTextId = (element.boundElements ?? []).find((bound) => bound?.type === "text")?.id;
    if (element.type !== "text" && element.type !== "arrow"
      && ("text" in safeProps || "fontSize" in safeProps)) {
      const targetX = "x" in safeProps ? finite(safeProps.x, element.x) : element.x;
      const targetY = "y" in safeProps ? finite(safeProps.y, element.y) : element.y;
      const targetWidth = "width" in safeProps ? finite(safeProps.width, element.width) : element.width;
      const targetHeight = "height" in safeProps ? finite(safeProps.height, element.height) : element.height;
      if (boundTextId) {
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
      } else if (typeof safeProps.text === "string" && safeProps.text.trim()) {
        const fontSize = finite(safeProps.fontSize, 20);
        // Wrap to the container's usable width up front: the label is
        // created after conversion, so Excalidraw will not re-wrap it.
        const inscribed = element.type === "diamond" ? 2 : element.type === "ellipse" ? Math.SQRT2 : 1;
        const usableWidth = Math.max(60, targetWidth / inscribed - 24);
        const wrapped = wrapLabel(safeProps.text, fontSize, usableWidth).join("\n");
        const [label] = convertToExcalidrawElements([{
          type: "text",
          text: wrapped,
          fontSize,
          fontFamily: 5,
          x: targetX,
          y: targetY,
        }] as Parameters<typeof convertToExcalidrawElements>[0]) as unknown as PatchableElement[];
        if (label) {
          const labelWidth = finite(label.width, 100);
          const labelHeight = finite(label.height, fontSize * 1.25);
          Object.assign(label, {
            containerId: element.id,
            textAlign: "center",
            verticalAlign: "middle",
            originalText: safeProps.text,
            x: targetX + (targetWidth - labelWidth) / 2,
            y: targetY + (targetHeight - labelHeight) / 2,
          });
          createdLabels.push(label as SceneElement);
          mergeSecondary(element.id, {
            boundElements: [...(element.boundElements ?? []), { id: label.id, type: "text" }],
          });
        }
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

  api.updateScene({
    elements: [...next, ...createdLabels],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return {
    updated,
    deleted,
    adjusted,
    createdLabels: createdLabels.length,
    skipped,
    grid: gridResult(),
  };
}
