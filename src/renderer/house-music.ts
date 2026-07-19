// Background music that plays while Wiley is working. If the user has dropped
// their own copy of "Wearing My Rolex" into src/renderer/assets, that track
// loops through the WebAudio gain chain; otherwise a synthesized house groove
// fills in, so the feature works with no bundled audio asset at all.
//
// Whenever anyone is speaking — the user or Wiley — the music fades out
// completely and fades back in once the voices stop.

const TRACK_MODULES = import.meta.glob("./assets/wearing-my-rolex.{mp3,m4a,ogg,wav}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const BUNDLED_TRACK_URL: string | null = Object.values(TRACK_MODULES)[0] ?? null;

const BPM = 124;
const STEP_SECONDS = 60 / BPM / 4;
const STEPS_PER_LOOP = 32;
const LOOKAHEAD_SECONDS = 0.12;
const TICK_MS = 30;
const SYNTH_LEVEL = 0.16;
const TRACK_LEVEL = 0.3;
const FADE_IN_SECONDS = 0.8;
const FADE_OUT_SECONDS = 0.6;
const SPEECH_FADE_OUT_SECONDS = 0.6;
const SPEECH_FADE_IN_SECONDS = 3;
const SILENCE_HOLD_SECONDS = 2.5;

// A minor. Bass sits on the off-eighths so the kick keeps the floor to itself.
const A1 = 55;
const C2 = 65.41;
const E2 = 82.41;
const G2 = 98;
const BASS_PATTERN: Record<number, number> = {
  2: A1, 6: A1, 10: C2, 14: A1,
  18: A1, 22: A1, 26: E2, 30: G2,
};
const STAB_CHORD = [110, 130.81, 164.81, 196]; // Am7
const STAB_STEPS = new Set([6, 22, 30]);

export type HouseMusicOptions = {
  createContext?: () => AudioContext;
  createAudio?: (url: string) => HTMLAudioElement;
  trackUrl?: string | null;
};

export class HouseMusicPlayer {
  #createContext: () => AudioContext;
  #createAudio: (url: string) => HTMLAudioElement;
  #trackUrl: string | null;
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #speech: GainNode | null = null;
  #noiseBuffer: AudioBuffer | null = null;
  #audio: HTMLAudioElement | null = null;
  #timer: number | null = null;
  #pauseTimer: number | null = null;
  #silenceTimer: number | null = null;
  #step = 0;
  #nextNoteTime = 0;
  #shouldPlay = false;
  #speechActive = false;
  #resumeListener: (() => void) | null = null;

  constructor(options: HouseMusicOptions = {}) {
    this.#createContext = options.createContext ?? (() => new AudioContext());
    this.#createAudio = options.createAudio ?? ((url) => new Audio(url));
    this.#trackUrl = options.trackUrl !== undefined ? options.trackUrl : BUNDLED_TRACK_URL;
  }

  isPlaying(): boolean {
    return this.#shouldPlay;
  }

  usesTrack(): boolean {
    return this.#trackUrl !== null;
  }

  start(): void {
    if (this.#shouldPlay) return;
    this.#shouldPlay = true;
    const ctx = this.#ensureContext();
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
    this.#armGestureResume(ctx);
    if (this.#pauseTimer !== null) {
      window.clearTimeout(this.#pauseTimer);
      this.#pauseTimer = null;
    }
    this.#rampMaster(this.#targetLevel(), FADE_IN_SECONDS);
    if (this.#trackUrl) {
      this.#startTrack();
    } else {
      this.#startSynth();
    }
  }

  stop(): void {
    if (!this.#shouldPlay) return;
    this.#shouldPlay = false;
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#rampMaster(0, FADE_OUT_SECONDS);
    if (this.#audio && !this.#audio.paused) {
      this.#pauseTimer = window.setTimeout(() => {
        this.#audio?.pause();
        this.#pauseTimer = null;
      }, FADE_OUT_SECONDS * 1000 + 60);
    }
  }

  // Fades the music out entirely while anyone — user or Wiley — is speaking.
  // Once the conversation goes quiet it holds off for a stretch of silence,
  // then eases back in slowly; if speech resumes during the hold-off or the
  // ramp, it ducks straight back out. The track keeps rolling underneath at
  // zero gain, so it resumes mid-song instead of restarting.
  setSpeechActive(active: boolean): void {
    if (this.#speechActive === active) return;
    this.#speechActive = active;
    this.#clearSilenceTimer();
    if (active) {
      this.#rampSpeech(0, SPEECH_FADE_OUT_SECONDS);
      return;
    }
    this.#silenceTimer = window.setTimeout(() => {
      this.#silenceTimer = null;
      this.#rampSpeech(1, SPEECH_FADE_IN_SECONDS);
    }, SILENCE_HOLD_SECONDS * 1000);
  }

  #rampSpeech(target: number, seconds: number): void {
    const ctx = this.#ctx;
    const speech = this.#speech;
    if (!ctx || !speech) return;
    speech.gain.cancelScheduledValues(ctx.currentTime);
    speech.gain.setValueAtTime(speech.gain.value, ctx.currentTime);
    speech.gain.linearRampToValueAtTime(target, ctx.currentTime + seconds);
  }

  #clearSilenceTimer(): void {
    if (this.#silenceTimer === null) return;
    window.clearTimeout(this.#silenceTimer);
    this.#silenceTimer = null;
  }

  dispose(): void {
    this.stop();
    this.#disarmGestureResume();
    this.#clearSilenceTimer();
    if (this.#pauseTimer !== null) {
      window.clearTimeout(this.#pauseTimer);
      this.#pauseTimer = null;
    }
    if (this.#audio) {
      this.#audio.pause();
      this.#audio.removeAttribute("src");
      this.#audio = null;
    }
    if (this.#ctx) {
      void this.#ctx.close().catch(() => undefined);
      this.#ctx = null;
      this.#master = null;
      this.#speech = null;
      this.#noiseBuffer = null;
    }
  }

  #targetLevel(): number {
    return this.#trackUrl ? TRACK_LEVEL : SYNTH_LEVEL;
  }

  #rampMaster(target: number, seconds: number): void {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(target, ctx.currentTime + seconds);
  }

  #ensureContext(): AudioContext {
    if (this.#ctx) return this.#ctx;
    const ctx = this.#createContext();
    const speech = ctx.createGain();
    speech.gain.value = this.#speechActive || this.#silenceTimer !== null ? 0 : 1;
    speech.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(speech);
    this.#ctx = ctx;
    this.#master = master;
    this.#speech = speech;
    return ctx;
  }

  #startTrack(): void {
    const ctx = this.#ctx!;
    if (!this.#audio) {
      const audio = this.#createAudio(this.#trackUrl!);
      audio.loop = true;
      const source = ctx.createMediaElementSource(audio);
      source.connect(this.#master!);
      this.#audio = audio;
    }
    void this.#audio.play().catch(() => {
      // Autoplay policy in the browser variant: the gesture listener armed in
      // start() retries once the user interacts.
    });
  }

  #startSynth(): void {
    if (this.#timer !== null) return;
    const ctx = this.#ctx!;
    if (!this.#noiseBuffer) {
      const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        // Deterministic pseudo-noise; percussion does not need real entropy.
        data[i] = Math.sin(i * 12.9898) * 43758.5453 % 2 - 1;
      }
      this.#noiseBuffer = noise;
    }
    this.#step = 0;
    this.#nextNoteTime = ctx.currentTime + 0.05;
    this.#timer = window.setInterval(() => this.#tick(), TICK_MS);
  }

  // Web pages start audio suspended until the user interacts; the Electron
  // shell does not, but the browser variant shares this renderer.
  #armGestureResume(ctx: AudioContext): void {
    if (this.#resumeListener) return;
    const listener = () => {
      void ctx.resume().catch(() => undefined);
      if (this.#shouldPlay && this.#audio?.paused) {
        void this.#audio.play().catch(() => undefined);
      }
      this.#disarmGestureResume();
    };
    this.#resumeListener = listener;
    window.addEventListener("pointerdown", listener);
    window.addEventListener("keydown", listener);
  }

  #disarmGestureResume(): void {
    if (!this.#resumeListener) return;
    window.removeEventListener("pointerdown", this.#resumeListener);
    window.removeEventListener("keydown", this.#resumeListener);
    this.#resumeListener = null;
  }

  #tick(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    while (this.#nextNoteTime < ctx.currentTime + LOOKAHEAD_SECONDS) {
      this.#scheduleStep(this.#step % STEPS_PER_LOOP, this.#nextNoteTime);
      this.#step += 1;
      this.#nextNoteTime += STEP_SECONDS;
    }
  }

  #scheduleStep(step: number, time: number): void {
    if (step % 4 === 0) this.#kick(time);
    if (step % 16 === 4 || step % 16 === 12) this.#clap(time);
    if (step % 4 === 2) this.#hat(time, true);
    else if (step % 2 === 1) this.#hat(time, false);
    const bassNote = BASS_PATTERN[step];
    if (bassNote) this.#bass(time, bassNote);
    if (STAB_STEPS.has(step)) this.#stab(time);
  }

  #kick(time: number): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.11);
    gain.gain.setValueAtTime(1, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
    osc.connect(gain);
    gain.connect(this.#master!);
    osc.start(time);
    osc.stop(time + 0.26);
  }

  #clap(time: number): void {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.#master!);
    source.start(time);
    source.stop(time + 0.18);
  }

  #hat(time: number, open: boolean): void {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 7500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(open ? 0.3 : 0.12, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + (open ? 0.26 : 0.05));
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.#master!);
    source.start(time);
    source.stop(time + (open ? 0.28 : 0.07));
  }

  #bass(time: number, frequency: number): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = frequency;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 480;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.5, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.#master!);
    osc.start(time);
    osc.stop(time + 0.22);
  }

  #stab(time: number): void {
    const ctx = this.#ctx!;
    for (const frequency of STAB_CHORD) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = frequency;
      osc.detune.value = 6;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.09, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.#master!);
      osc.start(time);
      osc.stop(time + 0.18);
    }
  }
}
