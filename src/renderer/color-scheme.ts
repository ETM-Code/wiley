/**
 * The system light/dark appearance, read from `prefers-color-scheme`.
 *
 * The stylesheet follows that query on its own; this module exists for the
 * one place CSS cannot reach, which is Excalidraw's `theme` prop. There is no
 * in-app override, so the whole shell has exactly one source of truth.
 */

import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** The part of MediaQueryList this module uses, so the logic is testable without a DOM. */
export type SchemeMatcher = {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

/** Light is the fallback wherever the query is unavailable, matching CSS's own default. */
export function resolveColorScheme(matcher: SchemeMatcher | null | undefined): ColorScheme {
  return matcher?.matches ? "dark" : "light";
}

/** Subscribes to appearance changes and returns the unsubscribe. */
export function observeColorScheme(
  matcher: SchemeMatcher | null | undefined,
  onChange: () => void,
): () => void {
  if (!matcher) return () => undefined;
  matcher.addEventListener("change", onChange);
  return () => matcher.removeEventListener("change", onChange);
}

let cachedMatcher: SchemeMatcher | null | undefined;

function systemMatcher(): SchemeMatcher | null {
  if (cachedMatcher === undefined) {
    cachedMatcher = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DARK_SCHEME_QUERY)
      : null;
  }
  return cachedMatcher;
}

const subscribe = (onStoreChange: () => void) => observeColorScheme(systemMatcher(), onStoreChange);
const getSnapshot = (): ColorScheme => resolveColorScheme(systemMatcher());
const getLightSnapshot = (): ColorScheme => "light";

/** Re-renders whenever the system appearance changes. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, getSnapshot, getLightSnapshot);
}
