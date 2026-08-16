/**
 * What the root agent is allowed to do with the user's settings.
 *
 * Both operations go through the same SettingsService the panel uses, so a
 * change the agent makes normalizes, persists, and broadcasts exactly like one
 * the user typed. Kept out of the runtime so it can be exercised against a
 * real store in a temp directory, with no session and no voice connection.
 */

import type { SettingsView } from "../../shared/contracts";
import { changedSettingsPaths, type SettingsPatch } from "../settings/settings-schema";
import { assertNoSecretPaths, type SettingsService } from "../settings/settings-service";

export interface SettingsToolDeps {
  service: SettingsService;
  /** One short sentence in Wiley's own voice, spoken after a real change. */
  announce: (message: string) => void;
}

/**
 * The panel's own view. Its secrets block is metadata already; rebuilding it
 * field by field keeps it that way if the shape ever grows a value.
 */
export async function readAgentSettings(service: SettingsService): Promise<SettingsView> {
  const view = await service.view();
  const key = view.secrets.openaiApiKey;
  return {
    ...view,
    secrets: {
      openaiApiKey: {
        present: key.present,
        source: key.source,
        stored: key.stored,
        backend: key.backend,
      },
    },
  };
}

/**
 * Applies a patch and answers with what actually changed, which can be less
 * than was asked for: normalization clamps ranges and drops values it does not
 * recognise, and saying so is what keeps a silent no-op from reading as done.
 */
export async function updateAgentSettings(
  deps: SettingsToolDeps,
  patch: unknown,
  summary?: string,
): Promise<string[]> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("A settings patch must be an object of the fields to change.");
  }
  assertNoSecretPaths(patch);
  const before = deps.service.settings;
  await deps.service.update(patch as SettingsPatch);
  const changed = changedSettingsPaths(before, deps.service.settings);
  if (changed.length) deps.announce(summary?.trim() || `Updated ${changed.join(", ")}.`);
  return changed;
}
