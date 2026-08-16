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

  it("holds the opening line past the instant-task window, then rations the rest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: Array<{ text: string }> = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    // The opening narration always lands immediately, so it is held rather
    // than dropped; the work here outlives the window, so it gets spoken.
    bridge.beginWork();
    bridge.push("[agent progress] starting");
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(3_000);
    expect(sent.map((message) => message.text)).toEqual(["[agent progress] starting"]);

    // Then narration repeats no more often than every 10s.
    bridge.push("[agent progress] too soon");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    expect(sent.map((message) => message.text)).toEqual([
      "[agent progress] starting",
      "[agent progress] too soon",
    ]);
  });

  it("paces a line that arrives inside the interval instead of losing it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: Array<{ text: string }> = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    // The agent is told to narrate every time it extends the drawing, and on
    // a real task those land closer together than the interval.
    bridge.beginWork();
    vi.advanceTimersByTime(6_000);
    bridge.push("[agent progress] read the guard");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(8_000);
    bridge.push("[agent progress] extended the diagram");
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(2_000);
    expect(sent.map((message) => message.text)).toEqual([
      "[agent progress] read the guard",
      "[agent progress] extended the diagram",
    ]);
  });

  it("never speaks the opening line of a task that finishes instantly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: unknown[] = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    bridge.beginWork();
    bridge.push("[agent progress] starting");
    vi.advanceTimersByTime(500);
    bridge.endWork();

    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0);
  });

  it("keeps only the latest line still waiting out the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: Array<{ text: string }> = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    bridge.beginWork();
    bridge.push("[agent progress] reading the guard");
    vi.advanceTimersByTime(500);
    bridge.push("[agent progress] now drawing it");

    vi.advanceTimersByTime(3_000);
    expect(sent.map((message) => message.text)).toEqual(["[agent progress] now drawing it"]);
  });

  it("still ignores narration when no work is running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sent: unknown[] = [];
    const bridge = new VoiceBridge((payload) => sent.push(payload));

    bridge.push("[agent progress] unprompted");
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0);
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
