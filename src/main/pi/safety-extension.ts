import path from "node:path";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { RuntimeLedger } from "../ledger";
import { ApprovalJudge, CatastrophicCommandGuard, ReadBeforeEditGuard, isReadOnlyCommand } from "../safety";
import type { VoiceBridge } from "../voice-bridge";
import { ALLOWED_MODEL_FAMILY, isAllowedBackendModel } from "../settings/settings-schema";
import { APPROVAL_REASONING_EFFORT, DEFAULT_APPROVAL_MODEL, JUDGED_TOOLS, PI_PROVIDER } from "./constants";
import { redact } from "./redact";

/**
 * The env switch is an escape hatch for a headless run, not a way around the
 * model family: a name from an older family is refused here the same way the
 * settings panel refuses to save one.
 */
function approvalModelId(configured?: string): string {
  for (const candidate of [process.env.WILEY_APPROVAL_MODEL?.trim(), configured?.trim()]) {
    if (!candidate) continue;
    if (isAllowedBackendModel(candidate)) return candidate;
    console.warn(
      `Ignoring approval model "${candidate}": Wiley only runs ${ALLOWED_MODEL_FAMILY} models. `
      + `Falling back to ${DEFAULT_APPROVAL_MODEL}.`,
    );
    return DEFAULT_APPROVAL_MODEL;
  }
  return DEFAULT_APPROVAL_MODEL;
}

export interface ApprovalJudgeOptions {
  enabled?: boolean;
  provider?: string;
  model?: string;
  /**
   * The composed runtime, which is the only thing that knows about providers
   * registered at runtime (the cloud relay among them). Without it the judge
   * can only see the SDK's built-in catalog, which on a hosted account holds
   * no matching model at all: the judge would silently never run.
   */
  modelRuntime?: Pick<ModelRuntime, "getModel" | "complete">;
}

/**
 * Settings decide whether the soft approval layer runs and on which model; the
 * env switches stay as the escape hatch for a headless or scripted run.
 */
export function createApprovalJudge(options: ApprovalJudgeOptions = {}): ApprovalJudge | undefined {
  if (process.env.WILEY_APPROVAL_DISABLED === "1") return undefined;
  if (options.enabled === false) return undefined;
  const modelId = approvalModelId(options.model);
  const provider = options.provider ?? PI_PROVIDER;
  const runtime = options.modelRuntime;
  // The static catalog is typed against its own literal ids; settings carry
  // free text, and an unknown pair simply yields undefined below.
  const judgeModel = runtime?.getModel(provider, modelId)
    ?? getModel(provider as typeof PI_PROVIDER, modelId as typeof DEFAULT_APPROVAL_MODEL);
  if (!judgeModel) return undefined;
  // Routed through the runtime when there is one, so a request for a
  // relay-hosted model is authenticated the same way every other one is.
  const request = runtime
    ? runtime.complete.bind(runtime)
    : complete;
  return new ApprovalJudge(async ({ systemPrompt, userMessage, signal }) => {
    const message = await request(judgeModel, {
      systemPrompt,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
    }, { signal, reasoningEffort: APPROVAL_REASONING_EFFORT });
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  });
}

export function createGuardExtension(options: {
  projectDir: string;
  voice: VoiceBridge;
  ledger: RuntimeLedger;
  /** Read lazily so the judge can be built after the sessions that use it. */
  approvalJudge: () => ApprovalJudge | undefined;
}): InlineExtension {
  const { projectDir, voice, ledger, approvalJudge } = options;
  const commandGuard = new CatastrophicCommandGuard(projectDir);
  const editGuard = new ReadBeforeEditGuard();
  return {
    name: "wiley-safety-guard",
    factory: (pi) => {
      pi.on("tool_result", (event) => {
        if (event.toolName === "read" && !event.isError) {
          const input = event.input as { path?: string };
          if (input.path) editGuard.markRead(path.resolve(projectDir, input.path));
        }
      });
      pi.on("tool_call", async (event, context) => {
        if (event.toolName === "edit" || event.toolName === "write") {
          const input = event.input as { path?: string };
          if (input.path) {
            const decision = editGuard.inspect(path.resolve(projectDir, input.path));
            if (!decision.allow) return { block: true, reason: decision.reason ?? "Read before editing" };
          }
        }
        if (event.toolName === "bash") {
          const input = event.input as { command?: string };
          const decision = commandGuard.inspect(input.command ?? "", context.cwd);
          if (!decision.allow) {
            voice.push(`[safety] I stopped a dangerous command. ${decision.reason}`, { interrupt: true });
            return { block: true, reason: `${decision.reason} Do not retry or work around this block.` };
          }
        }
        // Everything above is the hard floor. The approval judge is the
        // soft layer: a cheap model approves routine work and blocks only
        // destruction, secret leaks, or contradicting the user.
        const judge = approvalJudge();
        if (!judge || !JUDGED_TOOLS.has(event.toolName)) return undefined;
        if (event.toolName === "bash") {
          const input = event.input as { command?: string };
          if (isReadOnlyCommand(input.command ?? "")) return undefined;
        }
        const recentUserRequests = ledger.getTranscript()
          .filter((entry) => entry.role === "user")
          .slice(-6)
          .map((entry) => entry.text);
        const verdict = await judge.review({
          tool: event.toolName,
          input: redact(event.input),
          cwd: context.cwd,
          recentUserRequests,
        }, context.signal);
        if (verdict.allow) return undefined;
        voice.push(`[safety] I stopped myself before a risky ${event.toolName} action. ${verdict.reason}`, { interrupt: true });
        return {
          block: true,
          reason: `Blocked by the safety reviewer: ${verdict.reason} Do not retry this action or work `
            + "around the block. If it is genuinely necessary, explain and get explicit permission via ask_user first.",
        };
      });
    },
  };
}
