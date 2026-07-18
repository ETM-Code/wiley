export const IPC = {
  voiceToken: "voice:token",
  voiceToolCall: "agent:tool-call",
  voiceAppendTranscript: "conversation:append-transcript",
  voiceMessage: "voice:inject",
  setMicrophoneEnabled: "voice:set-microphone-enabled",
  canvasRequest: "canvas:request",
  canvasResponse: "canvas:response",
  submitBoardSnapshot: "board:submit-snapshot",
  agentStatus: "runtime:get-state",
  agentEvents: "agent:events",
  runtimeState: "runtime:state"
} as const;

export type TranscriptRole = "user" | "assistant" | "system_event";

export interface TranscriptEntry {
  id?: string;
  sequence?: number;
  at?: string;
  role: TranscriptRole;
  text: string;
  relatedJobIds?: string[];
}

export type JobState =
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
  status: JobState;
  createdAt: string;
  updatedAt: string;
  milestone?: string;
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

export type CanvasOperation =
  | "get-scene-summary"
  | "get-scene-full"
  | "export-png"
  | "add-shape"
  | "layout-diagram"
  | "add-elements"
  | "apply-patch";

export interface CanvasRequest {
  id: number;
  op: CanvasOperation;
  params?: unknown;
}

export interface CanvasResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export interface VoiceMessage {
  id?: string;
  text: string;
  interrupt?: boolean;
  jobId?: string;
  kind?: "progress" | "question" | "result" | "error";
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

export interface BoardApi {
  getVoiceToken(): Promise<string | { value: string }>;
  agentToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  appendTranscript(entry: TranscriptEntry): Promise<void>;
  getAgentStatus(): Promise<RuntimeState>;
  setMicrophoneEnabled(enabled: boolean): Promise<RuntimeState>;
  submitBoardSnapshot(snapshot: BoardSnapshot): Promise<unknown>;
  getRuntimeConfig(): Promise<{ voiceDisabled: boolean }>;
  onVoiceMessage(callback: (message: VoiceMessage) => void): () => void;
  onCanvasRequest(callback: (request: CanvasRequest) => void): () => void;
  respondCanvasRequest(response: CanvasResponse): void;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onRuntimeState(callback: (state: RuntimeState) => void): () => void;
}
