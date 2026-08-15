/**
 * Strips credential-shaped values before anything reaches the durable event
 * ledger or the renderer sidebar, then caps the payload so one enormous tool
 * result cannot swamp the feed.
 */
export function redact(value: unknown): unknown {
  const text = JSON.stringify(value, (key, item) =>
    /(?:api[_-]?key|authorization|token|secret|password|cookie)/i.test(key) ? "[REDACTED]" : item,
  ) ?? String(value);
  if (text.length > 100_000) return `${text.slice(0, 100_000)}…[truncated]`;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
