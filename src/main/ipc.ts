import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC,
  type BoardSnapshot,
  type CanvasResponse,
  type RuntimeConfig,
  type SettingsPatch,
  type TranscriptRole,
  type VoiceToolName,
} from "../shared/contracts";
import { assertSecretName, type SettingsService } from "./settings/settings-service";
import { mintRealtimeToken } from "./voice-token";
import { type RuntimeController } from "./runtime-controller";
import { type TranscriptStore } from "./transcript";
import { type CanvasBridge } from "./canvas-bridge";
import { type VoiceBridge } from "./voice-bridge";
import { callVoiceTool } from "./voice-tools";
import { isTrustedOrigin } from "./trusted-origin";
import type { RuntimeLedger } from "./ledger";
import type { PiRuntime } from "./pi-runtime";

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!isTrustedOrigin(url)) throw new Error(`Rejected IPC from untrusted origin: ${url || "unknown"}`);
}

export function registerIpc(options: {
  runtime: RuntimeController;
  transcript: TranscriptStore;
  canvas: CanvasBridge;
  voice: VoiceBridge;
  ledger: RuntimeLedger;
  pi: PiRuntime;
  settings: SettingsService;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): () => void {
  const { runtime, transcript, canvas, voice, ledger, pi, settings, sendToRenderer } = options;
  const handled: string[] = [];
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event);
      return fn(event, ...args);
    });
    handled.push(channel);
  };

  handle(IPC.voiceToken, () => {
    const voiceSettings = settings.settings.voice;
    return mintRealtimeToken({
      model: voiceSettings.model,
      voice: voiceSettings.voice,
      apiKey: settings.resolveApiKey().key,
    });
  });
  handle(IPC.setMicrophoneEnabled, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    return runtime.setMicrophoneEnabled(enabled);
  });
  handle(IPC.runtimeGetState, () => runtime.getState());
  handle(IPC.runtimeConfig, (): RuntimeConfig => ({ voiceDisabled: process.env.VOICE_DISABLED === "1" }));
  handle(IPC.appendTranscript, async (_event, input: { role?: TranscriptRole; text?: string }) => {
    if (!input || !["user", "assistant", "system"].includes(input.role ?? "") || typeof input.text !== "string") {
      throw new Error("Invalid transcript entry");
    }
    return transcript.append(input.role!, input.text);
  });
  handle(IPC.submitBoardSnapshot, (_event, snapshot: BoardSnapshot) => canvas.submitHumanSnapshot(snapshot));
  handle(IPC.getBoardSnapshot, () => canvas.getSnapshot());
  // The browser host tracks which tab owns the board; Electron has exactly one
  // window, so activation is a no-op acknowledgement.
  handle(IPC.activateCanvas, () => ({ ok: true as const }));
  handle(IPC.agentToolCall, (_event, name: VoiceToolName, args: Record<string, unknown> = {}) =>
    callVoiceTool({ runtime, canvas, voice, ledger, pi }, name, args));

  handle(IPC.settingsGet, () => settings.view());
  handle(IPC.settingsUpdate, (_event, patch: SettingsPatch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Settings patch must be an object");
    return settings.update(patch);
  });
  handle(IPC.settingsSecretSet, (_event, name: unknown, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("A secret value is required");
    return settings.setSecret(assertSecretName(name), value);
  });
  handle(IPC.settingsSecretClear, (_event, name: unknown) => settings.clearSecret(assertSecretName(name)));
  handle(IPC.settingsProbe, () => settings.probeWorkers());

  // A change from any source (this window, a hand edit, a future CLI) reaches
  // every renderer through the same channel the panel already listens on.
  const unsubscribeSettings = settings.store.onChange(() => {
    void settings.view().then(
      (view) => sendToRenderer(IPC.settingsChanged, view),
      (error: unknown) => console.error("Could not broadcast the settings change", error),
    );
  });

  const canvasListener = (_event: Electron.IpcMainEvent, response: CanvasResponse) => {
    canvas.acceptResponse(response);
  };
  ipcMain.on(IPC.canvasResponse, canvasListener);
  return () => {
    for (const channel of handled) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.canvasResponse, canvasListener);
    unsubscribeSettings();
  };
}
