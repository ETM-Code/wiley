import type { BoardSnapshot } from "../../shared/contracts";
import { readDiagramStamp } from "../../shared/diagram-stamp";

/** Above this the board context carries a sample plus a truncation flag. */
const BOARD_CONTEXT_ELEMENT_LIMIT = 100;

export type BoardDiagram = {
  id: string;
  title?: string;
  nodeKeys: string[];
  elementCount: number;
};

/**
 * One line per agent-drawn diagram already on the board. The agent can name
 * an existing diagram, or avoid redrawing one, without spending a tool call
 * reading the canvas.
 */
export function boardDiagrams(board: BoardSnapshot): BoardDiagram[] {
  const byId = new Map<string, BoardDiagram>();
  for (const element of board.elements) {
    const stamp = readDiagramStamp(element);
    if (!stamp) continue;
    const entry = byId.get(stamp.diagram) ?? { id: stamp.diagram, nodeKeys: [], elementCount: 0 };
    entry.elementCount += 1;
    if (stamp.role === "node" && stamp.key) entry.nodeKeys.push(stamp.key);
    if (stamp.role === "title" && typeof element.text === "string") entry.title = element.text;
    byId.set(stamp.diagram, entry);
  }
  return [...byId.values()];
}

export function formatDiagramListing(diagrams: readonly BoardDiagram[]): string {
  if (diagrams.length === 0) return "(none)";
  return diagrams.map((diagram) => {
    const name = diagram.title ? JSON.stringify(diagram.title) : "(untitled)";
    return `${diagram.id} ${name} nodes=[${diagram.nodeKeys.join(", ")}] elements=${diagram.elementCount}`;
  }).join("\n");
}

export function buildBoardContext(board: BoardSnapshot) {
  return {
    revision: board.revision,
    elementCount: board.elements.length,
    viewport: board.appState,
    elements: board.elements.slice(0, BOARD_CONTEXT_ELEMENT_LIMIT).map((element) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      text: element.text,
    })),
    diagrams: boardDiagrams(board),
    truncated: board.elements.length > BOARD_CONTEXT_ELEMENT_LIMIT,
  };
}

export function buildTaskMessage(input: {
  task: string;
  userWords: string;
  transcriptEntries: unknown;
  board: BoardSnapshot;
}): string {
  return [
    input.task,
    "",
    `User's words, verbatim: ${JSON.stringify(input.userWords)}`,
    "",
    "<voice_conversation_context>",
    JSON.stringify(input.transcriptEntries),
    "</voice_conversation_context>",
    "",
    "<current_canvas_context>",
    JSON.stringify(buildBoardContext(input.board)),
    "<diagrams>",
    formatDiagramListing(boardDiagrams(input.board)),
    "</diagrams>",
    "</current_canvas_context>",
  ].join("\n");
}

export function buildSubagentMessage(input: {
  task: string;
  transcriptContext: unknown;
  peerEvents: unknown;
}): string {
  return [
    input.task,
    "",
    "<voice_conversation_context>",
    JSON.stringify(input.transcriptContext),
    "</voice_conversation_context>",
    "",
    "<peer_agent_events>",
    JSON.stringify(input.peerEvents),
    "</peer_agent_events>",
  ].join("\n");
}
