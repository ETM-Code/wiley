import type {
  AgentEvent,
  CloudAccount,
  BoardSnapshot,
  CanvasRequest,
  CanvasResponse,
  ProjectEntry,
  ProjectView,
  RuntimeConfig,
  SecretName,
  SettingsPatch,
  SettingsView,
  TerminalHandoff,
  TranscriptDraft,
  VoiceInjection,
  WileySettings,
  WorkerKind,
  WorkerProbes,
} from "../shared/contracts";

export type {
  AgentEvent,
  CloudAccount,
  BoardSnapshot,
  CanvasRequest,
  CanvasResponse,
  ProjectEntry,
  ProjectView,
  RuntimeConfig,
  SecretName,
  SettingsPatch,
  SettingsView,
  TerminalHandoff,
  TranscriptDraft,
  VoiceInjection,
  WileySettings,
  WorkerKind,
  WorkerProbes,
};

export type AgentStatus = {
  agentRunning: boolean;
  boardRevision?: number;
  summary?: string;
  subagents?: Array<{
    id: string;
    kind?: string;
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
  appendTranscript?: (entry: TranscriptDraft) => Promise<void> | void;
  onVoiceMessage?: (listener: (message: VoiceInjection) => void) => Unsubscribe | void;
  onCanvasRequest?: (listener: (request: CanvasRequest) => void) => Unsubscribe | void;
  respondCanvasRequest?: (response: CanvasResponse) => Promise<void> | void;
  getAgentStatus?: () => Promise<AgentStatus>;
  getBoardSnapshot?: () => Promise<BoardSnapshot | undefined>;
  activateCanvas?: () => Promise<unknown>;
  setMicrophoneEnabled?: (enabled: boolean) => Promise<unknown>;
  onAgentStatus?: (listener: (status: AgentStatus) => void) => Unsubscribe | void;
  onAgentEvent?: (listener: (event: AgentEvent) => void) => Unsubscribe | void;
  onRuntimeState?: (listener: (status: RuntimeStateLike) => void) => Unsubscribe | void;
  submitBoardSnapshot?: (snapshot: BoardSnapshot) => Promise<unknown>;
  getRuntimeConfig?: () => Promise<Partial<RuntimeConfig>>;
  getProjects?: () => Promise<ProjectView>;
  openProject?: (path?: string) => Promise<ProjectView>;
  onProjectChanged?: (listener: (view: ProjectView) => void) => Unsubscribe | void;
  getSettings?: () => Promise<SettingsView>;
  updateSettings?: (patch: SettingsPatch) => Promise<SettingsView>;
  setSecret?: (name: SecretName, value: string) => Promise<SettingsView>;
  clearSecret?: (name: SecretName) => Promise<SettingsView>;
  probeWorkers?: () => Promise<WorkerProbes>;
  chooseDirectory?: (current?: string) => Promise<string | undefined>;
  testCloudConnection?: () => Promise<CloudAccount>;
  openWorkerTerminal?: (workerId: string) => Promise<TerminalHandoff>;
  newTerminalSession?: (kind: WorkerKind) => Promise<TerminalHandoff>;
  onSettingsChanged?: (listener: (settings: SettingsView) => void) => Unsubscribe | void;
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
    onAgentEvent: (listener) => subscribe("agent:events", listener),
    submitBoardSnapshot: (snapshot) => fetchJson("/api/board-snapshot", { method: "POST", body: JSON.stringify(snapshot) }),
    getRuntimeConfig: () => fetchJson<RuntimeConfig>("/api/runtime-config"),
    // No openProject: the browser shell serves the project it was started in,
    // and the view it returns says so, so the picker never appears in a tab.
    getProjects: () => fetchJson<ProjectView>("/api/projects"),
    onProjectChanged: (listener) => subscribe("projects:changed", listener),
    getSettings: () => fetchJson<SettingsView>("/api/settings"),
    updateSettings: (patch) => fetchJson<SettingsView>("/api/settings", { method: "POST", body: JSON.stringify(patch) }),
    setSecret: (name, value) =>
      fetchJson<SettingsView>("/api/settings/secret", { method: "POST", body: JSON.stringify({ name, value }) }),
    clearSecret: (name) =>
      fetchJson<SettingsView>("/api/settings/secret", { method: "POST", body: JSON.stringify({ name, clear: true }) }),
    probeWorkers: () => fetchJson<WorkerProbes>("/api/settings/probe", { method: "POST", body: "{}" }),
    testCloudConnection: () => fetchJson<CloudAccount>("/api/cloud/test", { method: "POST", body: "{}" }),
    openWorkerTerminal: (workerId) =>
      fetchJson<TerminalHandoff>("/api/workers/open-terminal", { method: "POST", body: JSON.stringify({ workerId }) }),
    newTerminalSession: (kind) =>
      fetchJson<TerminalHandoff>("/api/workers/new-terminal-session", { method: "POST", body: JSON.stringify({ kind }) }),
    onSettingsChanged: (listener) => subscribe("settings:changed", listener),
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

  appendTranscript(entry: TranscriptDraft): void {
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

  onAgentEvent(listener: (event: AgentEvent) => void): Unsubscribe {
    return optionalSubscription(preload()?.onAgentEvent?.(listener));
  },

  async submitBoardSnapshot(snapshot: BoardSnapshot): Promise<BoardSnapshot | undefined> {
    return await preload()?.submitBoardSnapshot?.(snapshot) as BoardSnapshot | undefined;
  },

  async getSettings(): Promise<SettingsView | undefined> {
    return preload()?.getSettings?.();
  },

  async updateSettings(patch: SettingsPatch): Promise<SettingsView | undefined> {
    const update = preload()?.updateSettings;
    if (!update) throw new Error("Settings are unavailable: the host did not expose updateSettings");
    return update(patch);
  },

  async setSecret(name: SecretName, value: string): Promise<SettingsView | undefined> {
    const set = preload()?.setSecret;
    if (!set) throw new Error("Settings are unavailable: the host did not expose setSecret");
    return set(name, value);
  },

  async clearSecret(name: SecretName): Promise<SettingsView | undefined> {
    const clear = preload()?.clearSecret;
    if (!clear) throw new Error("Settings are unavailable: the host did not expose clearSecret");
    return clear(name);
  },

  async probeWorkers(): Promise<WorkerProbes | undefined> {
    return preload()?.probeWorkers?.();
  },

  /** Only a host with a desktop can put a folder picker on screen. */
  canChooseDirectory(): boolean {
    return typeof preload()?.chooseDirectory === "function";
  },

  async chooseDirectory(current?: string): Promise<string | undefined> {
    return preload()?.chooseDirectory?.(current);
  },

  /**
   * The host reaches the relay, never the tab: the renderer's connect-src is
   * pinned to OpenAI and stays that way.
   */
  async testCloudConnection(): Promise<CloudAccount> {
    const test = preload()?.testCloudConnection;
    if (!test) throw new Error("This host cannot reach a Wiley Cloud relay");
    return test();
  },

  async openWorkerTerminal(workerId: string): Promise<TerminalHandoff> {
    const open = preload()?.openWorkerTerminal;
    if (!open) throw new Error("This host cannot open a terminal");
    return open(workerId);
  },

  async newTerminalSession(kind: WorkerKind): Promise<TerminalHandoff> {
    const open = preload()?.newTerminalSession;
    if (!open) throw new Error("This host cannot open a terminal");
    return open(kind);
  },

  onSettingsChanged(listener: (settings: SettingsView) => void): Unsubscribe {
    return optionalSubscription(preload()?.onSettingsChanged?.(listener));
  },

  /**
   * The open project and the ones opened before it. A host with no project
   * flow at all reports none open and no way to open one, which reads the
   * same as a host that simply cannot switch.
   */
  async getProjects(): Promise<ProjectView> {
    return (await preload()?.getProjects?.()) ?? { recent: [], canOpen: false };
  },

  async openProject(path?: string): Promise<ProjectView> {
    const open = preload()?.openProject;
    if (!open) throw new Error("This host works in one project and cannot open another");
    return open(path);
  },

  onProjectChanged(listener: (view: ProjectView) => void): Unsubscribe {
    return optionalSubscription(preload()?.onProjectChanged?.(listener));
  },

  async isVoiceDisabled(): Promise<boolean> {
    const config = await preload()?.getRuntimeConfig?.();
    return config?.voiceDisabled ?? import.meta.env.VITE_VOICE_DISABLED === "1";
  },
};
