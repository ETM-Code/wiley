import path from "node:path";
import os from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";

import type { AgentThinkingLevel } from "../settings/settings-schema";

export interface PiSessionOptions {
  projectDir: string;
  systemPrompt: string;
  guardExtension: InlineExtension;
  modelRuntime: ModelRuntime;
  customTools: ToolDefinition[];
  provider: string;
  model: string;
  thinkingLevel: AgentThinkingLevel;
  /** Extra skill directories, layered on top of the SDK's own discovery. */
  skillPaths?: string[];
}

/**
 * The runtime's own catalog first, since it knows what this install is
 * authenticated for, then the static built-in catalog for a model the runtime
 * has not composed yet.
 */
export function resolveModel(
  modelRuntime: ModelRuntime,
  provider: string,
  modelId: string,
): ReturnType<ModelRuntime["getModel"]> {
  return modelRuntime.getModel(provider, modelId)
    ?? (getModel as unknown as (p: string, m: string) => ReturnType<ModelRuntime["getModel"]>)(provider, modelId);
}

async function createSession(
  options: PiSessionOptions,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  const model = resolveModel(options.modelRuntime, options.provider, options.model);
  if (!model) throw new Error(`Pi model unavailable: ${options.provider}/${options.model}`);
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const settingsManager = SettingsManager.create(options.projectDir, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: options.projectDir,
    agentDir,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    extensionFactories: [options.guardExtension],
    ...(options.skillPaths?.length ? { additionalSkillPaths: options.skillPaths } : {}),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.projectDir,
    model,
    thinkingLevel: options.thinkingLevel,
    modelRuntime: options.modelRuntime,
    resourceLoader: loader,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...options.customTools.map((tool) => tool.name)],
    customTools: options.customTools,
    sessionManager,
    settingsManager,
  });
  return session;
}

/** The root session persists to disk so a relaunch can recover its history. */
export function createRootSession(options: PiSessionOptions): Promise<AgentSession> {
  return createSession(options, SessionManager.create(options.projectDir));
}

/** Subagents are disposable, so their history stays in memory. */
export function createSubagentSession(options: PiSessionOptions): Promise<AgentSession> {
  return createSession(options, SessionManager.inMemory());
}
