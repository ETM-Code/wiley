/**
 * Who owns the camera.
 *
 * The board is a shared surface, and the viewport is the one part of it that
 * cannot be shared: two people cannot look at different corners through the
 * same window. So the rule is that the agent may frame a drawing the person
 * has not seen yet, and may never take the view back off them afterwards.
 *
 * The bookkeeping is one remembered camera. Every deliberate move the agent
 * makes records where it left the view; if the live camera still reads the
 * same, nobody has touched it since and the agent may move it again. The
 * moment the reading differs, the person has panned or zoomed and the agent
 * stops driving until it has something genuinely new to show.
 */

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { finiteNumber as finite, type PlanBounds } from "../diagram-layout";
import type { SceneElement } from "./types";

type Camera = { scrollX: number; scrollY: number; zoom: number };

/** Where the agent last put the view, or null while nobody has claimed it. */
let placed: Camera | null = null;

/** Scroll is in scene units and zoom is a ratio, so both tolerate a hair of drift. */
const CAMERA_EPSILON = 0.5;
const ZOOM_EPSILON = 0.001;

function cameraOf(api: ExcalidrawImperativeAPI): Camera {
  const state = api.getAppState() as {
    scrollX?: number;
    scrollY?: number;
    zoom?: { value?: number };
  };
  return {
    scrollX: finite(state.scrollX),
    scrollY: finite(state.scrollY),
    zoom: finite(state.zoom?.value, 1) || 1,
  };
}

/**
 * Whether the view is still exactly where the agent last left it. True before
 * the agent has ever moved it: an untouched camera is nobody's in particular.
 */
export function agentOwnsViewport(api: ExcalidrawImperativeAPI): boolean {
  if (!placed) return true;
  const now = cameraOf(api);
  return Math.abs(now.scrollX - placed.scrollX) <= CAMERA_EPSILON
    && Math.abs(now.scrollY - placed.scrollY) <= CAMERA_EPSILON
    && Math.abs(now.zoom - placed.zoom) <= ZOOM_EPSILON;
}

/**
 * Forgets the claim. A project switch throws away the scene the remembered
 * camera was pointed at, so holding on to it would have the next board judged
 * against a view of a different one.
 */
export function forgetAgentViewport(): void {
  placed = null;
}

/** Zooms the view to hold the given elements, and remembers where that left it. */
export async function frameContent(
  api: ExcalidrawImperativeAPI,
  elements: readonly SceneElement[],
): Promise<void> {
  await api.scrollToContent(elements as Parameters<typeof api.scrollToContent>[0], {
    fitToViewport: true,
    viewportZoomFactor: 0.9,
    animate: false,
  });
  placed = cameraOf(api);
}

/** The part of the scene the person can currently see, in scene coordinates. */
export function visibleBounds(api: ExcalidrawImperativeAPI): PlanBounds | null {
  const state = api.getAppState() as {
    scrollX?: number;
    scrollY?: number;
    width?: number;
    height?: number;
    zoom?: { value?: number };
  };
  const width = finite(state.width);
  const height = finite(state.height);
  const zoom = finite(state.zoom?.value, 1) || 1;
  if (width <= 0 || height <= 0) return null;
  const minX = -finite(state.scrollX);
  const minY = -finite(state.scrollY);
  return { minX, minY, maxX: minX + width / zoom, maxY: minY + height / zoom };
}

/** Whether any part of the given box is on screen right now. */
export function isVisible(api: ExcalidrawImperativeAPI, bounds: PlanBounds): boolean {
  const view = visibleBounds(api);
  // No readable viewport is not evidence of absence, and moving the camera on
  // a guess is exactly the behaviour this module exists to stop.
  if (!view) return true;
  return bounds.minX < view.maxX && view.minX < bounds.maxX
    && bounds.minY < view.maxY && view.minY < bounds.maxY;
}

/**
 * Slides the view until the given elements are on screen, without touching the
 * zoom. The gentlest correction there is: the person keeps the scale they
 * chose and only loses the corner they were looking at, which they had already
 * lost the moment the thing they asked about moved off it.
 */
export async function panIntoView(
  api: ExcalidrawImperativeAPI,
  elements: readonly SceneElement[],
): Promise<void> {
  if (elements.length === 0) return;
  await api.scrollToContent(elements as Parameters<typeof api.scrollToContent>[0], {
    animate: false,
  });
  placed = cameraOf(api);
}
