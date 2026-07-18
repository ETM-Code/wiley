import { describe, expect, it, vi } from "vitest";

import { CanvasBridge } from "../src/main/canvas-bridge";
import type { CanvasRequest } from "../src/main/contracts";
import type { RuntimeLedger } from "../src/main/ledger";

function ledgerStub(): RuntimeLedger {
  return {
    initialize: vi.fn(),
    appendTranscript: vi.fn(),
    getTranscript: vi.fn(() => []),
    appendAgentEvent: vi.fn(),
    getAgentEvents: vi.fn(() => []),
    putJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(() => []),
    appendBoardTransaction: vi.fn(),
    hasBoardTransaction: vi.fn(() => false),
  } as unknown as RuntimeLedger;
}

describe("canvas browser transport", () => {
  it("fails immediately when no browser canvas is connected", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => false, () => undefined, 15_000);
    const started = performance.now();

    await expect(bridge.request("get-scene-summary")).rejects.toThrow(/no active browser client/i);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("completes a request when the browser returns the matching response", async () => {
    let request: CanvasRequest | undefined;
    const bridge = new CanvasBridge(
      ledgerStub(),
      (next) => {
        request = next;
        queueMicrotask(() => bridge.acceptResponse({ id: next.id, result: [{ type: "rectangle" }] }));
        return true;
      },
      () => undefined,
      1_000,
    );

    await expect(bridge.request("get-scene-summary")).resolves.toEqual([{ type: "rectangle" }]);
    expect(request?.op).toBe("get-scene-summary");
  });
});
