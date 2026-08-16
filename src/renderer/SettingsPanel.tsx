import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bridge, type SettingsView, type WileySettings } from "./bridge";
import { VOICE_MODEL_OPTIONS, VOICE_NAME_OPTIONS } from "../main/settings/model-catalog";
import {
  AGENT_THINKING_LEVELS,
  VOICE_REASONING_EFFORTS,
  WORKER_APPROVAL_BRIDGES,
  WORKER_KINDS,
  WORKER_SANDBOXES,
  type AgentThinkingLevel,
  type AuthMode,
  type VoiceReasoningEffort,
  type WorkerApprovalBridge,
  type WorkerKind,
  type WorkerSandbox,
  type WorkerSettings,
} from "../main/settings/settings-schema";
import {
  formatListInput,
  formatRuleLines,
  hasDraftChanges,
  modelChoices,
  parseListInput,
  parseRuleLines,
  settingsDraftPatch,
  settingsOf,
  toggleAllowedModel,
} from "./settings-draft";

const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan"];
const CUSTOM = "__custom__";

/** A dropdown of known ids that still accepts anything the user types. */
function ModelPicker(
  { label, value, options, onChange, hint }:
  { label: string; value: string; options: readonly string[]; onChange: (value: string) => void; hint?: string },
) {
  const known = options.includes(value);
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <select value={known ? value : CUSTOM} onChange={(event) => {
        const next = event.target.value;
        onChange(next === CUSTOM ? "" : next);
      }}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
        <option value={CUSTOM}>Other…</option>
      </select>
      {known ? null : (
        <input
          type="text"
          value={value}
          placeholder="Model id"
          aria-label={`${label} (custom)`}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <small className="settings-hint">{hint}</small> : null}
    </label>
  );
}

function TextField(
  { label, value, placeholder, onChange, hint }:
  { label: string; value: string; placeholder?: string; onChange: (value: string) => void; hint?: string },
) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint ? <small className="settings-hint">{hint}</small> : null}
    </label>
  );
}

function SelectField<T extends string>(
  { label, value, options, onChange }:
  { label: string; value: T; options: readonly T[]; onChange: (value: T) => void },
) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function NumberField(
  { label, value, min, max, step, onChange, hint }:
  { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; hint?: string },
) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {hint ? <small className="settings-hint">{hint}</small> : null}
    </label>
  );
}

function Toggle(
  { label, checked, onChange, hint, disabled }:
  { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: boolean },
) {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {hint ? <small className="settings-hint">{hint}</small> : null}
      </span>
    </label>
  );
}

function WorkerCard(
  { kind, worker, probe, onChange }:
  {
    kind: WorkerKind;
    worker: WorkerSettings;
    probe: { available: boolean; reason?: string; version?: string };
    onChange: (patch: Partial<WorkerSettings>) => void;
  },
) {
  return (
    <div className="settings-card">
      <header className="settings-card__header">
        <strong>{kind === "claude" ? "Claude Code" : "Codex"}</strong>
        <span className={`settings-chip${probe.available ? " settings-chip--ok" : ""}`}>
          {probe.available ? probe.version ?? "available" : "unavailable"}
        </span>
      </header>
      {probe.available ? null : (
        <p className="settings-hint">{probe.reason ?? "This CLI was not found on this machine."}</p>
      )}
      <Toggle
        label="Let Wiley delegate work to this CLI"
        checked={worker.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      <TextField
        label="Command"
        value={worker.command ?? ""}
        placeholder={kind}
        hint="Leave blank to find it on PATH."
        onChange={(command) => onChange({ command: command.trim() ? command : undefined })}
      />
      <TextField
        label="Model"
        value={worker.model ?? ""}
        placeholder="device default"
        hint="Blank sends no model flag, so the run uses whatever this machine's CLI defaults to. Pinning a cheap model can cost 7 to 17 times less per turn."
        onChange={(model) => onChange({ model: model.trim() ? model : undefined })}
      />
      <TextField
        label="Effort"
        value={worker.effort ?? ""}
        placeholder="device default"
        onChange={(effort) => onChange({ effort: effort.trim() ? effort : undefined })}
      />
      {kind === "claude" ? (
        <SelectField
          label="Permission mode"
          value={worker.permissionMode ?? "default"}
          options={CLAUDE_PERMISSION_MODES}
          onChange={(permissionMode) => onChange({ permissionMode })}
        />
      ) : (
        <SelectField
          label="Sandbox"
          value={worker.sandbox ?? "workspace-write"}
          options={WORKER_SANDBOXES}
          onChange={(sandbox) => onChange({ sandbox: sandbox as WorkerSandbox })}
        />
      )}
      <SelectField
        label="Approval bridge"
        value={worker.approvalBridge}
        options={WORKER_APPROVAL_BRIDGES}
        onChange={(approvalBridge) => onChange({ approvalBridge: approvalBridge as WorkerApprovalBridge })}
      />
      <NumberField
        label="Max concurrent"
        value={worker.maxConcurrent}
        min={1}
        max={8}
        onChange={(maxConcurrent) => onChange({ maxConcurrent })}
      />
      <NumberField
        label="Turn timeout (minutes)"
        value={Math.round(worker.turnTimeoutMs / 60_000)}
        min={1}
        max={60}
        onChange={(minutes) => onChange({ turnTimeoutMs: minutes * 60_000 })}
      />
      <TextField
        label="Extra directories"
        value={formatListInput(worker.extraDirs)}
        placeholder="/path/one, /path/two"
        hint="Beyond the project directory."
        onChange={(value) => onChange({ extraDirs: parseListInput(value) })}
      />
      <label className="settings-field">
        <span className="settings-field__label">Deny rules</span>
        <textarea
          rows={3}
          value={formatRuleLines(worker.denyRules)}
          onChange={(event) => onChange({ denyRules: parseRuleLines(event.target.value) })}
        />
        <small className="settings-hint">One rule per line.</small>
      </label>
    </div>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<WileySettings | null>(null);
  const [secretInput, setSecretInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The last state the host confirmed, so an incoming change can tell an
  // unsaved local edit from a field this panel has never touched.
  const savedRef = useRef<WileySettings | null>(null);

  const accept = useCallback((next: SettingsView, force = false) => {
    setView(next);
    const saved = savedRef.current;
    savedRef.current = settingsOf(next);
    setDraft((current) => {
      // An edit this panel has not saved yet survives someone else's change;
      // the result of our own action always wins, normalization included.
      if (!force && current && saved && hasDraftChanges(saved, current)) return current;
      return settingsOf(next);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void bridge.getSettings().then(
      (next) => {
        if (active && next) accept(next);
      },
      (loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      },
    );
    return () => {
      active = false;
    };
  }, [accept]);

  useEffect(() => bridge.onSettingsChanged(accept), [accept]);

  const dirty = useMemo(
    () => Boolean(view && draft && hasDraftChanges(settingsOf(view), draft)),
    [view, draft],
  );

  const run = useCallback(async (action: () => Promise<SettingsView | undefined>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (next) accept(next, true);
      setNotice(done);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }, [accept]);

  if (error && !draft) {
    return (
      <aside className="settings-panel" aria-label="Settings">
        <header className="settings-panel__header">
          <strong>Settings</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </header>
        <p className="settings-error" role="alert">{error}</p>
      </aside>
    );
  }

  if (!view || !draft) {
    return (
      <aside className="settings-panel" aria-label="Settings">
        <header className="settings-panel__header">
          <strong>Settings</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </header>
        <p className="settings-hint">Loading…</p>
      </aside>
    );
  }

  const patchAgent = (patch: Partial<WileySettings["agent"]>) =>
    setDraft({ ...draft, agent: { ...draft.agent, ...patch } });
  const patchVoice = (patch: Partial<WileySettings["voice"]>) =>
    setDraft({ ...draft, voice: { ...draft.voice, ...patch } });
  const patchAuth = (patch: Partial<WileySettings["auth"]>) =>
    setDraft({ ...draft, auth: { ...draft.auth, ...patch } });
  const patchWorker = (kind: WorkerKind, patch: Partial<WorkerSettings>) =>
    setDraft({ ...draft, workers: { ...draft.workers, [kind]: { ...draft.workers[kind], ...patch } } });

  const catalog = view.models.map((model) => model.id);
  const agentModels = modelChoices(catalog, [
    draft.agent.model,
    ...(draft.agent.subagentModel ? [draft.agent.subagentModel] : []),
    ...draft.agent.allowedModels,
  ]);
  const requiredModels = [draft.agent.model, draft.agent.subagentModel ?? draft.agent.model];
  const keyState = view.secrets.openaiApiKey;
  const cloudReady = draft.auth.relayBaseUrl.trim().length > 0;

  return (
    <aside className="settings-panel" aria-label="Settings">
      <header className="settings-panel__header">
        <strong>Settings</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
      </header>

      <section className="settings-section">
        <h2>Account</h2>
        <div className="settings-radio-row" role="radiogroup" aria-label="Account mode">
          {(["byok", "cloud"] as AuthMode[]).map((mode) => (
            <label key={mode} className="settings-radio">
              <input
                type="radio"
                name="auth-mode"
                value={mode}
                checked={draft.auth.mode === mode}
                disabled={mode === "cloud" && !cloudReady}
                onChange={() => patchAuth({ mode })}
              />
              <span>{mode === "byok" ? "Your own API key" : "Wiley cloud (coming soon)"}</span>
            </label>
          ))}
        </div>

        {draft.auth.mode === "byok" ? (
          <>
            <p className="settings-hint">
              {keyState.source === "env"
                ? `OPENAI_API_KEY from your environment is in use and overrides anything saved here${keyState.stored ? ", including the key you saved" : ""}.`
                : keyState.stored
                  ? `A key is saved (${keyState.backend === "safeStorage" ? "encrypted by the system keychain" : "local file"}).`
                  : "No key is saved yet."}
            </p>
            <label className="settings-field">
              <span className="settings-field__label">OpenAI API key</span>
              <input
                type="password"
                value={secretInput}
                placeholder={keyState.stored ? "••••••••  (saved)" : "sk-…"}
                autoComplete="off"
                onChange={(event) => setSecretInput(event.target.value)}
              />
            </label>
            <div className="settings-actions">
              <button
                type="button"
                className="status-button"
                disabled={busy || !secretInput.trim()}
                onClick={() => void run(async () => {
                  const next = await bridge.setSecret("openaiApiKey", secretInput.trim());
                  setSecretInput("");
                  return next;
                }, "API key saved")}
              >
                Save key
              </button>
              <button
                type="button"
                className="status-button"
                disabled={busy || !keyState.stored}
                onClick={() => void run(() => bridge.clearSecret("openaiApiKey"), "API key cleared")}
              >
                Clear key
              </button>
            </div>
          </>
        ) : (
          <p className="settings-hint">Account: {draft.auth.accountEmail ?? "not signed in"}</p>
        )}
        <TextField
          label="Relay base URL"
          value={draft.auth.relayBaseUrl}
          placeholder="https://relay.example.com"
          hint="Hosted accounts are not available yet; set this to unlock the option."
          onChange={(relayBaseUrl) => patchAuth({ relayBaseUrl })}
        />
      </section>

      <section className="settings-section">
        <h2>Voice</h2>
        <ModelPicker
          label="Realtime model"
          value={draft.voice.model}
          options={VOICE_MODEL_OPTIONS}
          hint="Applies the next time the microphone connects."
          onChange={(model) => patchVoice({ model })}
        />
        <ModelPicker
          label="Voice"
          value={draft.voice.voice}
          options={VOICE_NAME_OPTIONS}
          onChange={(voice) => patchVoice({ voice })}
        />
        <SelectField
          label="Reasoning effort"
          value={draft.voice.reasoningEffort}
          options={VOICE_REASONING_EFFORTS}
          onChange={(reasoningEffort) => patchVoice({ reasoningEffort: reasoningEffort as VoiceReasoningEffort })}
        />
        <TextField
          label="Transcription model"
          value={draft.voice.transcriptionModel}
          onChange={(transcriptionModel) => patchVoice({ transcriptionModel })}
        />
      </section>

      <section className="settings-section">
        <h2>Agent</h2>
        <ModelPicker
          label="Model"
          value={draft.agent.model}
          options={agentModels}
          onChange={(model) => patchAgent({
            model,
            allowedModels: toggleAllowedModel(draft.agent.allowedModels, model, true),
          })}
        />
        <ModelPicker
          label="Worker model"
          value={draft.agent.subagentModel ?? draft.agent.model}
          options={agentModels}
          hint="Background work runs on this model."
          onChange={(subagentModel) => patchAgent({
            subagentModel: subagentModel === draft.agent.model ? undefined : subagentModel,
            allowedModels: toggleAllowedModel(draft.agent.allowedModels, subagentModel, true),
          })}
        />
        <SelectField
          label="Thinking level"
          value={draft.agent.thinkingLevel}
          options={AGENT_THINKING_LEVELS}
          onChange={(thinkingLevel) => patchAgent({ thinkingLevel: thinkingLevel as AgentThinkingLevel })}
        />
        <Toggle
          label="Fast mode"
          checked={draft.agent.fastMode}
          hint="Runs the main session at low thinking for quicker replies, whatever the level above says."
          onChange={(fastMode) => patchAgent({ fastMode })}
        />
        <Toggle
          label="Review risky actions with a second model"
          checked={draft.agent.approvalEnabled}
          onChange={(approvalEnabled) => patchAgent({ approvalEnabled })}
        />
        <ModelPicker
          label="Reviewer model"
          value={draft.agent.approvalModel}
          options={agentModels}
          onChange={(approvalModel) => patchAgent({ approvalModel })}
        />
        <fieldset className="settings-fieldset">
          <legend>Models background work may use</legend>
          {agentModels.map((model) => (
            <Toggle
              key={model}
              label={model}
              checked={draft.agent.allowedModels.includes(model)}
              disabled={requiredModels.includes(model)}
              onChange={(enabled) => patchAgent({
                allowedModels: toggleAllowedModel(draft.agent.allowedModels, model, enabled, requiredModels),
              })}
            />
          ))}
        </fieldset>
      </section>

      <section className="settings-section">
        <h2>Workers</h2>
        <div className="settings-actions">
          <button
            type="button"
            className="status-button"
            disabled={busy}
            onClick={() => void run(async () => {
              await bridge.probeWorkers();
              return bridge.getSettings();
            }, "Checked for worker CLIs")}
          >
            Check again
          </button>
        </div>
        {WORKER_KINDS.map((kind) => (
          <WorkerCard
            key={kind}
            kind={kind}
            worker={draft.workers[kind]}
            probe={view.probes[kind]}
            onChange={(patch) => patchWorker(kind, patch)}
          />
        ))}
      </section>

      <footer className="settings-panel__footer">
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        {notice && !error ? <p className="settings-hint" role="status">{notice}</p> : null}
        <div className="settings-actions">
          <button
            type="button"
            className="status-button"
            disabled={busy || !dirty}
            onClick={() => setDraft(settingsOf(view))}
          >
            Discard
          </button>
          <button
            type="button"
            className="status-button settings-save"
            disabled={busy || !dirty}
            onClick={() => void run(
              () => bridge.updateSettings(settingsDraftPatch(settingsOf(view), draft)),
              "Settings saved",
            )}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </footer>
    </aside>
  );
}
