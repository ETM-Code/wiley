// Renderer-safe: never import node: modules here.

import type { CloudAccount } from "../main/cloud/cloud-client";
import type { ModelOption } from "../main/settings/model-catalog";
import type { OpenAiKeySource, SecretBackend, SecretName } from "../main/settings/secret-store";
import type { SettingsPatch, WileySettings, WorkerKind } from "../main/settings/settings-schema";

export type {
  CloudAccount,
  ModelOption,
  OpenAiKeySource,
  SecretBackend,
  SecretName,
  SettingsPatch,
  WileySettings,
  WorkerKind,
};

export const IPC = {
  agentToolCall: "agent:tool-call",
  agentEvents: "agent:events",
  appendTranscript: "conversation:append-transcript",
  voiceToken: "voice:token",
  voiceInject: "voice:inject",
  setMicrophoneEnabled: "voice:set-microphone-enabled",
  runtimeGetState: "runtime:get-state",
  runtimeConfig: "runtime:config",
  runtimeState: "runtime:state",
  submitBoardSnapshot: "board:submit-snapshot",
  getBoardSnapshot: "board:get-snapshot",
  activateCanvas: "board:activate",
  canvasRequest: "canvas:request",
  canvasResponse: "canvas:response",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsChanged: "settings:changed",
  settingsSecretSet: "settings:secret-set",
  settingsSecretClear: "settings:secret-clear",
  settingsProbe: "settings:probe",
  cloudTestConnection: "cloud:test-connection",
  workersOpenTerminal: "workers:open-terminal",
  workersNewTerminalSession: "workers:new-terminal-session",
} as const;

export type TranscriptRole = "user" | "assistant" | "system";

export interface TranscriptEntry {
  id: string;
  sequence: number;
  at: string;
  role: TranscriptRole;
  text: string;
}

/** What a client submits; the ledger assigns id, sequence, and at. */
export type TranscriptDraft = Pick<TranscriptEntry, "role" | "text">;

export type AgentEventType =
  | "assistant_message"
  | "tool_started"
  | "tool_progress"
  | "tool_completed"
  | "command_output"
  | "file_diff"
  | "board_transaction"
  | "milestone"
  | "usage"
  | "interrupted"
  | "error"
  | "completed";

export interface AgentEvent {
  id: string;
  sequence: number;
  at: string;
  jobId: string;
  agentId: string;
  parentAgentId?: string;
  type: AgentEventType;
  payload: unknown;
}

/** Every kind of background worker, including the in-process Pi one. */
export type AgentKind = "pi" | WorkerKind;

/** One background worker as the status surfaces and the sidebar see it. */
export interface AgentSummary {
  id: string;
  kind: AgentKind;
  status: string;
  task: string;
  report?: string;
}

export type JobStatus =
  | "queued"
  | "running"
  | "interrupting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobSummary {
  id: string;
  task: string;
  userWords: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

/** Host-decided switches the renderer cannot read for itself. */
export interface RuntimeConfig {
  voiceDisabled: boolean;
}

export interface RuntimeState {
  microphoneEnabled: boolean;
  agentRunning: boolean;
  activeJobs: JobSummary[];
  /** Background workers of every kind, so the sidebar can label each one. */
  subagents: AgentSummary[];
  boardRevision: number;
  /** Live values from settings, not build-time constants. */
  voiceModel: string;
  agentModel: string;
  reasoningEffort: string;
  fastMode: boolean;
}

/** Whether a worker CLI can actually be launched on this machine. */
export interface WorkerProbe {
  available: boolean;
  reason?: string;
  version?: string;
  path?: string;
}

export type WorkerProbes = Record<WorkerKind, WorkerProbe>;

/**
 * Everything the settings UI needs, and nothing it must not have: secret
 * values never leave the host, only whether one exists and where it came from.
 */
export interface SettingsView extends WileySettings {
  secrets: {
    openaiApiKey: {
      /** A key is available from some source. */
      present: boolean;
      source: OpenAiKeySource;
      /** A key is saved in the secret store, whether or not the env shadows it. */
      stored: boolean;
      backend: SecretBackend;
    };
    /** The hosted-account session token, which has no environment equivalent. */
    cloudSessionToken: {
      stored: boolean;
      backend: SecretBackend;
    };
  };
  models: ModelOption[];
  probes: WorkerProbes;
  /** Terminal emulators found on this machine, for the handoff picker. */
  terminalApps: string[];
}

/** What happened when a session was handed over to the user's terminal. */
export interface TerminalHandoff {
  /** The emulator that actually opened, which a fallback may change. */
  app: string;
  command: string;
  /** Present when an existing worker was handed over rather than a new one. */
  workerId?: string;
  /** Why the requested emulator was not the one used. */
  fallbackReason?: string;
}

export interface BoardSnapshot {
  revision: number;
  elements: Array<Record<string, unknown>>;
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface CanvasRequest {
  id: number;
  op:
    | "get-scene-summary"
    | "get-scene-full"
    | "export-png"
    | "add-shape"
    | "layout-diagram"
    | "update-diagram"
    | "preview-diagram"
    | "clear-diagram-preview"
    | "add-elements"
    | "connect-elements"
    | "clear-scene"
    | "apply-patch"
    | "tidy-diagram";
  params?: unknown;
}

export interface CanvasResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export interface BoardTransaction {
  id: string;
  idempotencyKey: string;
  agentId: string;
  jobId: string;
  baseRevision: number;
  leaseIds?: string[];
  summary: string;
  operation:
    | "add-shape"
    | "layout-diagram"
    | "update-diagram"
    | "add-elements"
    | "connect-elements"
    | "clear-scene"
    | "apply-patch"
    | "tidy-diagram";
  params: unknown;
}

export type VoiceToolName =
  | "send_task_to_agent"
  | "answer_agent"
  | "get_agent_status"
  | "look_at_board"
  | "abort_agent"
  | "new_session";

export interface VoiceInjection {
  id: string;
  text: string;
  interrupt: boolean;
  /** Context-only: added to the conversation without triggering speech. */
  silent?: boolean;
}

/** The surface the Electron preload exposes on window.api. */
export interface BoardApi {
  getVoiceToken(): Promise<string | { value: string }>;
  agentToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  appendTranscript(entry: TranscriptDraft): Promise<TranscriptEntry>;
  getAgentStatus(): Promise<RuntimeState>;
  setMicrophoneEnabled(enabled: boolean): Promise<RuntimeState>;
  submitBoardSnapshot(snapshot: BoardSnapshot): Promise<BoardSnapshot>;
  getBoardSnapshot(): Promise<BoardSnapshot>;
  /**
   * Announces the window that owns the canonical board. Electron has exactly
   * one window, so the host acknowledges without bookkeeping; the browser host
   * uses the equivalent call to arbitrate between tabs.
   */
  activateCanvas(): Promise<{ ok: true }>;
  getRuntimeConfig(): Promise<RuntimeConfig>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: SettingsPatch): Promise<SettingsView>;
  setSecret(name: SecretName, value: string): Promise<SettingsView>;
  clearSecret(name: SecretName): Promise<SettingsView>;
  probeWorkers(): Promise<WorkerProbes>;
  testCloudConnection(): Promise<CloudAccount>;
  openWorkerTerminal(workerId: string): Promise<TerminalHandoff>;
  newTerminalSession(kind: WorkerKind): Promise<TerminalHandoff>;
  onSettingsChanged(callback: (settings: SettingsView) => void): () => void;
  onVoiceMessage(callback: (message: VoiceInjection) => void): () => void;
  onCanvasRequest(callback: (request: CanvasRequest) => void): () => void;
  respondCanvasRequest(response: CanvasResponse): void;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onRuntimeState(callback: (state: RuntimeState) => void): () => void;
}
