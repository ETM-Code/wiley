import { describe, expect, it, vi } from "vitest";

import { observeColorScheme, resolveColorScheme, type SchemeMatcher } from "../src/renderer/color-scheme";

function matcher(matches: boolean): SchemeMatcher & { listeners: Set<() => void> } {
  const listeners = new Set<() => void>();
  return {
    matches,
    listeners,
    addEventListener: (_type: "change", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: () => void) => {
      listeners.delete(listener);
    },
  };
}

describe("resolveColorScheme", () => {
  it("reads dark from a matching query", () => {
    expect(resolveColorScheme(matcher(true))).toBe("dark");
  });

  it("reads light from a query that does not match", () => {
    expect(resolveColorScheme(matcher(false))).toBe("light");
  });

  it("falls back to light where the query is unavailable", () => {
    expect(resolveColorScheme(null)).toBe("light");
    expect(resolveColorScheme(undefined)).toBe("light");
  });
});

describe("observeColorScheme", () => {
  it("notifies on change and detaches on unsubscribe", () => {
    const query = matcher(false);
    const onChange = vi.fn();

    const unsubscribe = observeColorScheme(query, onChange);
    expect(query.listeners.size).toBe(1);
    for (const listener of query.listeners) listener();
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(query.listeners.size).toBe(0);
  });

  it("is a no-op without a query, and its unsubscribe stays safe to call", () => {
    expect(() => observeColorScheme(null, vi.fn())()).not.toThrow();
  });
});
