import { bridge, type VoiceInjection } from "./bridge";

export type VoiceState = {
  microphoneEnabled: boolean;
  microphoneStarting: boolean;
  userSpeechActive: boolean;
  assistantAudioActive: boolean;
  connected: boolean;
  dictationText: string;
  dictationStatus: "idle" | "listening" | "processing" | "heard";
};

type VoiceListener = (state: VoiceState) => void;
type QueuedInjection = VoiceInjection & { id: number };

const SESSION_INSTRUCTIONS = `You are Wiley, a terse voice-driven whiteboard coding assistant. You are one person to the user. Never mention agents, subagents, engines, layers, tool calls, or internal architecture. You do not edit the board or execute work yourself: every requested action goes through send_task_to_agent. Always include the user's verbatim request in user_words.

Speaking rules are strict:
- For an actionable request, call send_task_to_agent immediately with no spoken preamble.
- Only after the tool confirms acceptance, say exactly: "Okay, I'm fixing it as we speak. Anything else?"
- Never acknowledge the same request twice.
- For [agent finished], say only "Done."
- For [agent progress], use at most one sentence of eight words. Do not add context, repeat the task, list planned steps, or offer options.
- For any question about current, queued, or past work ("what's happening", "what have you done so far"), call get_agent_status and answer from currentWork, recentWork, and each report, most recent first, in at most two short sentences. Never say nothing is running when recentWork has entries; summarize what was finished instead.
- For questions the status report cannot answer, such as how something was built, what is in the code, or details of the board, call send_task_to_agent asking for the answer; it has full memory of the work and will reply through [agent finished].
- Never end with suggestions such as changing size, color, style, or adding another component unless the user asked for suggestions.
- Outside ordinary conversation, keep every spoken response under twelve words.

Never claim an action happened unless the corresponding message confirms it. For [agent question], ask the question as your own and return the spoken answer only through answer_agent. New instructions interrupt ongoing work by default; use queue only when the user explicitly adds something for later.`;

const TOOLS = [
  {
    type: "function",
    name: "send_task_to_agent",
    description:
      "Send all requested board, coding, research, and tool work to the orchestrator. Interrupts current work unless queue is explicitly true.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear summary of the requested work" },
        user_words: { type: "string", description: "The user's request verbatim" },
        queue: { type: "boolean", description: "Only true when the user asks to do this later" },
      },
      required: ["task", "user_words"],
    },
  },
  {
    type: "function",
    name: "answer_agent",
    description: "Deliver the user's answer to Wiley's pending question.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  },
  {
    type: "function",
    name: "get_agent_status",
    description:
      "Current, queued, and recently finished work, including each finished task's final report. Use for any question about what is being done or what has been done so far.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "look_at_board",
    description: "Read a cheap text summary of the whiteboard through the orchestrator.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "abort_agent",
    description: "Immediately stop current background work.",
    parameters: { type: "object", properties: {} },
  },
] as const;

function textFromResponse(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((content): content is Record<string, unknown> => Boolean(content && typeof content === "object"))
    .map((content) => content.transcript ?? content.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join(" ")
    .trim();
}

export class RealtimeVoiceController {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private connecting: Promise<void> | null = null;
  private responseActive = false;
  private needsRetry = false;
  private outbox: QueuedInjection[] = [];
  private nextOutboxId = 0;
  private listeners = new Set<VoiceListener>();
  private unsubscribeVoice: () => void;
  private state: VoiceState = {
    microphoneEnabled: false,
    microphoneStarting: false,
    userSpeechActive: false,
    assistantAudioActive: false,
    connected: false,
    dictationText: "",
    dictationStatus: "idle",
  };

  constructor(private readonly onError: (message: string) => void) {
    this.unsubscribeVoice = bridge.onVoiceMessage((message) => this.push(message));
  }

  subscribe(listener: VoiceListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): VoiceState {
    return this.state;
  }

  private update(patch: Partial<VoiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      const track = this.stream?.getAudioTracks()[0];
      if (track) track.enabled = false;
      await bridge.setMicrophoneEnabled(false);
      this.update({
        microphoneEnabled: false,
        microphoneStarting: false,
        dictationStatus: this.state.dictationText ? "heard" : "idle",
      });
      return;
    }

    // Token minting and WebRTC setup can take several seconds. Reflect the
    // user's click immediately instead of leaving the control looking inert.
    this.update({
      microphoneEnabled: true,
      microphoneStarting: true,
      dictationStatus: "processing",
    });
    try {
      if (!this.channel) await this.connect();
      const track = this.stream?.getAudioTracks()[0];
      if (track) track.enabled = true;
      await bridge.setMicrophoneEnabled(true);
      this.update({ microphoneStarting: false, dictationStatus: "listening" });
    } catch (error) {
      const track = this.stream?.getAudioTracks()[0];
      if (track) track.enabled = false;
      void bridge.setMicrophoneEnabled(false).catch(() => undefined);
      this.update({
        microphoneEnabled: false,
        microphoneStarting: false,
        dictationStatus: this.state.dictationText ? "heard" : "idle",
      });
      throw error;
    }
  }

  async toggleMicrophone(): Promise<void> {
    if (this.state.microphoneStarting) return;
    return this.setMicrophoneEnabled(!this.state.microphoneEnabled);
  }

  private async connect(): Promise<void> {
    if (this.channel?.readyState === "open") return;
    if (this.connecting) return this.connecting;
    this.connecting = this.createConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async createConnection(): Promise<void> {
    const [token, stream] = await Promise.all([
      bridge.getVoiceToken(),
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
    ]);

    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("aria-hidden", "true");
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0];
    };
    for (const track of stream.getTracks()) peer.addTrack(track, stream);

    channel.onmessage = (event) => this.handleServerEvent(event.data);
    channel.onclose = () => this.update({ connected: false, assistantAudioActive: false });
    channel.onerror = () => this.onError("The live voice connection encountered an error");

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!response.ok) throw new Error(`Voice connection failed (${response.status})`);
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });

    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === "open") return resolve();
      const timeout = window.setTimeout(() => reject(new Error("Voice connection timed out")), 15_000);
      channel.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });

    this.peer = peer;
    this.channel = channel;
    this.stream = stream;
    this.audio = audio;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: SESSION_INSTRUCTIONS,
        reasoning: { effort: "low" },
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: "marin" },
        },
        tools: TOOLS,
        tool_choice: "auto",
      },
    });
    this.update({ connected: true });
    this.flushOutbox();
  }

  push(message: VoiceInjection): void {
    const queued = { ...message, id: ++this.nextOutboxId };
    if (message.interrupt) {
      const firstRegular = this.outbox.findIndex((item) => !item.interrupt);
      if (firstRegular === -1) this.outbox.push(queued);
      else this.outbox.splice(firstRegular, 0, queued);
      if (this.responseActive) this.send({ type: "response.cancel" });
    } else {
      this.outbox.push(queued);
    }
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (!this.channel || this.channel.readyState !== "open" || this.responseActive) return;
    const message = this.outbox.shift();
    if (!message) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.text }],
      },
    });
    this.requestResponse();
  }

  private requestResponse(): void {
    if (this.responseActive) {
      this.needsRetry = true;
      return;
    }
    this.send({ type: "response.create" });
    this.responseActive = true;
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  private handleServerEvent(raw: unknown): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event.type;
    if (type === "response.created") {
      this.responseActive = true;
      this.update({ assistantAudioActive: true });
    } else if (type === "response.done") {
      this.responseActive = false;
      this.update({ assistantAudioActive: false });
      const response = event.response;
      if (response && typeof response === "object") {
        const text = textFromResponse(response as Record<string, unknown>);
        if (text) bridge.appendTranscript({ role: "assistant", text });
      }
      if (this.needsRetry) {
        this.needsRetry = false;
        this.requestResponse();
      } else {
        this.flushOutbox();
      }
    } else if (type === "input_audio_buffer.speech_started") {
      this.update({ userSpeechActive: true, dictationText: "", dictationStatus: "listening" });
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.update({ userSpeechActive: false, dictationStatus: "processing" });
    } else if (type === "conversation.item.input_audio_transcription.delta") {
      if (typeof event.delta === "string" && event.delta) {
        this.update({
          dictationText: `${this.state.dictationText}${event.delta}`.slice(-1_000),
          dictationStatus: "listening",
        });
      }
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      if (typeof event.transcript === "string" && event.transcript.trim()) {
        const transcript = event.transcript.trim();
        this.update({ userSpeechActive: false, dictationText: transcript, dictationStatus: "heard" });
        bridge.appendTranscript({ role: "user", text: transcript });
      } else {
        this.update({ userSpeechActive: false, dictationStatus: "listening" });
      }
    } else if (type === "response.function_call_arguments.done") {
      void this.handleToolCall(event);
    } else if (type === "error") {
      const error = event.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === "string" ? error.message : "Realtime voice error";
      if (/active response/i.test(message)) {
        this.responseActive = true;
        this.needsRetry = true;
      } else {
        this.onError(message);
      }
    }
  }

  private async handleToolCall(event: Record<string, unknown>): Promise<void> {
    const name = typeof event.name === "string" ? event.name : "";
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (!name || !callId) return;

    let args: Record<string, unknown> = {};
    try {
      args = event.arguments ? (JSON.parse(String(event.arguments)) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }

    let result: unknown;
    try {
      result = await bridge.agentToolCall(name, args);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result ?? null),
      },
    });
    this.requestResponse();
  }

  destroy(): void {
    this.unsubscribeVoice();
    this.channel?.close();
    this.peer?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audio) this.audio.srcObject = null;
    this.listeners.clear();
  }
}
