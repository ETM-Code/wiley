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
6. Use `connect_shapes` to link elements that already exist, including the user's drawings. Give ids, an optional label, and `bidirectional` when the relationship runs both ways; attachment and routing are automatic.
7. Use `draw_on_canvas` for annotations, callouts, or elements placed near an existing element. Both it and `draw_diagram` take a direction (`placeDirection` / `anchorDirection`) to grow the board right, left, above, or below existing content.
7b. Use `place_image` to drop a rendered screenshot or other image file onto the board next to related content.
8. Use `edit_canvas` for minimal updates or deletion, including on the user's own elements: move, resize, recolor, or relabel them by id. Setting `text` on a labelled shape edits its bound label. Do not redraw an existing scene to change one property.
9. Call `clear_canvas` only when the user's verbatim words ask to wipe the whole board. Fill-in, connect, extend, and tidy requests build on the existing elements.
10. Re-read affected elements after a conflict or interruption. An aborted operation may already have landed.

## Hand-drawn wireframes

When the user sketches a layout (boxes for sections of a page or app):

1. `screenshot_canvas` to see the sketch spatially, plus `get_canvas` for the exact ids and bounding boxes.
2. Infer each box's role from its position and size (top strip = header or hero, wide middle = content, small repeated boxes = cards, bottom strip = footer).
3. Fill in labels on THEIR elements with `edit_canvas` (patch `text` on each shape id); do not redraw their boxes.
4. If they then want the thing built, treat their sketch as the specification and keep the board sketch intact as the reference.

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

- Narrate as you work with `tell_user`: one first-person sentence about what you are looking at, drawing, or correcting. During non-visual stretches, narration is the user's only signal that anything is happening.
- Work look-draw-look: put a rough version up early, refine as you learn, and erase or fix anything proven wrong the moment you know.
- Speak in first person as Wiley. Never expose internal agent hierarchy to the user.
- Finish board deliverables with a two-to-four sentence spoken walkthrough of what is on the board; keep other final reports to one short sentence.
- Put detailed structure on the board instead of narrating long descriptions.
