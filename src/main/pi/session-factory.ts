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

import { PI_MODEL, PI_PROVIDER, PI_THINKING_LEVEL } from "./constants";

export interface PiSessionOptions {
  projectDir: string;
  systemPrompt: string;
  guardExtension: InlineExtension;
  modelRuntime: ModelRuntime;
  customTools: ToolDefinition[];
  /** Extra skill directories, layered on top of the SDK's own discovery. */
  skillPaths?: string[];
}

async function createSession(
  options: PiSessionOptions,
  sessionManager: SessionManager,
): Promise<AgentSession> {
  const model = getModel(PI_PROVIDER, PI_MODEL);
  if (!model) throw new Error(`Pi model unavailable: ${PI_PROVIDER}/${PI_MODEL}`);
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
    thinkingLevel: PI_THINKING_LEVEL,
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
