# Wiley

Wiley is a local macOS Electron app that combines a stock Excalidraw editor with a full-duplex voice frontend and a persistent Pi coding-agent harness.

- `gpt-realtime-2.1` listens, speaks, interrupts its own audio when the user talks, and can only call read/status and orchestrator-dispatch tools.
- The persistent root Pi session runs `gpt-5.6-luna` with medium reasoning and owns every board, code, shell, filesystem, git, and subagent action.
- Up to four Pi subagents use the same Luna-medium configuration, receive the full canonical conversation, publish observable work to the shared ledger, and edit the board through the same transaction gateway.
- One subagent session stays prewarmed for low dispatch latency.

## Run locally

Requirements: macOS Apple Silicon, Node 22.19 or newer, and an OpenAI API key with access to both configured models.

```bash
cp .env.example .env
npm install
npm run dev:web
```

Open `http://localhost:5173`. Use `npm run dev` instead when testing the Electron shell.

Set `OPENAI_API_KEY` in `.env` or the shell that starts Wiley. Vite does not expose it to the renderer; the local backend only returns a short-lived Realtime client secret. Pi can also use credentials already configured in `~/.pi/agent/auth.json`.

Optional settings:

- `BOARD_AI_PROJECT_DIR`: workspace the Pi coding tools may edit. Defaults to the directory used to launch the app.
- `BOARD_AI_DATA_DIR`: directory for the SQLite WAL ledger. Defaults to Electron's application-data directory.
- `VOICE_DISABLED=1`: keeps Realtime offline and displays a temporary text input for local harness testing.

The only persistent voice control is the microphone button in the bottom-right. Muting disables capture only; playback and background work continue.

Optional safety settings:

- `WILEY_APPROVAL_MODEL`: cheap reviewer model for risky bash/edit/write calls (default `gpt-5.4-mini`).
- `WILEY_APPROVAL_DISABLED=1`: turns the approval reviewer off; the hard catastrophic-command guard always stays on.

## Verify and package

```bash
npm run typecheck
npm test
npm run build
npm run package:mac
```

### Full scenario run (real model, costs tokens)

```bash
npm run test:e2e:landing
```

Drives the whole loop against the live Pi model and a real browser canvas: architecture diagram, simulated hand-drawn wireframe, label fill-in on the human's boxes, website generation, screenshot placed on the board, and a real `open` of the built page. Artifacts (logs, board JSON, screenshots) land in `.e2e/run-*/`; render any run's persisted board with `node scripts/board-shot.mjs <run>/data out.png`.

The unsigned Apple Silicon DMG is written to `release/`. Signing and notarization require the developer's Apple credentials.

## Runtime boundaries

The renderer is sandboxed and has no Node access. It owns WebRTC audio and Excalidraw rendering. The Electron main process owns credentials, the SQLite ledger, Pi sessions, job interruption, safety guards, and the serialized board transaction gateway. The Realtime capability manifest intentionally contains no mutation, shell, filesystem, git, or subagent-spawn tool.

Implementation details and the deterministic/real-model test matrix are in [docs/pi-harness-guide.md](docs/pi-harness-guide.md) and [docs/agent-test-procedure.md](docs/agent-test-procedure.md).
