/**
 * OpenAI error bodies are {error:{message,...}} JSON. Pull the human message
 * out so a failed /v1/realtime/calls request (e.g. an unknown model id) shows
 * up as a readable toast instead of a bare status code or a raw JSON dump.
 */
export function extractRealtimeErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}
