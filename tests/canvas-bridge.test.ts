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
    putBoardSnapshot: vi.fn(),
    getBoardSnapshot: vi.fn(),
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

  it("accepts a renderer scene produced after the gateway revision advanced", async () => {
    const ledger = ledgerStub();
    const bridge = new CanvasBridge(ledger, () => true, () => undefined, 1_000);

    const snapshot = await bridge.submitHumanSnapshot({
      revision: 0,
      elements: [{ id: "shape-1", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }],
      appState: {},
    });

    expect(snapshot.revision).toBe(1);
    expect(snapshot.elements).toHaveLength(1);
    expect(ledger.putBoardSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects non-finite scene geometry without replacing the canonical snapshot", async () => {
    const ledger = ledgerStub();
    const bridge = new CanvasBridge(ledger, () => true, () => undefined, 1_000);

    await expect(bridge.submitHumanSnapshot({
      revision: 1,
      elements: [{ id: "bad-arrow", type: "arrow", x: Number.NaN, y: 0, width: 10, height: 10 }],
      appState: {},
    })).rejects.toThrow(/invalid x/i);

    expect(bridge.getSnapshot().elements).toEqual([]);
    expect(ledger.putBoardSnapshot).not.toHaveBeenCalled();
  });

  it("ignores an invalid persisted scene during startup", () => {
    const ledger = ledgerStub();
    vi.mocked(ledger.getBoardSnapshot).mockReturnValue({
      revision: 42,
      elements: [{ id: "bad", type: "rectangle", x: null, y: 0, width: 10, height: 10 }],
      appState: {},
    });

    const bridge = new CanvasBridge(ledger, () => true, () => undefined, 1_000);

    expect(bridge.getSnapshot()).toEqual({ revision: 0, elements: [], appState: {} });
  });

  it("persists the renderer result of an agent transaction and hides the transport snapshot", async () => {
    const ledger = ledgerStub();
    let bridge: CanvasBridge;
    bridge = new CanvasBridge(
      ledger,
      (request) => {
        queueMicrotask(() => bridge.acceptResponse({
          id: request.id,
          result: {
            count: 1,
            __boardSnapshot: {
              elements: [{ id: "node-1", type: "rectangle", x: 20, y: 30, width: 180, height: 72 }],
              appState: { viewBackgroundColor: "#ffffff" },
            },
          },
        }));
        return true;
      },
      () => undefined,
      1_000,
    );

    const result = await bridge.applyTransaction({
      id: "tx-1",
      idempotencyKey: "tx-1-once",
      agentId: "root",
      jobId: "job-1",
      baseRevision: 0,
      summary: "draw",
      operation: "layout-diagram",
      params: { nodes: [], edges: [] },
    });

    expect(result).toEqual({ revision: 1, result: { count: 1 } });
    expect(bridge.getSnapshot().elements).toHaveLength(1);
    expect(ledger.putBoardSnapshot).toHaveBeenCalledOnce();
  });

  it("reports a human change summary with types, texts, and removals", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => true, () => undefined, 1_000);
    const summaries: string[] = [];
    bridge.onHumanChange = (summary) => summaries.push(summary);

    await bridge.submitHumanSnapshot({
      revision: 1,
      elements: [
        { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 },
        { id: "b", type: "text", x: 10, y: 10, width: 80, height: 20, text: "magic" },
      ],
      appState: {},
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("1 rectangle");
    expect(summaries[0]).toContain("1 text");
    expect(summaries[0]).toContain("magic");
    expect(summaries[0]).toContain("board now has 2 elements");

    await bridge.submitHumanSnapshot({
      revision: 2,
      elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }],
      appState: {},
    });
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toContain("1 removed");

    // Identical resubmission is not a human change.
    await bridge.submitHumanSnapshot({
      revision: 3,
      elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 }],
      appState: {},
    });
    expect(summaries).toHaveLength(2);
  });
});
