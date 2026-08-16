/**
 * Every environment variable Wiley reads is WILEY_<NAME>.
 *
 * The app shipped as board-ai first, so BOARD_AI_<NAME> still answers when the
 * current name is unset, with one warning per variable per process naming the
 * replacement. That fallback is a courtesy to shells and scripts that predate
 * the rename, not a second supported spelling, and it goes away next release.
 */

const warned = new Set<string>();

export function env(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = source[`WILEY_${name}`];
  if (current !== undefined) return current;
  const legacy = source[`BOARD_AI_${name}`];
  if (legacy === undefined) return undefined;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`BOARD_AI_${name} is deprecated: rename it to WILEY_${name}.`);
  }
  return legacy;
}

/** Test seam, because "warn once" is per process and tests run many. */
export function resetEnvWarnings(): void {
  warned.clear();
}
