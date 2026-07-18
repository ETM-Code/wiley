import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { bridge, type AgentStatus } from "./bridge";
import { subscribeToCanvasRequests } from "./canvas-handlers";
import { RealtimeVoiceController, type VoiceState } from "./realtime-voice";

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

function AgentSidebar({ status, onClose }: { status: AgentStatus; onClose: () => void }) {
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
            {status.subagents.map((worker) => (
              <li key={worker.id}>
                <span>{worker.task || "Working"}</span>
                <small>{worker.status}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agent-sidebar__empty">Nothing running</p>
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus>({ agentRunning: false, subagents: [] });
  const [toast, setToast] = useState<string | null>(null);
  const [voiceDisabled, setVoiceDisabled] = useState(false);
  const voice = useMemo(
    () =>
      new RealtimeVoiceController((message) => {
        setToast(message);
      }),
    [],
  );
  const [voiceState, setVoiceState] = useState<VoiceState>(() => voice.getState());
  const microphoneEnabled = voiceState.microphoneEnabled;

  useEffect(() => voice.subscribe(setVoiceState), [voice]);
  useEffect(() => () => voice.destroy(), [voice]);

  useEffect(() => {
    void bridge.isVoiceDisabled().then(setVoiceDisabled);
    const unsubscribe = bridge.onAgentStatus(setStatus);
    let active = true;
    const refresh = async () => {
      try {
        const next = await bridge.getAgentStatus();
        if (active) {
          if (typeof next.boardRevision === "number") {
            boardRevisionRef.current = Math.max(boardRevisionRef.current, next.boardRevision);
          }
          boardReadyRef.current = true;
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

  useEffect(() => subscribeToCanvasRequests(() => apiRef.current, setToast), []);

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

  const captureApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    (window as unknown as { excalidrawAPI?: ExcalidrawImperativeAPI }).excalidrawAPI = api;
  }, []);

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
      if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = window.setTimeout(() => {
        boardRevisionRef.current += 1;
        bridge.submitBoardSnapshot({
          revision: boardRevisionRef.current,
          elements: elements.map((element) => ({ ...element })),
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: appState.zoom,
          },
          files,
        });
      }, 120);
    },
    [],
  );

  return (
    <main className="app-shell">
      <Excalidraw
        excalidrawAPI={captureApi}
        onChange={(elements, appState, files) =>
          submitCanvasSnapshot(
            elements as unknown as readonly Record<string, unknown>[],
            appState as unknown as Record<string, unknown>,
            files as unknown as Record<string, unknown>,
          )
        }
        renderTopRightUI={() => (
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
        )}
      />

      {sidebarOpen ? (
        <div id="agent-status-sidebar">
          <AgentSidebar status={status} onClose={() => setSidebarOpen(false)} />
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
              {voiceState.dictationStatus === "processing"
                ? "Understanding"
                : voiceState.dictationStatus === "heard"
                  ? "Heard"
                  : voiceState.userSpeechActive
                    ? "Listening"
                    : "Ready"}
            </span>
            <span className={`dictation-pill__text${voiceState.dictationText ? "" : " dictation-pill__text--empty"}`}>
              {voiceState.dictationText || (voiceState.userSpeechActive ? "Speak naturally…" : "Say something…")}
            </span>
          </div>
        ) : null}

        <button
          type="button"
          className={`microphone-button${microphoneEnabled ? " microphone-button--active" : ""}`}
          onClick={() => void toggleMicrophone()}
          aria-label={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
          aria-pressed={microphoneEnabled}
          title={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
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
