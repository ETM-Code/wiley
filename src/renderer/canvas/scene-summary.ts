import type { SceneElement } from "./types";

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function sceneSummary(elements: readonly SceneElement[]) {
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
