import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  IPC,
  type BoardSnapshot,
  type CanvasResponse,
  type ProjectView,
  type RuntimeConfig,
  type RuntimeState,
  type SettingsPatch,
  type TranscriptRole,
  type VoiceToolName,
} from "../shared/contracts";
import { assertSecretName, type SettingsService } from "./settings/settings-service";
import { effectiveThinkingLevel } from "./settings/settings-schema";
import { mintConfiguredVoiceToken } from "./cloud/cloud-mode";
import { testCloudConnection } from "./cloud/cloud-account";
import { type RuntimeController } from "./runtime-controller";
import { type TranscriptStore } from "./transcript";
import { type CanvasBridge } from "./canvas-bridge";
import { type VoiceBridge } from "./voice-bridge";
import { callVoiceTool } from "./voice-tools";
import { isTrustedOrigin } from "./trusted-origin";
import { isCliWorkerKind } from "./workers/worker-types";
import type { RuntimeLedger } from "./ledger";
import type { PiRuntime } from "./pi-runtime";

/**
 * Everything bound to one open project. All of it is rebuilt when the user
 * switches, which is why the IPC layer reaches for it through an accessor
 * rather than closing over the instances it was registered with.
 */
export interface RuntimeHandles {
  projectDir: string;
  controller: RuntimeController;
  transcript: TranscriptStore;
  canvas: CanvasBridge;
  voice: VoiceBridge;
  ledger: RuntimeLedger;
  pi: PiRuntime;
}

/** The host side of opening and switching projects. */
export interface ProjectHost {
  view(): ProjectView;
  /** Opens `path`, or asks with a native folder picker when it is omitted. */
  open(input: { path?: string }, owner?: BrowserWindow): Promise<ProjectView>;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!isTrustedOrigin(url)) throw new Error(`Rejected IPC from untrusted origin: ${url || "unknown"}`);
}

/** The native folder picker, used both by settings and by the project flow. */
export async function chooseProjectDirectory(
  owner: BrowserWindow | null,
  current?: string,
): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose the folder Wiley may work in",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
    ...(current?.trim() ? { defaultPath: current.trim() } : {}),
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/**
 * What the board asks for before a project is open. The picker is on screen at
 * that point and nothing is running, so this says exactly that rather than
 * throwing at a renderer that is polling on a timer.
 */
function idleState(settings: SettingsService): RuntimeState {
  const current = settings.settings;
  return {
    microphoneEnabled: false,
    agentRunning: false,
    activeJobs: [],
    subagents: [],
    boardRevision: 0,
    voiceModel: current.voice.model,
    agentModel: current.agent.model,
    reasoningEffort: effectiveThinkingLevel(current),
    fastMode: current.agent.fastMode,
  };
}

const EMPTY_BOARD: BoardSnapshot = { revision: 0, elements: [], appState: {} };

export function registerIpc(options: {
  /** Undefined until a project is open, and a different object after a switch. */
  runtime: () => RuntimeHandles | undefined;
  projects: ProjectHost;
  settings: SettingsService;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): () => void {
  const { projects, settings, sendToRenderer } = options;
  const handled: string[] = [];
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event);
      return fn(event, ...args);
    });
    handled.push(channel);
  };
  /** For everything that has no answer at all without an open project. */
  const active = (): RuntimeHandles => {
    const runtime = options.runtime();
    if (!runtime) throw new Error("No project is open yet. Open one to start working.");
    return runtime;
  };

  handle(IPC.voiceToken, () => mintConfiguredVoiceToken({
    settings: settings.settings,
    secrets: settings.store.secrets,
    apiKey: settings.resolveApiKey().key,
  }));
  handle(IPC.setMicrophoneEnabled, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    return active().controller.setMicrophoneEnabled(enabled);
  });
  handle(IPC.runtimeGetState, () => options.runtime()?.controller.getState() ?? idleState(settings));
  handle(IPC.runtimeConfig, (): RuntimeConfig => ({ voiceDisabled: process.env.VOICE_DISABLED === "1" }));
  handle(IPC.appendTranscript, async (_event, input: { role?: TranscriptRole; text?: string }) => {
    if (!input || !["user", "assistant", "system"].includes(input.role ?? "") || typeof input.text !== "string") {
      throw new Error("Invalid transcript entry");
    }
    return active().transcript.append(input.role!, input.text);
  });
  handle(IPC.submitBoardSnapshot, (_event, snapshot: BoardSnapshot) => active().canvas.submitHumanSnapshot(snapshot));
  handle(IPC.getBoardSnapshot, () => options.runtime()?.canvas.getSnapshot() ?? EMPTY_BOARD);
  // The browser host tracks which tab owns the board; Electron has exactly one
  // window, so activation is a no-op acknowledgement.
  handle(IPC.activateCanvas, () => ({ ok: true as const }));
  handle(IPC.agentToolCall, (_event, name: VoiceToolName, args: Record<string, unknown> = {}) => {
    const { controller, canvas, voice, ledger, pi } = active();
    return callVoiceTool({ runtime: controller, canvas, voice, ledger, pi }, name, args);
  });

  handle(IPC.projectsGet, () => projects.view());
  handle(IPC.projectsOpen, (event, input: { path?: unknown } = {}) => {
    const target = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : undefined;
    return projects.open({ path: target }, BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });

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
  handle(IPC.settingsChooseDirectory, (event, current: unknown) => chooseProjectDirectory(
    BrowserWindow.fromWebContents(event.sender),
    typeof current === "string" ? current : undefined,
  ));
  handle(IPC.cloudTestConnection, () => testCloudConnection(settings));
  handle(IPC.workersOpenTerminal, (_event, input: { workerId?: unknown }) => {
    if (typeof input?.workerId !== "string" || !input.workerId.trim()) throw new Error("A worker id is required");
    return active().pi.openWorkerTerminal(input.workerId.trim());
  });
  handle(IPC.workersNewTerminalSession, (_event, input: { kind?: unknown }) => {
    if (!isCliWorkerKind(input?.kind)) throw new Error("kind must be claude or codex");
    return active().pi.startTerminalSession(input.kind);
  });

  // A change from any source (this window, a hand edit, a future CLI) reaches
  // every renderer through the same channel the panel already listens on.
  const unsubscribeSettings = settings.store.onChange(() => {
    void settings.view().then(
      (view) => sendToRenderer(IPC.settingsChanged, view),
      (error: unknown) => console.error("Could not broadcast the settings change", error),
    );
  });

  const canvasListener = (_event: Electron.IpcMainEvent, response: CanvasResponse) => {
    options.runtime()?.canvas.acceptResponse(response);
  };
  ipcMain.on(IPC.canvasResponse, canvasListener);
  return () => {
    for (const channel of handled) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.canvasResponse, canvasListener);
    unsubscribeSettings();
  };
}
