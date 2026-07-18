import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC, type BoardSnapshot, type TranscriptRole, type VoiceToolName } from "./contracts";
import { mintRealtimeToken } from "./voice-token";
import { RuntimeController } from "./runtime-controller";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";
import { VoiceBridge } from "./voice-bridge";

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  const trusted = url.startsWith("wiley://app/") || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(url);
  if (!trusted) throw new Error(`Rejected IPC from untrusted origin: ${url || "unknown"}`);
}

export function registerIpc(options: {
  runtime: RuntimeController;
  transcript: TranscriptStore;
  canvas: CanvasBridge;
  voice: VoiceBridge;
}): () => void {
  const { runtime, transcript, canvas, voice } = options;
  const handled: string[] = [];
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event);
      return fn(event, ...args);
    });
    handled.push(channel);
  };

  handle(IPC.voiceToken, () => mintRealtimeToken());
  handle(IPC.setMicrophoneEnabled, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    return runtime.setMicrophoneEnabled(enabled);
  });
  handle(IPC.runtimeGetState, () => runtime.getState());
  handle(IPC.listActiveJobs, () => runtime.listActiveJobs());
  handle(IPC.appendTranscript, async (_event, input: { role?: TranscriptRole; text?: string }) => {
    if (!input || !["user", "assistant", "system"].includes(input.role ?? "") || typeof input.text !== "string") {
      throw new Error("Invalid transcript entry");
    }
    return transcript.append(input.role!, input.text);
  });
  handle(IPC.getTranscript, () => transcript.all());
  handle(IPC.submitBoardSnapshot, (_event, snapshot: BoardSnapshot) => canvas.submitHumanSnapshot(snapshot));
  handle(IPC.agentToolCall, async (_event, name: VoiceToolName, args: Record<string, unknown> = {}) => {
    switch (name) {
      case "send_task_to_agent":
        return runtime.submitJob(String(args.task ?? ""), String(args.user_words ?? ""), args.queue === true);
      case "answer_agent":
        return { ok: voice.deliverAnswer(String(args.answer ?? "")) };
      case "get_agent_status":
        return runtime.getState();
      case "look_at_board": {
        const elements = await canvas.request<Array<{ type?: string; text?: string }>>("get-scene-summary");
        return {
          elements: elements.length,
          texts: elements.filter((element) => element.text).map((element) => element.text),
        };
      }
      case "abort_agent":
        await runtime.abortCurrent();
        return { ok: true, note: "Current work aborted." };
      default:
        throw new Error(`Unknown voice tool: ${String(name)}`);
    }
  });

  const canvasListener = (_event: Electron.IpcMainEvent, response: import("./contracts").CanvasResponse) => {
    canvas.acceptResponse(response);
  };
  ipcMain.on(IPC.canvasResponse, canvasListener);
  return () => {
    for (const channel of handled) ipcMain.removeHandler(channel);
    ipcMain.removeListener(IPC.canvasResponse, canvasListener);
  };
}
