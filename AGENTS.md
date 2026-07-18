# Board AI agent instructions

This repository implements Wiley, a single voice persona backed by a root Pi orchestrator and Pi subagents.

- All Pi sessions use `gpt-5.6-luna` with medium thinking.
- The Realtime voice session is a conversational frontend only. It cannot mutate the board, filesystem, shell, git, or subagents.
- Every user task and edit flows through the root orchestrator.
- Every Pi session receives the canonical voice transcript and may read subsequent conversation deltas.
- Use the `live-excalidraw` skill and board tools for canvas work; never mutate renderer state directly.
- Deliver user changes interrupt-first. After an interruption, verify the state of any command, file edit, or board transaction that may have partially completed.
- The human experiences one persona. User-facing progress is first-person Wiley language and never mentions agents, subagents, engines, or layers.
- Ordinary actions are automatic. Always block catastrophic deletion of the home directory, root, system directories, mounted-volume roots, disks, boot configuration, or credential stores.
