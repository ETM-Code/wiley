import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertToExcalidrawElements, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { bridge, type AgentEvent, type AgentStatus, type ProjectView } from "./bridge";
import {
  isDiagramPreviewActive,
  subscribeToCanvasRequests,
  withoutDiagramPreviewElements,
} from "./canvas-handlers";
import { useColorScheme } from "./color-scheme";
import { HouseMusicPlayer } from "./house-music";
import ProjectPicker, { ProjectChip } from "./ProjectPicker";
import { RealtimeVoiceController, type VoiceState } from "./realtime-voice";
import SettingsPanel from "./SettingsPanel";

const MUSIC_PREFERENCE_KEY = "wiley:house-music";
const ACTIVITY_LIMIT = 8;
const ACTIVITY_TYPES = new Set<AgentEvent["type"]>([
  "tool_started",
  "assistant_message",
  "completed",
  "error",
]);

function firstLine(value: string, limit = 84): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function messageText(payload: unknown): string {
  const content = (payload as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"))
    .map((part) => part.text)
    .join(" ");
}

/** One quiet line per event: what happened, and just enough of the payload to recognise it. */
function describeAgentEvent(event: AgentEvent): { label: string; detail: string } {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  switch (event.type) {
    case "tool_started":
      return { label: String(payload?.toolName ?? "tool"), detail: firstLine(JSON.stringify(payload?.input ?? {})) };
    case "assistant_message":
      return { label: "said", detail: firstLine(messageText(payload)) };
    case "completed":
      return { label: "done", detail: firstLine(String(payload?.report ?? "")) };
    default:
      return { label: "error", detail: firstLine(String(payload?.error ?? "")) };
  }
}

function readMusicPreference(): boolean {
  try {
    return window.localStorage.getItem(MUSIC_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeMusicPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(MUSIC_PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    // Preference just resets next launch if storage is unavailable.
  }
}

function MusicNoteIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m3 3 18 18M9 13.55V9.99M9 6v-.74l12-2.4v10.29M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-1a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M9 18V5.26l12-2.4V17M9 8.66l12-2.4M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12-1a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6M17.3 17.3A8 8 0 0 1 4 12M20 12a8 8 0 0 1-.64 3.13M12 20v3M8 23h8" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v4M8 23h8" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a1.95 1.95 0 1 1-2.76 2.76l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.95 1.95 0 1 1-3.9 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.95 1.95 0 1 1-2.76-2.76l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97h-.17a1.95 1.95 0 1 1 0-3.9h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.95 1.95 0 1 1 2.76-2.76l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.47v-.17a1.95 1.95 0 1 1 3.9 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.95 1.95 0 1 1 2.76 2.76l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97h.17a1.95 1.95 0 1 1 0 3.9h-.09a1.6 1.6 0 0 0-1.46.97Z" />
    </svg>
  );
}

/** Statuses whose session is still there to be picked up in a terminal. */
const HANDOFF_STATUSES = new Set(["running", "awaiting_input", "done", "failed", "cancelled"]);

function AgentSidebar(
  { status, activity, onClose }: { status: AgentStatus; activity: AgentEvent[]; onClose: () => void },
) {
  const [handingOver, setHandingOver] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const handOff = async (workerId: string) => {
    setHandingOver(workerId);
    setHandoffError(null);
    try {
      const result = await bridge.openWorkerTerminal(workerId);
      if (result.fallbackReason) setHandoffError(result.fallbackReason);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandingOver(null);
    }
  };

  return (
    <aside className="agent-sidebar" aria-label="Wiley status">
      <header className="agent-sidebar__header">
        <div>
          <span className={`agent-dot${status.agentRunning ? " agent-dot--active" : ""}`} />
          <strong>{status.agentRunning ? "Working" : "Ready"}</strong>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close status">
          ×
        </button>
      </header>
      {status.summary ? <p className="agent-sidebar__summary">{status.summary}</p> : null}
      <div className="agent-sidebar__section">
        <h2>Background work</h2>
        {status.subagents?.length ? (
          <ul>
            {status.subagents.map((worker) => {
              const external = Boolean(worker.kind && worker.kind !== "pi");
              return (
                <li key={worker.id}>
                  <span>{worker.task || "Working"}</span>
                  <small>
                    {external ? <span className="worker-chip">{worker.kind}</span> : null}
                    {worker.status.replace("_", " ")}
                  </small>
                  {external && HANDOFF_STATUSES.has(worker.status) ? (
                    <button
                      type="button"
                      className="status-button"
                      // Winding down means the session has two owners for a
                      // moment; handing it over then would make that three.
                      disabled={handingOver !== null || worker.status === "winding_down"}
                      onClick={() => void handOff(worker.id)}
                    >
                      {handingOver === worker.id ? "Handing over…" : "Open in terminal"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="agent-sidebar__empty">Nothing running</p>
        )}
        {handoffError ? <p className="agent-sidebar__empty" role="alert">{handoffError}</p> : null}
      </div>
      <div className="agent-sidebar__section">
        <h2>Recent activity</h2>
        {activity.length ? (
          <ul className="agent-activity">
            {activity.map((event) => {
              const { label, detail } = describeAgentEvent(event);
              return (
                <li key={event.id} className={`agent-activity__item agent-activity__item--${event.type}`}>
                  <span className="agent-activity__label">{label}</span>
                  {detail ? <span className="agent-activity__detail">{detail}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="agent-sidebar__empty">No activity yet</p>
        )}
      </div>
    </aside>
  );
}

function DebugTaskInput() {
  const [task, setTask] = useState("");
  const [sending, setSending] = useState(false);

  const submit = useCallback(async () => {
    const value = task.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await bridge.agentToolCall("send_task_to_agent", { task: value, user_words: value });
      setTask("");
    } finally {
      setSending(false);
    }
  }, [sending, task]);

  return (
    <form
      className="debug-task"
      aria-label="Voice-disabled agent input"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Ask Wiley to change the board…"
        aria-label="Agent task"
      />
      <button type="submit" disabled={!task.trim() || sending}>
        {sending ? "Starting…" : "Run"}
      </button>
    </form>
  );
}

export default function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const boardRevisionRef = useRef(0);
  const boardReadyRef = useRef(false);
  const lastSubmittedElementsRef = useRef("");
  const snapshotPendingRef = useRef(false);
  const canvasMutationActiveRef = useRef(false);
  const colorScheme = useColorScheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus>({ agentRunning: false, subagents: [] });
  const [activity, setActivity] = useState<AgentEvent[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [voiceDisabled, setVoiceDisabled] = useState(false);
  const [projects, setProjects] = useState<ProjectView | null>(null);
  const voice = useMemo(
    () =>
      new RealtimeVoiceController((message) => {
        setToast(message);
      }),
    [],
  );
  const [voiceState, setVoiceState] = useState<VoiceState>(() => voice.getState());
  const microphoneEnabled = voiceState.microphoneEnabled;
  const music = useMemo(() => new HouseMusicPlayer(), []);
  const [musicEnabled, setMusicEnabled] = useState(readMusicPreference);

  useEffect(() => voice.subscribe(setVoiceState), [voice]);
  useEffect(() => () => voice.destroy(), [voice]);
  useEffect(() => () => music.dispose(), [music]);

  useEffect(() => {
    if (!musicEnabled || !status.agentRunning) {
      music.stop();
      return;
    }
    // A short delay keeps trivial tasks from producing a one-beat blip.
    const timer = window.setTimeout(() => music.start(), 600);
    return () => window.clearTimeout(timer);
  }, [music, musicEnabled, status.agentRunning]);

  useEffect(() => {
    music.setSpeechActive(voiceState.assistantAudioActive || voiceState.userSpeechActive);
  }, [music, voiceState.assistantAudioActive, voiceState.userSpeechActive]);

  const toggleMusic = useCallback(() => {
    setMusicEnabled((enabled) => {
      writeMusicPreference(!enabled);
      return !enabled;
    });
  }, []);

  useEffect(() => {
    return bridge.onAgentEvent((event) => {
      if (!ACTIVITY_TYPES.has(event.type)) return;
      setActivity((events) => [event, ...events].slice(0, ACTIVITY_LIMIT));
    });
  }, []);

  useEffect(() => {
    void bridge.isVoiceDisabled().then(setVoiceDisabled);
    const unsubscribe = bridge.onAgentStatus(setStatus);
    let active = true;
    const refresh = async () => {
      try {
        const next = await bridge.getAgentStatus();
        if (active) {
          setStatus(next);
        }
      } catch {
        // The canvas remains usable if the optional status endpoint is absent.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  useEffect(
    () => subscribeToCanvasRequests(
      () => apiRef.current,
      setToast,
      (active) => {
        canvasMutationActiveRef.current = active;
        if (active && snapshotTimerRef.current !== null) {
          window.clearTimeout(snapshotTimerRef.current);
          snapshotTimerRef.current = null;
          snapshotPendingRef.current = false;
        }
      },
    ),
    [],
  );

  useEffect(
    () => () => {
      if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const syncVisibleCanvas = useCallback(async () => {
    if (document.visibilityState !== "visible") return false;
    // The backend snapshot is only committed after a canvas tool completes.
    // Applying it while a diagram is streaming would replace the partial scene
    // with the previous revision between frames.
    if (canvasMutationActiveRef.current || isDiagramPreviewActive()) return true;
    const api = apiRef.current;
    if (!api) return false;
    await bridge.activateCanvas();
    const snapshot = await bridge.getBoardSnapshot();
    if (!snapshot) return false;
    const validElements = snapshot.elements.every((element) =>
      [element.x, element.y, element.width, element.height].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
    );
    if (!validElements) return true;
    const current = api.getSceneElements();
    const currentFingerprint = JSON.stringify(current);
    const canonicalFingerprint = JSON.stringify(snapshot.elements);
    let applied = false;
    if (!snapshotPendingRef.current
      && snapshot.revision >= boardRevisionRef.current
      && currentFingerprint !== canonicalFingerprint) {
      lastSubmittedElementsRef.current = canonicalFingerprint;
      if (snapshot.files && Object.keys(snapshot.files).length > 0) {
        api.addFiles(Object.values(snapshot.files) as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
      }
      api.updateScene({
        elements: snapshot.elements as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"],
      });
      boardRevisionRef.current = snapshot.revision;
      applied = true;
    } else {
      boardRevisionRef.current = Math.max(boardRevisionRef.current, snapshot.revision);
    }
    boardReadyRef.current = true;
    if (applied && snapshot.elements.length > 0) {
      await api.scrollToContent(api.getSceneElements(), {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        animate: false,
      });
    }
    return true;
  }, []);

  const captureApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    const testHooks = window as unknown as {
      excalidrawAPI?: ExcalidrawImperativeAPI;
      convertToExcalidrawElements?: typeof convertToExcalidrawElements;
    };
    testHooks.excalidrawAPI = api;
    // Layer-3 test rigs simulate human drawing through the app's own
    // pipeline instead of fabricating raw Excalidraw internals.
    testHooks.convertToExcalidrawElements = convertToExcalidrawElements;
    void syncVisibleCanvas().catch(() => undefined);
  }, [syncVisibleCanvas]);

  useEffect(() => {
    let retry: number | undefined;
    const activate = () => {
      window.clearTimeout(retry);
      void syncVisibleCanvas().then((ready) => {
        if (!ready) retry = window.setTimeout(activate, 1_000);
      }).catch(() => {
        retry = window.setTimeout(activate, 1_000);
      });
    };
    window.addEventListener("focus", activate);
    document.addEventListener("visibilitychange", activate);
    const syncTimer = window.setInterval(activate, 2_000);
    activate();
    return () => {
      window.removeEventListener("focus", activate);
      document.removeEventListener("visibilitychange", activate);
      window.clearInterval(syncTimer);
      window.clearTimeout(retry);
    };
  }, [syncVisibleCanvas]);

  /**
   * A different project means a different board with its own revision numbers,
   * which may well be lower than the ones this window has been counting. Every
   * piece of that bookkeeping resets before the first sync, or the new
   * project's board would be judged stale against the old one's and ignored.
   */
  const resetBoard = useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    boardRevisionRef.current = 0;
    boardReadyRef.current = false;
    snapshotPendingRef.current = false;
    lastSubmittedElementsRef.current = "";
    apiRef.current?.updateScene({
      elements: [] as unknown as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"],
    });
    setActivity([]);
    void syncVisibleCanvas().catch(() => undefined);
  }, [syncVisibleCanvas]);

  useEffect(() => {
    let live = true;
    void bridge.getProjects().then((view) => {
      if (live) setProjects(view);
    }, () => {
      // A host with no project flow leaves the board exactly as it was.
      if (live) setProjects({ recent: [], canOpen: false });
    });
    const unsubscribe = bridge.onProjectChanged((view) => {
      setProjects(view);
      resetBoard();
      setToast(view.current ? `Opened ${view.current.name}` : null);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [resetBoard]);

  const toggleMicrophone = useCallback(async () => {
    try {
      await voice.toggleMicrophone();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Microphone could not be enabled");
    }
  }, [voice]);

  const submitCanvasSnapshot = useCallback(
    (elements: readonly Record<string, unknown>[], appState: Record<string, unknown>, files: Record<string, unknown>) => {
      if (!boardReadyRef.current) return;
      // Progressive agent frames are transient. The canvas bridge persists the
      // final board snapshot atomically with the successful tool response.
      if (canvasMutationActiveRef.current) return;
      const elementCopies = withoutDiagramPreviewElements(elements).map((element) => ({ ...element }));
      const elementsFingerprint = JSON.stringify(elementCopies);
      if (elementsFingerprint === lastSubmittedElementsRef.current) return;
      snapshotPendingRef.current = true;
      if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
      const submit = async () => {
        if (canvasMutationActiveRef.current) {
          snapshotPendingRef.current = false;
          snapshotTimerRef.current = null;
          return;
        }
        const proposedRevision = boardRevisionRef.current + 1;
        try {
          const accepted = await bridge.submitBoardSnapshot({
            revision: proposedRevision,
            elements: elementCopies,
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              scrollX: typeof appState.scrollX === "number" && Number.isFinite(appState.scrollX) ? appState.scrollX : 0,
              scrollY: typeof appState.scrollY === "number" && Number.isFinite(appState.scrollY) ? appState.scrollY : 0,
              zoom: appState.zoom && typeof appState.zoom === "object"
                ? { ...appState.zoom, value: Number.isFinite((appState.zoom as { value?: number }).value)
                  ? (appState.zoom as { value: number }).value
                  : 1 }
                : { value: 1 },
            },
            files,
          });
          boardRevisionRef.current = Math.max(proposedRevision, accepted?.revision ?? 0);
          lastSubmittedElementsRef.current = elementsFingerprint;
          snapshotPendingRef.current = false;
        } catch {
          snapshotTimerRef.current = window.setTimeout(() => void submit(), 750);
        }
      };
      snapshotTimerRef.current = window.setTimeout(() => void submit(), 120);
    },
    [],
  );

  // Nothing is running behind this and there is no board to show, so the
  // picker gets the whole window rather than floating over an empty canvas.
  if (projects && !projects.current && projects.canOpen) {
    return (
      <main className="app-shell">
        <ProjectPicker view={projects} onOpened={setProjects} />
        {toast ? <div className="app-toast" role="status">{toast}</div> : null}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <Excalidraw
        theme={colorScheme}
        excalidrawAPI={captureApi}
        onChange={(elements, appState, files) =>
          submitCanvasSnapshot(
            elements as unknown as readonly Record<string, unknown>[],
            appState as unknown as Record<string, unknown>,
            files as unknown as Record<string, unknown>,
          )
        }
        renderTopRightUI={() => (
          <>
            {projects ? <ProjectChip view={projects} onOpened={setProjects} /> : null}
            <button
              type="button"
              className="status-button"
              onClick={() => {
                if (!window.confirm("Start a fresh session? This clears the board and Wiley's working memory.")) return;
                void bridge.agentToolCall("new_session", {})
                  .then(() => setToast("Fresh session started"))
                  .catch((error: unknown) =>
                    setToast(error instanceof Error ? error.message : "Could not start a new session"));
              }}
              title="Clear the board and start a fresh session"
            >
              New session
            </button>
            <button
              type="button"
              className="status-button"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-expanded={sidebarOpen}
              aria-controls="agent-status-sidebar"
            >
              <span className={`agent-dot${status.agentRunning ? " agent-dot--active" : ""}`} />
              Status
            </button>
            <button
              type="button"
              className="status-button status-button--icon"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="wiley-settings-panel"
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </>
        )}
      />

      {sidebarOpen ? (
        <div id="agent-status-sidebar">
          <AgentSidebar status={status} activity={activity} onClose={() => setSidebarOpen(false)} />
        </div>
      ) : null}

      {settingsOpen ? (
        <div id="wiley-settings-panel">
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </div>
      ) : null}

      {voiceDisabled ? <DebugTaskInput /> : null}

      <div className="voice-corner">
        {microphoneEnabled || voiceState.dictationText ? (
          <div
            className={`dictation-pill dictation-pill--${voiceState.dictationStatus}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="dictation-pill__state">
              {voiceState.microphoneStarting
                ? "Starting"
                : voiceState.dictationStatus === "processing"
                ? "Understanding"
                : voiceState.dictationStatus === "heard"
                  ? "Heard"
                  : voiceState.userSpeechActive
                    ? "Listening"
                    : "Ready"}
            </span>
            <span className={`dictation-pill__text${voiceState.dictationText ? "" : " dictation-pill__text--empty"}`}>
              {voiceState.dictationText
                || (voiceState.microphoneStarting
                  ? "Connecting microphone…"
                  : voiceState.userSpeechActive
                    ? "Speak naturally…"
                    : "Say something…")}
            </span>
          </div>
        ) : null}

        <button
          type="button"
          className={`microphone-button music-button${musicEnabled && status.agentRunning ? " music-button--playing" : ""}`}
          onClick={toggleMusic}
          aria-label={musicEnabled ? "Turn off house music while Wiley works" : "Turn on house music while Wiley works"}
          aria-pressed={musicEnabled}
          title={musicEnabled ? "House music plays while Wiley works. Click to turn off." : "House music is off. Click to play it while Wiley works."}
        >
          <MusicNoteIcon muted={!musicEnabled} />
        </button>

        <button
          type="button"
          className={`microphone-button${microphoneEnabled ? " microphone-button--active" : ""}${voiceState.microphoneStarting ? " microphone-button--starting" : ""}`}
          onClick={() => void toggleMicrophone()}
          aria-label={voiceState.microphoneStarting ? "Starting microphone" : microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
          aria-pressed={microphoneEnabled}
          aria-busy={voiceState.microphoneStarting}
          disabled={voiceState.microphoneStarting}
          title={voiceState.microphoneStarting ? "Starting microphone" : microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
        >
          <MicrophoneIcon muted={!microphoneEnabled} />
        </button>
      </div>

      {toast ? (
        <div className="app-toast" role="status">
          {toast}
        </div>
      ) : null}
    </main>
  );
}
