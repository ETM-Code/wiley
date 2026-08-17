import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  agentOwnsViewport,
  forgetAgentViewport,
  frameContent,
  isVisible,
  panIntoView,
  visibleBounds,
} from "../src/renderer/canvas/viewport";
import type { SceneElement } from "../src/renderer/canvas/types";

type Camera = { scrollX: number; scrollY: number; zoom: number };

/** A board whose camera moves only when something asks it to. */
function board(camera: Camera = { scrollX: 0, scrollY: 0, zoom: 1 }) {
  const state = { ...camera, width: 1_000, height: 700 };
  const scrollToContent = vi.fn(async (..._args: unknown[]) => undefined);
  const api = {
    getAppState: () => ({ ...state, zoom: { value: state.zoom } }),
    scrollToContent,
    getSceneElements: () => [],
  } as unknown as ExcalidrawImperativeAPI;
  return {
    api,
    scrollToContent,
    /** What the editor would do on its own: the person drags the canvas. */
    moveCamera(next: Partial<Camera>) {
      Object.assign(state, next);
    },
  };
}

const anywhere = [{ id: "one", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] as unknown as SceneElement[];

beforeEach(() => forgetAgentViewport());

describe("viewport ownership", () => {
  it("treats a camera nobody has moved as free to use", () => {
    expect(agentOwnsViewport(board().api)).toBe(true);
  });

  it("keeps ownership while the view sits where it was left", async () => {
    const target = board();
    await frameContent(target.api, anywhere);
    expect(target.scrollToContent).toHaveBeenCalledWith(anywhere, {
      fitToViewport: true,
      viewportZoomFactor: 0.9,
      animate: false,
    });
    expect(agentOwnsViewport(target.api)).toBe(true);
  });

  it("gives the camera up the moment the person pans", async () => {
    const target = board();
    await frameContent(target.api, anywhere);
    target.moveCamera({ scrollX: -400 });
    expect(agentOwnsViewport(target.api)).toBe(false);
  });

  it("gives the camera up the moment the person zooms", async () => {
    const target = board();
    await frameContent(target.api, anywhere);
    target.moveCamera({ zoom: 1.4 });
    expect(agentOwnsViewport(target.api)).toBe(false);
  });

  it("forgets the claim when the board it pointed at is gone", async () => {
    const target = board();
    await frameContent(target.api, anywhere);
    target.moveCamera({ scrollX: -400 });
    forgetAgentViewport();
    expect(agentOwnsViewport(target.api)).toBe(true);
  });
});

describe("what the person can see", () => {
  it("reads the visible rectangle out of the scroll and the zoom", () => {
    const target = board({ scrollX: -200, scrollY: -100, zoom: 2 });
    expect(visibleBounds(target.api)).toEqual({ minX: 200, minY: 100, maxX: 700, maxY: 450 });
  });

  it("counts a box that only overlaps the edge as visible", () => {
    const target = board();
    expect(isVisible(target.api, { minX: 960, minY: 660, maxX: 1_200, maxY: 900 })).toBe(true);
  });

  it("counts a box past the edge as hidden", () => {
    const target = board();
    expect(isVisible(target.api, { minX: 1_400, minY: 40, maxX: 1_800, maxY: 300 })).toBe(false);
  });

  // No readable viewport is not evidence of absence, and moving the camera on
  // a guess is exactly what this module exists to stop.
  it("assumes visible when there is no viewport to measure", () => {
    const api = {
      getAppState: () => ({ scrollX: 0, scrollY: 0, width: 0, height: 0, zoom: { value: 1 } }),
    } as unknown as ExcalidrawImperativeAPI;
    expect(visibleBounds(api)).toBeNull();
    expect(isVisible(api, { minX: 9_000, minY: 9_000, maxX: 9_100, maxY: 9_100 })).toBe(true);
  });
});

describe("panIntoView", () => {
  it("slides the view without asking for a new zoom", async () => {
    const target = board();
    await panIntoView(target.api, anywhere);
    expect(target.scrollToContent).toHaveBeenCalledWith(anywhere, { animate: false });
    const options = target.scrollToContent.mock.calls[0][1] as Record<string, unknown>;
    expect(options.fitToViewport).toBeUndefined();
    expect(options.fitToContent).toBeUndefined();
    expect(options.viewportZoomFactor).toBeUndefined();
  });

  it("does nothing when there is nothing to show", async () => {
    const target = board();
    await panIntoView(target.api, []);
    expect(target.scrollToContent).not.toHaveBeenCalled();
  });
});
