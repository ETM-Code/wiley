/**
 * The gate every external worker spawn passes through, and the envelope the
 * worker is handed once it does.
 *
 * Pure: the checks are settings and probe reads, so a refusal can be phrased,
 * tested, and read back to the user without anything being launched.
 */

import type { WorkerProbes } from "../../shared/contracts";
import { assertSpawnModelAllowed } from "../pi/session-models";
import type { WileySettings } from "../settings/settings-schema";
import type { CliWorkerKind, WorkerKind } from "./worker-types";
import { isCliWorkerKind } from "./worker-types";

/**
 * What a worker runs on. Unset means unset: no model flag reaches the CLI, so
 * the run lands on whatever the user configured that engine to default to.
 */
export function resolveWorkerModel(
  kind: CliWorkerKind,
  settings: WileySettings,
  requested?: string,
): string | undefined {
  return requested ?? settings.workers[kind].model;
}

export interface WorkerSpawnRequest {
  kind: WorkerKind;
  settings: WileySettings;
  probes?: WorkerProbes;
  model?: string;
}

/**
 * Refuses a spawn in language the root agent can read straight back to the
 * user: what is wrong, and the one thing that would fix it.
 */
export function assertWorkerSpawnAllowed(request: WorkerSpawnRequest): void {
  const { kind, settings, probes } = request;
  if (!isCliWorkerKind(kind)) throw new Error(`Unknown worker kind: ${String(kind)}`);
  if (!settings.workers[kind].enabled) {
    throw new Error(
      `${kind} workers are switched off in Settings. Use a pi worker instead, or ask the user to turn `
      + `${kind} on under Settings → Workers.`,
    );
  }
  const probe = probes?.[kind];
  if (probe && !probe.available) {
    throw new Error(`A ${kind} worker cannot start on this machine: ${probe.reason ?? "it is unavailable."}`);
  }
  // Kind-aware by design: this is a no-op for an external engine, whose model
  // names belong to the user's CLI rather than to the agent provider's catalog.
  const model = resolveWorkerModel(kind, settings, request.model);
  if (model) assertSpawnModelAllowed(settings, model, kind);
}
