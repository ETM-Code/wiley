import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AgentEvent,
  type BoardApi,
  type BoardSnapshot,
  type CanvasRequest,
  type CanvasResponse,
  type RuntimeState,
  type SecretName,
  type SettingsPatch,
  type SettingsView,
  type TranscriptDraft,
  type VoiceInjection,
  type WorkerKind
} from "../shared/contracts";

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BoardApi = {
  getVoiceToken: () => ipcRenderer.invoke(IPC.voiceToken),
  agentToolCall: (name, args) => ipcRenderer.invoke(IPC.agentToolCall, name, args),
  appendTranscript: (entry: TranscriptDraft) => ipcRenderer.invoke(IPC.appendTranscript, entry),
  getAgentStatus: () => ipcRenderer.invoke(IPC.runtimeGetState),
  setMicrophoneEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.setMicrophoneEnabled, enabled),
  submitBoardSnapshot: (snapshot: BoardSnapshot) => ipcRenderer.invoke(IPC.submitBoardSnapshot, snapshot),
  getBoardSnapshot: () => ipcRenderer.invoke(IPC.getBoardSnapshot),
  activateCanvas: () => ipcRenderer.invoke(IPC.activateCanvas),
  getRuntimeConfig: () => ipcRenderer.invoke(IPC.runtimeConfig),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  setSecret: (name: SecretName, value: string) => ipcRenderer.invoke(IPC.settingsSecretSet, name, value),
  clearSecret: (name: SecretName) => ipcRenderer.invoke(IPC.settingsSecretClear, name),
  probeWorkers: () => ipcRenderer.invoke(IPC.settingsProbe),
  chooseDirectory: (current?: string) => ipcRenderer.invoke(IPC.settingsChooseDirectory, current),
  testCloudConnection: () => ipcRenderer.invoke(IPC.cloudTestConnection),
  openWorkerTerminal: (workerId: string) => ipcRenderer.invoke(IPC.workersOpenTerminal, { workerId }),
  newTerminalSession: (kind: WorkerKind) => ipcRenderer.invoke(IPC.workersNewTerminalSession, { kind }),
  onSettingsChanged: (callback: (settings: SettingsView) => void) => subscribe(IPC.settingsChanged, callback),
  onVoiceMessage: (callback: (message: VoiceInjection) => void) => subscribe(IPC.voiceInject, callback),
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
