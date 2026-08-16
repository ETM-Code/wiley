# Wiley agent instructions

This repository implements Wiley, a single voice persona backed by a root Pi orchestrator and Pi subagents.

- Pi sessions run on the model and thinking level in Settings, defaulting to `gpt-5.6-luna` at medium thinking. Agent-side models are restricted to the `gpt-5.6` family by `isAllowedBackendModel` in `src/main/settings/settings-schema.ts`, which is the single knob for the catalog, the allowlist, the approval judge, the relay registration, and the spawn guard. Realtime voice models and the claude/codex worker CLIs are outside that rule. Fast mode, on by default, runs the root session at low thinking. Settings live in `settings.json` under the app's config directory (`WILEY_CONFIG_DIR`, else Electron's userData or `~/.wiley`); secrets live beside it in `secrets.json` and never reach the renderer.
- The Realtime voice session is a conversational frontend only. It cannot mutate the board, filesystem, shell, git, or subagents.
- Every user task and edit flows through the root orchestrator.
- Every Pi session receives the canonical voice transcript and may read subsequent conversation deltas.
- Use the `live-excalidraw` skill and board tools for canvas work; never mutate renderer state directly.
- Deliver user changes interrupt-first. After an interruption, verify the state of any command, file edit, or board transaction that may have partially completed.
- The human experiences one persona. User-facing progress is first-person Wiley language and never mentions agents, subagents, engines, or layers.
- Ordinary actions are automatic. Always block catastrophic deletion of the home directory, root, system directories, mounted-volume roots, disks, boot configuration, or credential stores.
