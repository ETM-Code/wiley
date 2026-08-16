#!/usr/bin/env node
/**
 * End-to-end proof that the Claude Code worker connector really works.
 *
 * This one costs tokens on two accounts (the Pi root agent and the worker
 * itself), so it is never part of CI. It boots the browser backend against a
 * throwaway workspace, config dir, and ledger, turns the claude worker on with
 * a cheap pinned model, asks the coordinator to delegate one small job, and
 * then checks the three things that can only be checked for real:
 *
 *   1. the worker actually wrote the file, so the whole chain ran;
 *   2. the ledger carries the worker's own events under its own agent id;
 *   3. nothing we started is still running once the app is gone.
 *
 * Requires OPENAI_API_KEY (environment or .env) and a signed-in claude CLI.
 *   node scripts/e2e-worker.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 5716);
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const STEP_TIMEOUT_MS = Number(process.env.E2E_STEP_TIMEOUT_MS || 8 * 60 * 1000);
const WORKER_MODEL = process.env.E2E_WORKER_MODEL || "haiku";
const PROOF_FILE = "worker-proof.txt";

const runDir = path.join(root, ".e2e", `worker-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = path.join(runDir, "workspace");
const dataDir = path.join(runDir, "data");
const configDir = path.join(runDir, "config");
for (const dir of [workspace, dataDir, configDir]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(workspace, "README.md"), "# Scratch workspace for the worker e2e run\n");

function loadEnvFile() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return {};
  const entries = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) entries[match[1]] = match[2];
  }
  return entries;
}

const apiKey = process.env.OPENAI_API_KEY || loadEnvFile().OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is required (in the environment or .env)");
  process.exit(2);
}

const children = [];
function spawnStep(name, command, args, env) {
  // Own process group: killing -pid takes the tsx wrapper's children with it.
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log = path.join(runDir, `${name}.log`);
  const chunks = [];
  const sink = (data) => {
    chunks.push(data);
    writeFileSync(log, Buffer.concat(chunks));
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  children.push(child);
  return child;
}

async function waitFor(label, probe, timeoutMs = 60_000, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

async function api(pathname, init) {
  const response = await fetch(`${BACKEND}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${pathname} -> ${response.status}: ${await response.text()}`);
  return response.json();
}

const agentEvents = [];
let observerRunning = true;
async function observeEvents() {
  let cursor = 0;
  while (observerRunning) {
    try {
      const page = await fetch(`${BACKEND}/api/events/poll?after=${cursor}`, {
        headers: { "x-wiley-client-id": "e2e-worker-observer" },
      }).then((response) => response.json());
      cursor = page.cursor ?? cursor;
      for (const event of page.events ?? []) {
        if (event.channel === "agent:events") agentEvents.push(event.payload);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function waitForIdle(label) {
  let stable = 0;
  await waitFor(label, async () => {
    const status = await api("/api/status");
    const idle = !status.agentRunning
      && status.activeJobs.length === 0
      && !(status.subagents ?? []).some((worker) => !["done", "failed", "cancelled"].includes(worker.status));
    stable = idle ? stable + 1 : 0;
    return stable >= 3;
  }, STEP_TIMEOUT_MS, 2_000);
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "  PASS" : "  FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

/** Process ids the run recorded for itself, so the sweep only judges its own. */
function recordedWorkerPids() {
  const file = path.join(dataDir, "workers", "pids.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`run dir: ${runDir}`);
  spawnStep("backend", "npx", ["tsx", "src/server/index.ts"], {
    OPENAI_API_KEY: apiKey,
    WILEY_PORT: String(BACKEND_PORT),
    WILEY_PROJECT_DIR: workspace,
    WILEY_DATA_DIR: dataDir,
    // A throwaway config dir: this run must never touch the real settings.
    WILEY_CONFIG_DIR: configDir,
    VOICE_DISABLED: "1",
  });
  await waitFor("backend health", () => api("/api/health").then((body) => body.ok), 180_000);
  void observeEvents();

  const settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      agent: { allowedModels: ["gpt-5.6-luna", "gpt-5.4-mini", WORKER_MODEL] },
      workers: { claude: { enabled: true, model: WORKER_MODEL, maxConcurrent: 1, turnTimeoutMs: 300_000 } },
    }),
  });
  check("claude worker enabled with a pinned model", settings.workers.claude.enabled
    && settings.workers.claude.model === WORKER_MODEL, settings.workers.claude.model);

  const probes = await api("/api/settings/probe", { method: "POST" });
  console.log(`  probe: claude ${JSON.stringify(probes.claude)}`);
  check("claude CLI is available on this machine", probes.claude.available, probes.claude.reason ?? probes.claude.version);
  if (!probes.claude.available) return;

  await api("/api/transcript", {
    method: "POST",
    body: JSON.stringify({ role: "user", text: "Get a background worker to leave me a proof file." }),
  });

  console.log("\n▶ delegating one small job to a claude worker");
  await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({
      name: "send_task_to_agent",
      args: {
        // Explicit rather than natural: this run is testing the connector,
        // not the coordinator's judgement about when to delegate.
        task: `Call spawn_agent with kind "claude" and the task: create a file named ${PROOF_FILE} `
          + "in the project directory whose entire contents are the two characters OK, then report that you "
          + "did it. Do not create the file yourself and do not draw anything on the board. Wait for the "
          + "worker's report, then finish.",
        user_words: "Have a background worker leave me a proof file.",
      },
    }),
  });
  await waitForIdle("the worker to finish and report");

  const proofPath = path.join(workspace, PROOF_FILE);
  const proof = existsSync(proofPath) ? readFileSync(proofPath, "utf8").trim() : "";
  check("the worker wrote the proof file", proof === "OK", proof || "missing");

  const workerEvents = agentEvents.filter((event) => String(event.agentId ?? "").startsWith("claude-"));
  const workerIds = [...new Set(workerEvents.map((event) => event.agentId))];
  check("the ledger carries the worker's own events", workerEvents.length > 0,
    `${workerEvents.length} events from ${workerIds.length} worker(s)`);
  check("the worker reported a completion", workerEvents.some((event) => event.type === "completed"));
  const usage = workerEvents.find((event) => event.type === "completed")?.payload ?? {};
  console.log(`  worker cost: ${usage.costUsd ?? "not reported"} USD over ${usage.numTurns ?? "?"} turn(s)`);

  const pids = recordedWorkerPids();
  writeFileSync(path.join(runDir, "agent-events.json"), JSON.stringify(agentEvents, null, 2));
  writeFileSync(path.join(runDir, "worker-pids.json"), JSON.stringify(pids, null, 2));
  return pids;
}

let failed = false;
let recorded = [];
try {
  recorded = (await main()) ?? [];
} catch (error) {
  console.error("\nScenario crashed:", error);
  failed = true;
} finally {
  observerRunning = false;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

// Give the host its shutdown, then judge only the pids this run recorded.
await new Promise((resolve) => setTimeout(resolve, 3_000));
const survivors = recorded.filter((record) => isAlive(record.pid));
check("no worker process this run started is still alive", survivors.length === 0,
  survivors.map((record) => record.pid).join(", "));

console.log("\n=== worker connector results ===");
for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
}
if (results.some((result) => !result.pass)) failed = true;
console.log(`artifacts: ${runDir}`);
process.exit(failed ? 1 : 0);
