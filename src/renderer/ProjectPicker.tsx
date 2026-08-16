import { useCallback, useEffect, useRef, useState } from "react";

import { bridge, type ProjectEntry, type ProjectView } from "./bridge";
import { openedLabel, shortPath } from "./project-path";

function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2a1.5 1.5 0 0 1 1.06.44l1.3 1.3a1.5 1.5 0 0 0 1.07.44h6.37A1.5 1.5 0 0 1 20 9.68V17a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17Z" />
    </svg>
  );
}

function useOpenProject(onOpened?: (view: ProjectView) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(async (path?: string) => {
    setBusy(true);
    setError(null);
    try {
      onOpened?.(await bridge.openProject(path));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }, [onOpened]);
  return { open, busy, error };
}

function RecentList(
  { entries, busy, onOpen }: { entries: ProjectEntry[]; busy: boolean; onOpen: (path: string) => void },
) {
  if (entries.length === 0) return <p className="project-empty">No projects opened yet</p>;
  return (
    <ul className="project-list">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            className="project-item"
            disabled={busy || entry.missing}
            onClick={() => onOpen(entry.path)}
            title={entry.missing ? `${entry.path} is no longer on disk` : entry.path}
          >
            <span className="project-item__name">{entry.name}</span>
            <span className="project-item__path">{shortPath(entry.path)}</span>
            <span className="project-item__meta">
              {entry.missing ? "Moved or deleted" : openedLabel(entry) ?? ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the window shows before there is a project to show anything about.
 * Deliberately the whole window rather than a dialog over the board: there is
 * no board yet, and an empty canvas behind a modal would suggest otherwise.
 */
export default function ProjectPicker(
  { view, onOpened }: { view: ProjectView; onOpened: (next: ProjectView) => void },
) {
  const { open, busy, error } = useOpenProject(onOpened);
  return (
    <div className="project-picker">
      <div className="project-picker__card">
        <h1>Wiley</h1>
        <p className="project-picker__lead">
          Wiley works inside a project folder: everything it reads, writes and runs stays there, and the folder keeps
          its own boards and history.
        </p>
        <button type="button" className="project-open" disabled={busy} onClick={() => void open()}>
          <FolderIcon />
          {busy ? "Opening…" : "Open Folder…"}
        </button>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        <h2>Recent</h2>
        <RecentList entries={view.recent} busy={busy} onOpen={(path) => void open(path)} />
      </div>
    </div>
  );
}

/**
 * Which project the board belongs to, and the way into another one. A host
 * that serves a single project shows the name and nothing to click.
 */
export function ProjectChip({ view, onOpened }: { view: ProjectView; onOpened: (next: ProjectView) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const { open, busy, error } = useOpenProject((next) => {
    setMenuOpen(false);
    onOpened(next);
  });

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const current = view.current;
  if (!current) return null;
  if (!view.canOpen) {
    return (
      <span className="status-button project-chip project-chip--fixed" title={current.path}>
        <FolderIcon />
        {current.name}
      </span>
    );
  }

  return (
    <div className="project-chip-wrap" ref={container}>
      <button
        type="button"
        className="status-button project-chip"
        onClick={() => setMenuOpen((isOpen) => !isOpen)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title={`${current.path}\nSwitch project`}
      >
        <FolderIcon />
        {current.name}
      </button>
      {menuOpen ? (
        <div className="project-menu" role="menu">
          <button type="button" className="project-menu__open" disabled={busy} onClick={() => void open()}>
            {busy ? "Opening…" : "Open Folder…"}
          </button>
          {error ? <p className="settings-error" role="alert">{error}</p> : null}
          <h3>Recent</h3>
          <RecentList
            entries={view.recent.filter((entry) => entry.path !== current.path)}
            busy={busy}
            onOpen={(path) => void open(path)}
          />
        </div>
      ) : null}
    </div>
  );
}
