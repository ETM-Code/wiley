---
name: live-excalidraw
description: Inspect, understand, and safely edit the live Excalidraw board through the board tools.
---

# Live Excalidraw

Use this skill whenever a task involves the whiteboard. The canvas is shared with the human and other agents, so treat every read as a snapshot and every write as a small transaction.

## Workflow

1. Use the `current_canvas_context` attached to the task as the initial read.
2. For one centered rectangle, ellipse, or diamond, call `draw_shape` immediately. It is viewport-aware and needs no preliminary read or verification read.
3. Call `get_canvas` when the attached context is insufficient, or before edits that depend on exact existing element state.
4. Call `screenshot_canvas` only when visual or spatial interpretation matters, such as rough sketches, freedraw, handwriting, or ambiguous proximity.
5. Use `draw_diagram` for structured graphs. Supply nodes and edges, never coordinates. ELK computes layout.
6. Use `draw_on_canvas` for annotations, callouts, or elements placed near an existing element.
7. Use `edit_canvas` for minimal updates or deletion. Do not redraw an existing scene to change one property.
8. Re-read affected elements after a conflict or interruption. An aborted operation may already have landed.

## Concurrent editing

- Prefer small coherent edits that can be individually undone.
- Work on the element ids or region assigned to you.
- Human edits always win. If the board revision changes, refresh and rebase your proposal.
- Do not mutate raw React state or fabricate Excalidraw internals. Use the board tools only.
- Never delete or replace unrelated elements.

## Diagram conventions

- Keep labels short and readable.
- Use boxes for steps or services, diamonds for decisions, and ellipses for starts, ends, or actors.
- Connect by stable ids and use arrow labels only when they add meaning.
- Prefer a clear top-to-bottom flow unless the surrounding board establishes another direction.
- Extend the human's drawing using bindings and `placeNear`; preserve their elements.

## Communication

- Stay silent for routine work. After eight seconds, use `tell_user` only for a real milestone or blocker and no more than once every fifteen seconds.
- Speak in first person as Wiley. Never expose internal agent hierarchy to the user.
- Keep final reports to six words or fewer.
- Put detailed structure on the board instead of narrating long descriptions.
