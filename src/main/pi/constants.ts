export const PI_PROVIDER = "openai" as const;
export const PI_MODEL = "gpt-5.6-luna" as const;
export const PI_THINKING_LEVEL = "medium" as const;
/**
 * Cheapest model in the allowed family, which is the whole basis for the
 * choice: the judge reads one tool call and answers in a sentence. Kept in
 * step with DEFAULT_APPROVAL_MODEL_ID in the settings schema.
 */
export const DEFAULT_APPROVAL_MODEL = "gpt-5.6-luna" as const;
/** The judge is a gate, not a thinker: the family's floor is enough. */
export const APPROVAL_REASONING_EFFORT = "low" as const;
export const MAX_ACTIVE_SUBAGENTS = 4;
export const JUDGED_TOOLS = new Set(["bash", "edit", "write"]);
