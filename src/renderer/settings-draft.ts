import type { SettingsPatch, SettingsView, WileySettings } from "./bridge";

/**
 * Pure helpers behind the settings panel. The panel edits a local draft and
 * saves the difference, so a field someone else changed while the panel was
 * open is not clobbered by a full-object write.
 */

/** Drops the read-only decorations the host adds, leaving editable settings. */
export function settingsOf(view: SettingsView): WileySettings {
  const settings = structuredClone(view) as Partial<SettingsView>;
  delete settings.secrets;
  delete settings.models;
  delete settings.probes;
  return settings as WileySettings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diff(base: unknown, draft: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(draft)) {
    const patch: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      const before = base[key];
      const after = draft[key];
      if (after === undefined) {
        // The field was cleared in the draft; null tells the host to reset it.
        if (before !== undefined) patch[key] = null;
        continue;
      }
      const nested = diff(before, after);
      if (nested !== undefined) patch[key] = nested;
    }
    return Object.keys(patch).length ? patch : undefined;
  }
  if (Array.isArray(base) && Array.isArray(draft)) {
    return JSON.stringify(base) === JSON.stringify(draft) ? undefined : draft;
  }
  return base === draft ? undefined : draft;
}

/** The smallest patch that turns `base` into `draft`; empty when they match. */
export function settingsDraftPatch(base: WileySettings, draft: WileySettings): SettingsPatch {
  return (diff(base, draft) ?? {}) as SettingsPatch;
}

export function hasDraftChanges(base: WileySettings, draft: WileySettings): boolean {
  return Object.keys(settingsDraftPatch(base, draft)).length > 0;
}

/** One rule per line, so the textarea reads the way the rules are written. */
export function parseRuleLines(text: string): string[] {
  return [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];
}

export function formatRuleLines(rules: readonly string[]): string {
  return rules.join("\n");
}

/** Comma or newline separated, because both are natural for a path list. */
export function parseListInput(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
}

export function formatListInput(values: readonly string[]): string {
  return values.join(", ");
}

/**
 * Keeps the allowlist a set, and never lets the model the agent is configured
 * to use drop off it, which would fail every spawn.
 */
export function toggleAllowedModel(
  allowed: readonly string[],
  model: string,
  enabled: boolean,
  required: readonly string[] = [],
): string[] {
  if (!enabled && required.includes(model)) return [...allowed];
  const next = allowed.filter((entry) => entry !== model);
  if (enabled) next.push(model);
  return next.length ? next : [...allowed];
}

/** The union of what the host offers and what the user already configured. */
export function modelChoices(catalog: readonly string[], configured: readonly string[]): string[] {
  return [...new Set([...catalog, ...configured])].sort((a, b) => a.localeCompare(b));
}
