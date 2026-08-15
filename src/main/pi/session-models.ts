import {
  effectiveThinkingLevel,
  subagentModelFor,
  type AgentThinkingLevel,
  type WileySettings,
} from "../settings/settings-schema";

/**
 * The model decisions the Pi runtime makes, pulled out of the runtime so they
 * can be reasoned about (and tested) without an SDK, a session, or a network.
 */
export interface SessionModelPlan {
  provider: string;
  rootModel: string;
  /** What the root session actually runs at, after fast mode is applied. */
  thinkingLevel: AgentThinkingLevel;
  subagentModel: string;
  approvalEnabled: boolean;
  approvalModel: string;
}

export function resolveSessionModels(settings: WileySettings): SessionModelPlan {
  return {
    provider: settings.agent.provider,
    rootModel: settings.agent.model,
    thinkingLevel: effectiveThinkingLevel(settings),
    subagentModel: subagentModelFor(settings),
    approvalEnabled: settings.agent.approvalEnabled,
    approvalModel: settings.agent.approvalModel,
  };
}

export interface SessionModelChanges {
  /** The root session needs setModel and/or setThinkingLevel. */
  root: boolean;
  /** The warm subagent was built on stale settings and must be rebuilt. */
  subagent: boolean;
  /** The approval judge must be rebuilt or torn down. */
  approval: boolean;
}

export function diffSessionModels(previous: SessionModelPlan, next: SessionModelPlan): SessionModelChanges {
  const providerChanged = previous.provider !== next.provider;
  const thinkingChanged = previous.thinkingLevel !== next.thinkingLevel;
  return {
    root: providerChanged || thinkingChanged || previous.rootModel !== next.rootModel,
    subagent: providerChanged || thinkingChanged || previous.subagentModel !== next.subagentModel,
    approval: previous.approvalEnabled !== next.approvalEnabled
      || previous.approvalModel !== next.approvalModel
      || providerChanged,
  };
}

/**
 * The allowlist is the user's answer to "what may Wiley spawn work on". A
 * model outside it is a misconfiguration, so say which one and where to fix it
 * rather than silently downgrading or silently widening the list.
 */
export function assertSpawnModelAllowed(settings: WileySettings, model: string): void {
  if (settings.agent.allowedModels.includes(model)) return;
  throw new Error(
    `Cannot start background work on "${model}": it is not in the allowed models list `
    + `(${settings.agent.allowedModels.join(", ") || "empty"}). Add it under Settings → Agent, `
    + "or choose an allowed model.",
  );
}
