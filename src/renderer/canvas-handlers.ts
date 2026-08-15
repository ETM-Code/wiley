import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { bridge, type CanvasRequest } from "./bridge";
import { addShape, layoutDiagram } from "./canvas/diagram-render";
import { exportScenePng } from "./canvas/export";
import { applyPatch, connectElements } from "./canvas/patch";
import { clearDiagramPreview } from "./canvas/preview-state";
import { sceneSummary } from "./canvas/scene-summary";
import { addElements } from "./canvas/skeletons";

export { MODEL_GRID_SIZE, snapModelCoordinate } from "./diagram-layout";
export { isDiagramPreviewActive, withoutDiagramPreviewElements } from "./canvas/preview-state";

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
    case "export-png":
      return exportScenePng(api);
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
