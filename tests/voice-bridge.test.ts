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

    vi.advanceTimersByTime(8_000);
    bridge.push("[agent progress] useful milestone");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    bridge.push("[agent progress] too soon");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    bridge.push("[agent progress] next useful milestone");
    expect(sent).toHaveLength(2);
  });
});
