# Contributing

## Prerequisites

- Node 24 or newer. The ledger uses `node:sqlite`, which is only unflagged from 23.4 onwards.
- macOS Apple Silicon for the Electron shell and packaging. The browser shell (`npm run dev:web`) runs anywhere Node does.
- An OpenAI API key only if you want to run the app. The unit suite needs no key and spends no tokens.

```bash
npm install
cp .env.example .env
```

## Verify before you push

```bash
npm run typecheck
npm test
npm run lint
```

All three have to be green, and they are the same three CI runs on every pull request. CI then runs `npm run build` on macOS behind them, so a change that only breaks the Electron build still fails the PR even though the three commands above pass locally. Tests stay green: if a change makes a test wrong, fix the test in the same commit and say why in the message. Do not skip, `.only`, or delete a failing test to get a branch moving.

The end-to-end scenarios (`npm run test:e2e:landing`, `test:e2e:interactive`, `test:e2e:worker`) drive the real models and a real browser. They cost tokens, they are slow, and they are **not** required for a pull request. Run them when you touch the voice loop, the job pipeline, or the worker handoff, and paste what you saw.

## Where things live

`src/shared/` holds the contracts both processes agree on, so a change there usually means a change on both sides of the wire. The main process owns everything with real power: `src/main/pi/` is the orchestrator session, its tools, and the safety extension; `src/main/workers/` drives the Claude Code and Codex CLIs as code-only workers, including their safety tiers and the terminal handoff; `src/main/settings/` is the settings schema, store, model catalog, and the secret store; `src/main/cloud/` is the optional relay client. `src/server/` is the browser shell's backend, the non-Electron counterpart to `src/main/index.ts`, and `src/preload/` is the IPC surface between the two worlds. The renderer is presentation and geometry only: `src/renderer/canvas/` is scene patching, human-sketch merging, and export, while the `src/renderer/diagram-*` modules are the spec, ELK layout, routing, theming, diffing, and the quality evaluator.

## Style

Formatting is the autoformatter's job, not yours and not review's. Run `npm run lint:fix` and move on. The ESLint config is deliberately correctness-only: unused values, floating promises, unsafe `any` flow, and the rules that catch real bugs. If a rule is arguing about taste rather than correctness, it should not be in the config, so open an issue instead of adding an inline disable.

Keep commit messages about what changed and why. No generated attribution lines.
