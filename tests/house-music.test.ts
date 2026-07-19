import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HouseMusicPlayer } from "../src/renderer/house-music";

class FakeParam {
  value: number;
  ramps: Array<{ target: number; time: number }> = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(target: number, time: number): this {
    this.ramps.push({ target, time });
    this.value = target;
    return this;
  }

  exponentialRampToValueAtTime(target: number, time: number): this {
    this.ramps.push({ target, time });
    this.value = target;
    return this;
  }

  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  connect = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = "";
  frequency = new FakeParam();
  detune = new FakeParam();
  start = vi.fn();
  stop = vi.fn();
}

class FakeFilter extends FakeNode {
  type = "";
  frequency = new FakeParam();
  Q = new FakeParam();
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  sampleRate = 44100;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  bufferSources: FakeBufferSource[] = [];
  mediaSources: FakeNode[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {});

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }

  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array(length) };
  }

  createMediaElementSource(): FakeNode {
    const node = new FakeNode();
    this.mediaSources.push(node);
    return node;
  }
}

type FakeAudioElement = {
  loop: boolean;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
};

function makeAudioElement(): FakeAudioElement {
  const audio: FakeAudioElement = {
    loop: false,
    paused: true,
    play: vi.fn(async () => {
      audio.paused = false;
    }),
    pause: vi.fn(() => {
      audio.paused = true;
    }),
    removeAttribute: vi.fn(),
  };
  return audio;
}

function makePlayer(options: { trackUrl?: string | null; audio?: FakeAudioElement } = {}) {
  const ctx = new FakeAudioContext();
  const player = new HouseMusicPlayer({
    createContext: () => ctx as unknown as AudioContext,
    createAudio: () => (options.audio ?? makeAudioElement()) as unknown as HTMLAudioElement,
    trackUrl: options.trackUrl ?? null,
  });
  return { ctx, player };
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as Parameters<typeof clearInterval>[0]),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

describe("HouseMusicPlayer synth fallback", () => {
  it("fades the master gain in and schedules percussion when started", () => {
    const { ctx, player } = makePlayer();
    player.start();
    expect(player.isPlaying()).toBe(true);
    const master = ctx.gains[1];
    expect(master.gain.ramps.at(-1)?.target).toBeCloseTo(0.16);
    vi.advanceTimersByTime(100);
    expect(ctx.oscillators.length).toBeGreaterThan(0);
    expect(ctx.oscillators[0].start).toHaveBeenCalled();
  });

  it("keeps scheduling as playback time advances", () => {
    const { ctx, player } = makePlayer();
    player.start();
    vi.advanceTimersByTime(100);
    const before = ctx.oscillators.length + ctx.bufferSources.length;
    ctx.currentTime = 2;
    vi.advanceTimersByTime(100);
    expect(ctx.oscillators.length + ctx.bufferSources.length).toBeGreaterThan(before);
  });

  it("fades out and stops scheduling on stop", () => {
    const { ctx, player } = makePlayer();
    player.start();
    vi.advanceTimersByTime(100);
    player.stop();
    expect(player.isPlaying()).toBe(false);
    const master = ctx.gains[1];
    expect(master.gain.ramps.at(-1)?.target).toBe(0);
    const nodesAfterStop = ctx.oscillators.length + ctx.bufferSources.length;
    ctx.currentTime = 5;
    vi.advanceTimersByTime(500);
    expect(ctx.oscillators.length + ctx.bufferSources.length).toBe(nodesAfterStop);
  });
});

describe("HouseMusicPlayer speech fades", () => {
  it("fades to silence while someone speaks and back afterwards", () => {
    const { ctx, player } = makePlayer();
    player.start();
    const speech = ctx.gains[0];
    player.setSpeechActive(true);
    expect(speech.gain.ramps.at(-1)?.target).toBe(0);
    player.setSpeechActive(false);
    expect(speech.gain.ramps.at(-1)?.target).toBe(1);
  });

  it("applies speech state set before the audio graph exists", () => {
    const { ctx, player } = makePlayer();
    player.setSpeechActive(true);
    player.start();
    const speech = ctx.gains[0];
    expect(speech.gain.value).toBe(0);
  });
});

describe("HouseMusicPlayer track mode", () => {
  it("loops the track through the gain chain instead of the synth", () => {
    const audio = makeAudioElement();
    const { ctx, player } = makePlayer({ trackUrl: "blob:rolex", audio });
    player.start();
    expect(player.usesTrack()).toBe(true);
    expect(audio.loop).toBe(true);
    expect(audio.play).toHaveBeenCalled();
    expect(ctx.mediaSources).toHaveLength(1);
    const master = ctx.gains[1];
    expect(master.gain.ramps.at(-1)?.target).toBeCloseTo(0.3);
    vi.advanceTimersByTime(200);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("pauses the track after the fade-out completes", async () => {
    const audio = makeAudioElement();
    const { player } = makePlayer({ trackUrl: "blob:rolex", audio });
    player.start();
    await vi.advanceTimersByTimeAsync(50);
    player.stop();
    expect(audio.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("resumes the same element on restart instead of stacking sources", async () => {
    const audio = makeAudioElement();
    const { ctx, player } = makePlayer({ trackUrl: "blob:rolex", audio });
    player.start();
    await vi.advanceTimersByTimeAsync(50);
    player.stop();
    player.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(ctx.mediaSources).toHaveLength(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});

describe("HouseMusicPlayer lifecycle", () => {
  it("closes the audio context on dispose", () => {
    const { ctx, player } = makePlayer();
    player.start();
    player.dispose();
    expect(ctx.close).toHaveBeenCalled();
    expect(player.isPlaying()).toBe(false);
  });
});
