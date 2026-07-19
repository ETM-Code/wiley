import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceBridge } from "../src/main/voice-bridge";

afterEach(() => vi.useRealTimers());

describe("voice question bridge", () => {
  it("resolves the oldest pending question with the spoken answer", async () => {
    const sent: unknown[] = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    const answer = bridge.ask("Which layout?", undefined, 1_000);
    expect(sent).toHaveLength(1);
    expect(bridge.deliverAnswer("Top to bottom")).toBe(true);
    await expect(answer).resolves.toBe("Top to bottom");
    expect(bridge.deliverAnswer("unused")).toBe(false);
  });

  it("unblocks a pending question when its run is aborted", async () => {
    const controller = new AbortController();
    const bridge = new VoiceBridge(() => undefined);
    const answer = bridge.ask("Continue?", controller.signal, 1_000);
    controller.abort();
    await expect(answer).resolves.toMatch(/aborted/i);
  });

  it("suppresses early and repetitive progress narration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: unknown[] = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    bridge.beginWork();
    bridge.push("[agent progress] starting");
    expect(sent).toHaveLength(0);

    // Narration starts after the instant-task window (3s), then repeats no
    // more often than every 10s.
    vi.advanceTimersByTime(3_000);
    bridge.push("[agent progress] useful milestone");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    bridge.push("[agent progress] too soon");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    bridge.push("[agent progress] next useful milestone");
    expect(sent).toHaveLength(2);
  });

  it("debounces board updates into one silent context injection", () => {
    vi.useFakeTimers();
    const sent: Array<{ text: string; silent?: boolean; interrupt: boolean }> = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    bridge.pushBoardUpdate("User changed 1 rectangle; board now has 3 elements");
    bridge.pushBoardUpdate("User changed 2 rectangle; board now has 5 elements");
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(4_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].silent).toBe(true);
    expect(sent[0].interrupt).toBe(false);
    // Only the latest summary survives the debounce window.
    expect(sent[0].text).toBe("[board update] User changed 2 rectangle; board now has 5 elements");
  });
});
