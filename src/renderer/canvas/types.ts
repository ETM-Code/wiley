import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type JsonObject = Record<string, unknown>;
export type SceneElement = ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>[number];
