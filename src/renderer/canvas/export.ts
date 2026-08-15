import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { uint8ToBase64 } from "./scene-summary";

export async function exportScenePng(api: ExcalidrawImperativeAPI): Promise<string> {
  const blob = await exportToBlob({
    elements: api.getSceneElements(),
    appState: { ...api.getAppState(), exportBackground: true },
    files: api.getFiles(),
    mimeType: "image/png",
  });
  return uint8ToBase64(new Uint8Array(await blob.arrayBuffer()));
}
