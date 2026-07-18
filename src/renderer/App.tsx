import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { bridge, type AgentStatus } from "./bridge";
import {
  isDiagramPreviewActive,
  subscribeToCanvasRequests,
  withoutDiagramPreviewElements,
} from "./canvas-handlers";
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
  const lastSubmittedElementsRef = useRef("");
  const snapshotPendingRef = useRef(false);
  const canvasMutationActiveRef = useRef(false);
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
    (window as unknown as { excalidrawAPI?: ExcalidrawImperativeAPI }).excalidrawAPI = api;
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
