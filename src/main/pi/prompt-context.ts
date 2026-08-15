import type { BoardSnapshot } from "../../shared/contracts";

/** Above this the board context carries a sample plus a truncation flag. */
const BOARD_CONTEXT_ELEMENT_LIMIT = 100;

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
