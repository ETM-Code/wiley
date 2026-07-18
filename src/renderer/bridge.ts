export type TranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

export type CanvasRequest = {
  id: number;
  op:
    | "get-scene-summary"
    | "get-scene-full"
    | "export-png"
    | "add-shape"
    | "layout-diagram"
    | "preview-diagram"
    | "clear-diagram-preview"
    | "add-elements"
    | "clear-scene"
    | "apply-patch";
  params?: unknown;
};

export type CanvasResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

export type VoiceInjection = {
  text: string;
  interrupt?: boolean;
};

export type AgentStatus = {
  agentRunning: boolean;
  boardRevision?: number;
  summary?: string;
  subagents?: Array<{
    id: string;
    status: string;
    task?: string;
  }>;
};

type RuntimeStateLike = Partial<AgentStatus> & {
  rootAgentReady?: boolean;
  activeJobs?: Array<{
    id: string;
    task: string;
    state?: string;
    status?: string;
    milestone?: string;
  }>;
};

export type BoardSnapshot = {
  revision: number;
  elements: Array<Record<string, unknown>>;
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
};

type Unsubscribe = () => void;

type BrowserEvent = { sequence?: number; channel?: string; payload?: unknown };
type BrowserEventPage = { events?: BrowserEvent[]; cursor?: number };

/**
 * This is the sole renderer dependency on preload. Every method is optional so
 * Excalidraw can still boot while the main-process harness is unavailable.
 */
type PreloadApi = {
  getVoiceToken?: () => Promise<string | { value: string }>;
  agentToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  appendTranscript?: (entry: TranscriptEntry) => Promise<void> | void;
  onVoiceMessage?: (listener: (message: VoiceInjection) => void) => Unsubscribe | void;
  onCanvasRequest?: (listener: (request: CanvasRequest) => void) => Unsubscribe | void;
  respondCanvasRequest?: (response: CanvasResponse) => Promise<void> | void;
  getAgentStatus?: () => Promise<AgentStatus>;
  getBoardSnapshot?: () => Promise<BoardSnapshot | undefined>;
  activateCanvas?: () => Promise<unknown>;
  setMicrophoneEnabled?: (enabled: boolean) => Promise<unknown>;
  onAgentStatus?: (listener: (status: AgentStatus) => void) => Unsubscribe | void;
  onRuntimeState?: (listener: (status: RuntimeStateLike) => void) => Unsubscribe | void;
  submitBoardSnapshot?: (snapshot: BoardSnapshot) => Promise<unknown>;
  getRuntimeConfig?: () => Promise<{ voiceDisabled?: boolean }>;
};

type BrowserWindow = Window & {
  __wileyBrowserApi?: PreloadApi;
  __wileyBrowserClientId?: string;
};

const browserWindow = window as BrowserWindow;
const browserClientId = browserWindow.__wileyBrowserClientId ?? crypto.randomUUID();
browserWindow.__wileyBrowserClientId = browserClientId;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Wiley-Client-Id": browserClientId,
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `Local agent request failed (${response.status})`);
  return body;
}

function createBrowserApi(): PreloadApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let cursor: number | "latest" = "latest";
  const poll = async () => {
    while (true) {
      try {
        const page = await fetchJson<BrowserEventPage>(`/api/events/poll?after=${cursor}`);
        for (const message of page.events ?? []) {
          if (!message.channel) continue;
          for (const listener of listeners.get(message.channel) ?? []) listener(message.payload);
        }
        if (typeof page.cursor === "number") cursor = page.cursor;
      } catch {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
  };
  void poll();
  const subscribe = <T>(channel: string, listener: (payload: T) => void): Unsubscribe => {
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(listener as (payload: unknown) => void);
    listeners.set(channel, channelListeners);
    return () => channelListeners.delete(listener as (payload: unknown) => void);
  };
  return {
    getVoiceToken: () => fetchJson<{ value: string }>("/api/voice-token", { method: "POST", body: "{}" }),
    agentToolCall: (name, args) => fetchJson("/api/tool", { method: "POST", body: JSON.stringify({ name, args }) }),
    appendTranscript: (entry) => fetchJson("/api/transcript", { method: "POST", body: JSON.stringify(entry) }),
    onVoiceMessage: (listener) => subscribe("voice:inject", listener),
    onCanvasRequest: (listener) => subscribe("canvas:request", listener),
    respondCanvasRequest: (response) => fetchJson("/api/canvas-response", { method: "POST", body: JSON.stringify(response) }),
    getAgentStatus: () => fetchJson<AgentStatus>("/api/status"),
    getBoardSnapshot: () => fetchJson<BoardSnapshot>("/api/board-state"),
    activateCanvas: () => fetchJson("/api/client-active", { method: "POST", body: "{}" }),
    setMicrophoneEnabled: (enabled) => fetchJson("/api/microphone", { method: "POST", body: JSON.stringify({ enabled }) }),
    onRuntimeState: (listener) => subscribe("runtime:state", listener),
    submitBoardSnapshot: (snapshot) => fetchJson("/api/board-snapshot", { method: "POST", body: JSON.stringify(snapshot) }),
    getRuntimeConfig: async () => ({ voiceDisabled: false }),
  };
}

function preload(): PreloadApi | undefined {
  const electronApi = (window as unknown as { api?: PreloadApi }).api;
  if (electronApi) return electronApi;
  browserWindow.__wileyBrowserApi ??= createBrowserApi();
  return browserWindow.__wileyBrowserApi;
}

function optionalSubscription(value: Unsubscribe | void): Unsubscribe {
  return typeof value === "function" ? value : () => undefined;
}

function normalizeStatus(value: RuntimeStateLike | undefined): AgentStatus {
  const jobs = value?.activeJobs ?? [];
  const subagents = value?.subagents ?? jobs.map((job) => ({
    id: job.id,
    task: job.task,
    status: job.status ?? job.state ?? "running",
  }));
  const running = jobs.some((job) => !["completed", "failed", "cancelled"].includes(job.status ?? job.state ?? "running"));
  return {
    agentRunning: value?.agentRunning ?? running,
    boardRevision: value?.boardRevision,
    summary: value?.summary ?? jobs.find((job) => job.milestone)?.milestone,
    subagents,
  };
}

function ignoreRejected(value: Promise<unknown> | void): void {
  if (value && typeof value.catch === "function") void value.catch(() => undefined);
}

export const bridge = {
  available(): boolean {
    return Boolean(preload());
  },

  async getVoiceToken(): Promise<string> {
    const getter = preload()?.getVoiceToken;
    if (!getter) throw new Error("Voice is unavailable: preload did not expose getVoiceToken");
    const token = await getter();
    const value = typeof token === "string" ? token : token.value;
    if (!value) throw new Error("The voice-token response was empty");
    return value;
  },

  async agentToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const call = preload()?.agentToolCall;
    if (!call) throw new Error("Agent tools are unavailable");
    return call(name, args);
  },

  appendTranscript(entry: TranscriptEntry): void {
    ignoreRejected(preload()?.appendTranscript?.(entry));
  },

  onVoiceMessage(listener: (message: VoiceInjection) => void): Unsubscribe {
    return optionalSubscription(preload()?.onVoiceMessage?.(listener));
  },

  onCanvasRequest(listener: (request: CanvasRequest) => void): Unsubscribe {
    return optionalSubscription(preload()?.onCanvasRequest?.(listener));
  },

  respondCanvasRequest(response: CanvasResponse): void {
    ignoreRejected(preload()?.respondCanvasRequest?.(response));
  },

  async getAgentStatus(): Promise<AgentStatus> {
    return normalizeStatus(await preload()?.getAgentStatus?.());
  },

  async getBoardSnapshot(): Promise<BoardSnapshot | undefined> {
    return preload()?.getBoardSnapshot?.();
  },

  async activateCanvas(): Promise<void> {
    await preload()?.activateCanvas?.();
  },

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await preload()?.setMicrophoneEnabled?.(enabled);
  },

  onAgentStatus(listener: (status: AgentStatus) => void): Unsubscribe {
    const api = preload();
    if (api?.onAgentStatus) return optionalSubscription(api.onAgentStatus(listener));
    return optionalSubscription(api?.onRuntimeState?.((status) => listener(normalizeStatus(status))));
  },

  async submitBoardSnapshot(snapshot: BoardSnapshot): Promise<BoardSnapshot | undefined> {
    return await preload()?.submitBoardSnapshot?.(snapshot) as BoardSnapshot | undefined;
  },

  async isVoiceDisabled(): Promise<boolean> {
    const config = await preload()?.getRuntimeConfig?.();
    return config?.voiceDisabled ?? import.meta.env.VITE_VOICE_DISABLED === "1";
  },
};
