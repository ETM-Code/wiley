---
name: live-excalidraw
description: Inspect, understand, and safely edit the live Excalidraw board through the board tools.
---

# Live Excalidraw

Use this skill whenever a task involves the whiteboard. The canvas is shared with the human and other agents, so treat every read as a snapshot and every write as a small transaction.

The block below is generated from `src/main/board-protocol.ts` by `npm run sync:skill`, which is where the agent prompts get the same text. Edit it there, not here.

<!-- BEGIN board-protocol -->

Board protocol:
- The complete live-excalidraw skill is incorporated into this protocol and is
  already loaded. Follow it directly; never spend a tool call reading the
  live-excalidraw skill file.
- Each task includes current_canvas_context. Treat it as the initial canvas read.
- For one centered rectangle, ellipse, or diamond, call draw_shape immediately
  as your first action. Do not call get_canvas, tell_user, screenshot_canvas, or
  spawn_agent before it.
- A successful draw_shape or draw_diagram result is authoritative and durably
  persisted; do not re-read or screenshot the board to verify it unless the tool
  reports an error or the user explicitly asks for a visual critique.
- get_canvas before drawing or editing; screenshot_canvas when visual layout matters.
- If the user says "that", "this", or "what's this" after circling/pointing, use humanGraph.encloses; screenshot_canvas only for visual judgment, never ask "where" first.
- draw_diagram for graph structure; never calculate structured layout coordinates.
- Wiley canvas mutations automatically snap shape geometry to a hidden 20 px
  grid, while connector routes keep their exact computed geometry. Do not
  calculate, simulate, or compensate for the grid. Human movement remains
  freeform and the editor grid stays hidden.
- draw_on_canvas for annotations; edit_canvas for minimal patches.
- Every agent can use the board, but human edits win conflicts.
- Draw by default. If the topic has any structure (a system, a flow, a plan,
  a comparison, a sequence), put it on the board while you talk instead of
  only describing it. A reply with no board change is the exception, kept for
  something too small or personal to draw, not the everyday case.
- For other simple edits, use the supplied context, mutate once, and finish.
  Read again only if the supplied context is insufficient or a conflict occurs.

Diagram decisions:
- draw_diagram creates, update_diagram evolves. Never redraw a diagram you
  own; current_canvas_context lists your diagrams by diagramId.
- merge is the default update mode and keeps everything you leave out, but
  layout is not reconstructed from the board, so re-pass it every time.
- Group real subsystems with containers and name the container id on each node
  inside one. Two levels at most, frames top level only, and never hand-draw a
  box around boxes.
- Pick one layout and let it work: layered RIGHT for pipelines, layered DOWN
  for decision flows, tree for org charts and mind maps, radial for
  hub-and-spoke. Containers force layered.
- Connect to the user's sketch through the element ids in humanGraph rather
  than drawing your own copy beside it, and tidy it only when they ask.
- One theme per board, one node per real component, and no duplicate or
  alternate-view nodes. Give nodes roles instead of invented hex colours and
  let colour group things: a fill is a category, so one kind takes one role
  and most nodes stay neutral. About one fill per two nodes and eight at the
  very most; connector labels stay one or two words.

Connector protocol:
- Every arrow that connects two nodes must attach to the visible perimeter of
  each node. The line must stop at the box edge and must never terminate in,
  originate in, or travel through the center or label area of a node.
- For structured graphs, use draw_diagram and supply only node and edge
  relationships; its layout binds connectors to node edges automatically.
- To link elements that already exist on the board, including the user's own
  drawings, always use connect_shapes with their element ids. It computes the
  attachment points, keeps the arrow bound when shapes move, and supports
  bidirectional arrows. Never hand-place connector coordinates for existing
  elements.
- If draw_on_canvas is necessary for an annotation arrow, it must include
  valid start and end element bindings. Do not approximate endpoints with
  coordinates aimed at node centers. Keep arrow labels clear of boxes and
  other labels.
- When the user asks for a two-way relationship, use one bidirectional arrow,
  not two arrows and not a single one-way arrow.

The user's drawings are first-class:
- The user's hand-drawn elements are yours to work with, never to discard.
  Move, resize, recolor, relabel, or connect them with edit_canvas and
  connect_shapes exactly as if you had drawn them.
- Requests to fill in, connect, finish, extend, tidy, or annotate the board
  mean building on what is already there. Read the canvas, reference the
  existing ids, and add or adjust only what the request needs.
- Call clear_canvas only when the user's verbatim words explicitly ask to
  wipe or replace the whole board (clear it, erase everything, start over).
  If the words are ambiguous about destroying their drawings, keep the
  drawings and ask.
- To change the text of a labelled shape, patch text on the shape id via
  edit_canvas; the bound label updates and re-measures automatically.
- When drawing something additional, place it in clear space relative to the
  existing content: pass anchor plus anchorDirection (draw_diagram) or
  placeNear plus placeDirection (draw_on_canvas) to grow the board right,
  left, above, or below. Never draw new content on top of what is there.

Work like a coworker at the whiteboard, not a remote contractor:
- Narrate as you go with tell_user, in first person, one short sentence at a
  time. Narrate at minimum: when you start reading or running something, when
  you switch from investigating to drawing (say what you learned first), and
  each time you extend or correct the drawing. During stretches with no
  visible board change, narration is the only sign of life the user gets, so
  provide it. A task longer than half a minute with a single narration is a
  failure of presence.
- For board tasks, alternate looking and drawing. Put a first rough version
  on the board as soon as you know the core pieces, then extend and refine
  it as you learn more: add nodes, connect them, relabel. Never disappear
  into a long silent research phase and reveal one finished artifact.
- When something you drew turns out to be wrong or superseded, you must
  erase or correct it on the board with edit_canvas (delete the stale
  elements or patch them) the moment you know. Stale drawings are worse than
  no drawings; the user should watch the picture converge on the truth.
- When a diagram or visual deliverable is finished, end with a spoken
  walkthrough: two to four first-person sentences that talk the user through
  what is on the board, reading it left to right or top to bottom. This
  walkthrough is your final response for board deliverables. For non-board
  work, keep the final response to one short sentence.

<!-- END board-protocol -->

## Beyond the shared protocol

- Use `place_image` to drop a rendered screenshot or other image file onto the board next to related content.
- Re-read affected elements after a conflict or interruption. An aborted operation may already have landed.
- Prefer small coherent edits that can be individually undone, and work on the element ids or region assigned to you.
- Do not mutate raw React state or fabricate Excalidraw internals. Use the board tools only.
- Never delete or replace elements unrelated to the request.
- Use boxes for steps or services, diamonds for decisions, and ellipses for starts, ends, or actors.

## Hand-drawn wireframes

When the user sketches a layout (boxes for sections of a page or app):

1. `screenshot_canvas` to see the sketch spatially, plus `get_canvas` for the exact ids and bounding boxes.
2. Infer each box's role from its position and size (top strip = header or hero, wide middle = content, small repeated boxes = cards, bottom strip = footer).
3. Fill in labels on THEIR elements with `edit_canvas` (patch `text` on each shape id); do not redraw their boxes.
4. If they then want the thing built, treat their sketch as the specification and keep the board sketch intact as the reference.
