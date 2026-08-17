import { describe, expect, it, vi } from "vitest";

import { CanvasBridge } from "../src/main/canvas-bridge";
import type { CanvasRequest } from "../src/shared/contracts";
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
    close: vi.fn(),
  } as unknown as RuntimeLedger;
}

describe("canvas browser transport", () => {
  it("fails immediately when no browser canvas is connected", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => false, 15_000);
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
      1_000,
    );

    await expect(bridge.request("get-scene-summary")).resolves.toEqual([{ type: "rectangle" }]);
    expect(request?.op).toBe("get-scene-summary");
  });

  it("accepts a renderer scene produced after the gateway revision advanced", async () => {
    const ledger = ledgerStub();
    const bridge = new CanvasBridge(ledger, () => true, 1_000);

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
    const bridge = new CanvasBridge(ledger, () => true, 1_000);

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

    const bridge = new CanvasBridge(ledger, () => true, 1_000);

    expect(bridge.getSnapshot()).toEqual({ revision: 0, elements: [], appState: {} });
  });

  it("persists the renderer result of an agent transaction and hides the transport snapshot", async () => {
    const ledger = ledgerStub();
    const bridge: CanvasBridge = new CanvasBridge(
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
    const bridge = new CanvasBridge(ledgerStub(), () => true, 1_000);
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

  it("names labelled elements newly enclosed by a drawn shape", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => true, 1_000);
    const summaries: string[] = [];
    bridge.onHumanChange = (summary) => summaries.push(summary);

    await bridge.submitHumanSnapshot({
      revision: 1,
      elements: [
        { id: "login", type: "rectangle", x: 100, y: 100, width: 160, height: 60 },
        { id: "login-label", type: "text", x: 120, y: 120, width: 60, height: 20, text: "Login", containerId: "login" },
        { id: "dashboard", type: "rectangle", x: 320, y: 100, width: 180, height: 60 },
        { id: "dashboard-label", type: "text", x: 340, y: 120, width: 100, height: 20, text: "Dashboard", containerId: "dashboard" },
        { id: "ring", type: "ellipse", x: 50, y: 50, width: 500, height: 180 },
      ],
      appState: {},
    });

    expect(summaries[0]).toContain("User drew an ellipse around: Login, Dashboard");
  });

  it("keeps the existing summary when an enclosing shape contains nothing", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => true, 1_000);
    const summaries: string[] = [];
    bridge.onHumanChange = (summary) => summaries.push(summary);

    await bridge.submitHumanSnapshot({
      revision: 1,
      elements: [{ id: "ring", type: "ellipse", x: 50, y: 50, width: 500, height: 180 }],
      appState: {},
    });

    expect(summaries[0]).toBe("User changed 1 ellipse; board now has 1 elements");
  });

  it("describes only the outer enclosure when nested shapes arrive together", async () => {
    const bridge = new CanvasBridge(ledgerStub(), () => true, 1_000);
    const summaries: string[] = [];
    bridge.onHumanChange = (summary) => summaries.push(summary);

    await bridge.submitHumanSnapshot({
      revision: 1,
      elements: [
        { id: "item", type: "rectangle", x: 180, y: 120, width: 100, height: 50 },
        { id: "inner", type: "ellipse", x: 140, y: 90, width: 180, height: 120 },
        { id: "outer", type: "ellipse", x: 80, y: 40, width: 300, height: 220 },
      ],
      appState: {},
    });

    expect(summaries[0].match(/User drew an ellipse around:/g)).toHaveLength(1);
    expect(summaries[0]).toContain("item");
  });
});

describe("request identity across bridges", () => {
  // Switching projects builds a new bridge while the renderer may still be
  // about to answer the old one's last request. Restarting the numbering
  // would let that answer resolve an unrelated request on the new board.
  it("never reuses a request id, even for a freshly built bridge", async () => {
    const ids: number[] = [];
    const send = (request: CanvasRequest) => {
      ids.push(request.id);
      return true;
    };
    const first = new CanvasBridge(ledgerStub(), send, 50);
    const second = new CanvasBridge(ledgerStub(), send, 50);

    await expect(Promise.allSettled([
      first.request("get-scene-summary"),
      second.request("get-scene-summary"),
      second.request("get-scene-summary"),
    ])).resolves.toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The renderer keeps one preview high-water mark for its whole life and
  // discards anything at or below it, so a bridge restarting at 1 would have
  // every frame of the new project's drawing judged stale and never painted.
  it("keeps preview versions climbing across a new bridge", () => {
    const versions: number[] = [];
    const send = (request: CanvasRequest) => {
      versions.push((request.params as { __previewVersion: number }).__previewVersion);
      return true;
    };
    const first = new CanvasBridge(ledgerStub(), send, 50);
    first.previewDiagram({ nodes: [] });
    first.previewDiagram({ nodes: [] });
    new CanvasBridge(ledgerStub(), send, 50).previewDiagram({ nodes: [] });

    expect(versions).toHaveLength(3);
    expect(versions[2]).toBeGreaterThan(versions[1]);
    expect(versions[1]).toBeGreaterThan(versions[0]);
  });
});
