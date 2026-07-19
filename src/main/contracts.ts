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
  boardTransactions: "board:transaction",
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

export type AgentEventType =
  | "assistant_message"
  | "tool_started"
  | "tool_progress"
  | "tool_completed"
  | "command_output"
  | "file_diff"
  | "board_transaction"
  | "milestone"
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

export interface JsonlRecord {
  kind: "transcript" | "agent_event" | "job" | "board_transaction" | "board_snapshot";
  at: string;
  data: unknown;
}
