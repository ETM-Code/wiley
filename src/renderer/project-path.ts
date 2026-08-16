import type { ProjectEntry } from "./bridge";

/**
 * Enough of the path to tell two folders of the same name apart. Trimming the
 * front rather than the end is the whole point: every deep path shares its
 * first few segments, so an end-trimmed list is a column of identical strings.
 * The full path stays on the title attribute.
 */
export function shortPath(value: string, maxLength = 52): string {
  if (value.length <= maxLength) return value;
  const tail: string[] = [];
  for (const segment of value.split("/").filter(Boolean).reverse()) {
    if (tail.length && [...tail, segment].join("/").length + 2 > maxLength) break;
    tail.unshift(segment);
  }
  return `…/${tail.join("/")}`;
}

/** Nothing at all rather than a fake date for a folder never opened here. */
export function openedLabel(entry: Pick<ProjectEntry, "lastOpenedAt">): string | undefined {
  const at = new Date(entry.lastOpenedAt);
  if (Number.isNaN(at.getTime()) || at.getTime() === 0) return undefined;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
