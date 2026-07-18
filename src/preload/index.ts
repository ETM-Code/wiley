import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AgentEvent,
  type BoardApi,
  type BoardSnapshot,
  type CanvasRequest,
  type CanvasResponse,
  type RuntimeState,
  type TranscriptEntry,
  type VoiceMessage
} from "../shared/contracts";

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BoardApi = {
  getVoiceToken: () => ipcRenderer.invoke(IPC.voiceToken),
  agentToolCall: (name, args) => ipcRenderer.invoke(IPC.voiceToolCall, name, args),
  appendTranscript: (entry: TranscriptEntry) => ipcRenderer.invoke(IPC.voiceAppendTranscript, entry),
  getAgentStatus: () => ipcRenderer.invoke(IPC.agentStatus),
  setMicrophoneEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.setMicrophoneEnabled, enabled),
  submitBoardSnapshot: (snapshot: BoardSnapshot) => ipcRenderer.invoke(IPC.submitBoardSnapshot, snapshot),
  getRuntimeConfig: async () => ({ voiceDisabled: process.env.VOICE_DISABLED === "1" }),
  onVoiceMessage: (callback: (message: VoiceMessage) => void) => subscribe(IPC.voiceMessage, callback),
  onCanvasRequest: (callback: (request: CanvasRequest) => void) => subscribe(IPC.canvasRequest, callback),
  respondCanvasRequest: (response: CanvasResponse) => ipcRenderer.send(IPC.canvasResponse, response),
  onAgentEvent: (callback: (event: AgentEvent) => void) => subscribe(IPC.agentEvents, callback),
  onRuntimeState: (callback: (state: RuntimeState) => void) => subscribe(IPC.runtimeState, callback)
};

contextBridge.exposeInMainWorld("api", Object.freeze(api));

declare global {
  interface Window {
    api: BoardApi;
  }
}
