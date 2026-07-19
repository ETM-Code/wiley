import type { JobSummary, VoiceToolName } from "./contracts";
import type { RuntimeLedger } from "./ledger";
import type { PiRuntime } from "./pi-runtime";
import type { RuntimeController } from "./runtime-controller";
import type { CanvasBridge } from "./canvas-bridge";
import type { VoiceBridge } from "./voice-bridge";

export interface VoiceToolDeps {
  runtime: RuntimeController;
  canvas: CanvasBridge;
  voice: VoiceBridge;
  ledger: RuntimeLedger;
  pi: PiRuntime;
}

const FINISHED_STATUSES = new Set<JobSummary["status"]>(["completed", "failed", "cancelled"]);

/**
 * The voice model has no working memory of past runs, so status includes
 * recently finished work with each run's final report. "What have you done
 * so far?" must be answerable from this one tool result.
 */
export function agentStatusReport(deps: Pick<VoiceToolDeps, "runtime" | "ledger" | "pi">) {
  const state = deps.runtime.getState();
  const reportsByJob = new Map<string, string>();
  for (const event of deps.ledger.getAgentEvents()) {
    if (event.agentId !== "root" || (event.type !== "completed" && event.type !== "error")) continue;
    const report = (event.payload as { report?: string; error?: string } | undefined);
    const text = report?.report ?? report?.error;
    if (text) reportsByJob.set(event.jobId, text);
  }
  const jobs = deps.ledger.listJobs()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const currentWork = state.activeJobs.map((job) => ({
    task: job.task,
    status: job.status,
    startedAt: job.createdAt,
  }));
  const recentWork = jobs
    .filter((job) => FINISHED_STATUSES.has(job.status))
    .slice(0, 5)
    .map((job) => ({
      task: job.task,
      status: job.status,
      finishedAt: job.updatedAt,
      report: reportsByJob.get(job.id),
    }));
  const workers = deps.pi.listSubagents()
    .filter((worker) => worker.status === "running" || worker.status === "queued")
    .map((worker) => ({ task: worker.task, status: worker.status }));
  return {
    running: state.agentRunning || currentWork.length > 0,
    currentWork,
    recentWork,
    backgroundWorkers: workers,
    boardRevision: state.boardRevision,
  };
}

export async function callVoiceTool(
  deps: VoiceToolDeps,
  name: VoiceToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "send_task_to_agent":
      return deps.runtime.submitJob(String(args.task ?? ""), String(args.user_words ?? ""), args.queue === true);
    case "answer_agent":
      return { ok: deps.voice.deliverAnswer(String(args.answer ?? "")) };
    case "get_agent_status":
      return agentStatusReport(deps);
    case "look_at_board": {
      const elements = await deps.canvas.request<Array<{ type?: string; text?: string }>>("get-scene-summary");
      return {
        elements: elements.length,
        texts: elements.filter((element) => element.text).map((element) => element.text),
      };
    }
    case "abort_agent":
      await deps.runtime.abortCurrent();
      return { ok: true, note: "Current work aborted." };
    default:
      throw new Error(`Unknown voice tool: ${String(name)}`);
  }
}
