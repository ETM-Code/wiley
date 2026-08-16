import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { uint8ToBase64 } from "./scene-summary";

export async function exportScenePng(api: ExcalidrawImperativeAPI): Promise<string> {
  const blob = await exportToBlob({
    elements: api.getSceneElements(),
    // The agent reads this PNG to see what it drew, and its palette is written
    // for a light board. Dark mode is a viewing filter over the same scene, so
    // the export stays light whatever the window looks like.
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
    files: api.getFiles(),
    mimeType: "image/png",
  });
  return uint8ToBase64(new Uint8Array(await blob.arrayBuffer()));
}
