// Renderer-safe: never import node: modules here.

export const IPC = {
  agentToolCall: "agent:tool-call",
  agentEvents: "agent:events",
  appendTranscript: "conversation:append-transcript",
  getTranscript: "conversation:get-transcript",
  voiceToken: "voice:token",
  voiceInject: "voice:inject",
  setMicrophoneEnabled: "voice:set-microphone-enabled",
  runtimeGetState: "runtime:get-state",
  runtimeState: "runtime:state",
  listActiveJobs: "jobs:list-active",
  submitBoardSnapshot: "board:submit-snapshot",
  canvasRequest: "canvas:request",
  canvasResponse: "canvas:response",
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

export interface RuntimeState {
  microphoneEnabled: boolean;
  agentRunning: boolean;
  activeJobs: JobSummary[];
  boardRevision: number;
  voiceModel: "gpt-realtime-2.1";
  agentModel: "gpt-5.6-luna";
  reasoningEffort: "medium";
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
    | "preview-diagram"
    | "clear-diagram-preview"
    | "add-elements"
    | "connect-elements"
    | "clear-scene"
    | "apply-patch";
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
  operation: "add-shape" | "layout-diagram" | "add-elements" | "connect-elements" | "clear-scene" | "apply-patch";
  params: unknown;
}

export interface BoardLease {
  id: string;
  agentId: string;
  elementIds: string[];
  expiresAt: number;
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
  getRuntimeConfig(): Promise<{ voiceDisabled: boolean }>;
  onVoiceMessage(callback: (message: VoiceInjection) => void): () => void;
  onCanvasRequest(callback: (request: CanvasRequest) => void): () => void;
  respondCanvasRequest(response: CanvasResponse): void;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onRuntimeState(callback: (state: RuntimeState) => void): () => void;
}
