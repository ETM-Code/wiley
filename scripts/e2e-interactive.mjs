#!/usr/bin/env node
/**
 * Interactivity scenario: verifies Wiley behaves like a coworker at the
 * whiteboard rather than a silent contractor.
 *
 *   1. A research-heavy diagram task: must narrate while reading, draw
 *      incrementally (board grows in steps, not one dump), and finish with
 *      a spoken walkthrough.
 *   2. A correction: must fix/erase the stale part on the board, not
 *      redraw everything or ignore it.
 *   3. Status question answers from recentWork.
 *   4. new_session: board empty, memory reset, next task starts clean.
 *
 * Emits a detailed timeline for human review plus hard assertions.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 5714);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5713);
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND = `http://127.0.0.1:${WEB_PORT}`;
const STEP_TIMEOUT_MS = Number(process.env.E2E_STEP_TIMEOUT_MS || 12 * 60 * 1000);

const runDir = path.join(root, ".e2e", `interactive-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = path.join(runDir, "workspace");
const dataDir = path.join(runDir, "data");
mkdirSync(workspace, { recursive: true });
mkdirSync(dataDir, { recursive: true });
cpSync(path.join(root, ".pi"), path.join(workspace, ".pi"), { recursive: true });
cpSync(path.join(root, "AGENTS.md"), path.join(workspace, "AGENTS.md"));
cpSync(path.join(root, "README.md"), path.join(workspace, "README.md"));
cpSync(path.join(root, "src"), path.join(workspace, "src"), { recursive: true });
cpSync(path.join(root, "docs"), path.join(workspace, "docs"), { recursive: true });

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
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}

const children = [];
function spawnStep(name, command, args, env) {
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

async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 1_000) {
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

const voiceFeed = [];
const agentEvents = [];
let observerRunning = true;
async function observeEvents() {
  let cursor = 0;
  while (observerRunning) {
    try {
      const page = await fetch(`${BACKEND}/api/events/poll?after=${cursor}`, {
        headers: { "x-wiley-client-id": "e2e-interactive-observer" },
      }).then((response) => response.json());
      cursor = page.cursor ?? cursor;
      for (const event of page.events ?? []) {
        if (event.channel === "voice:inject") {
          voiceFeed.push({ at: Date.now(), text: event.payload?.text ?? "" });
          console.log(`   🔊 ${String(event.payload?.text ?? "").slice(0, 140)}`);
        }
        if (event.channel === "agent:events") agentEvents.push(event.payload);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

const boardTimeline = [];
let samplerRunning = true;
async function sampleBoard() {
  while (samplerRunning) {
    try {
      const state = await api("/api/board-state");
      const last = boardTimeline.at(-1);
      const visible = state.elements.filter((element) => element.isDeleted !== true).length;
      if (!last || last.count !== visible || last.revision !== state.revision) {
        boardTimeline.push({ at: Date.now(), count: visible, revision: state.revision });
        console.log(`   🧮 board: ${visible} elements (rev ${state.revision})`);
      }
    } catch {
      // backend restarting; keep sampling
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function waitForIdle(label) {
  let stable = 0;
  await waitFor(label, async () => {
    const status = await api("/api/status");
    const idle = !status.agentRunning && status.activeJobs.length === 0;
    stable = idle ? stable + 1 : 0;
    return stable >= 3;
  }, STEP_TIMEOUT_MS, 2_000);
}

async function sendTask(task, userWords) {
  console.log(`\n▶ ${userWords}`);
  await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({ name: "send_task_to_agent", args: { task, user_words: userWords } }),
  });
  await waitForIdle(userWords.slice(0, 50));
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "  PASS" : "  FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

function sentenceCount(text) {
  return (text.match(/[.!?](\s|$)/g) ?? []).length;
}

async function main() {
  console.log(`run dir: ${runDir}`);
  spawnStep("backend", "npx", ["tsx", "src/server/index.ts"], {
    OPENAI_API_KEY: apiKey,
    BOARD_AI_PORT: String(BACKEND_PORT),
    BOARD_AI_PROJECT_DIR: workspace,
    BOARD_AI_DATA_DIR: dataDir,
    VOICE_DISABLED: "1",
  });
  spawnStep("frontend", "npx", ["vite", "--config", "vite.browser.config.ts"], {
    BOARD_AI_PORT: String(BACKEND_PORT),
    WILEY_WEB_PORT: String(WEB_PORT),
  });
  await waitFor("backend", () => api("/api/health").then((body) => body.ok));
  await waitFor("frontend", () => fetch(FRONTEND).then((response) => response.ok));
  void observeEvents();
  void sampleBoard();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(FRONTEND);
  await page.waitForFunction(() => Boolean(window.excalidrawAPI), null, { timeout: 60_000 });

  // ── 1. Research-heavy diagram task: narration + incremental drawing ──
  const feedStart = voiceFeed.length;
  const timelineStart = boardTimeline.length;
  await sendTask(
    "Diagram how Wiley's safety layers work on the whiteboard. Read src/main/safety.ts and src/main/pi-runtime.ts to get it right. Work visibly: narrate what you are reading and drawing, put a first rough diagram up early, then refine it as you learn more.",
    "Map out how the safety layers work as a diagram, check the code as you go",
  );
  const taskFeed = voiceFeed.slice(feedStart).map((entry) => entry.text);
  const progress = taskFeed.filter((text) => text.startsWith("[agent progress]"));
  const finished = taskFeed.filter((text) => text.startsWith("[agent finished]"));
  check("narrated while working", progress.length >= 2, `${progress.length} progress messages`);
  const growthSteps = boardTimeline.slice(timelineStart)
    .filter((sample, index, samples) => index > 0 && sample.count > samples[index - 1].count).length;
  check("board grew in multiple visible steps", growthSteps >= 2, `${growthSteps} growth steps`);
  const walkthrough = finished.at(-1) ?? "";
  check("finished with a spoken walkthrough (2+ sentences)",
    sentenceCount(walkthrough.replace("[agent finished]", "")) >= 2 && walkthrough.length > 140,
    `${walkthrough.slice(0, 180)}...`);

  const boardBefore = await api("/api/board-state");
  const textsBefore = boardBefore.elements
    .filter((element) => element.type === "text")
    .map((element) => element.text);

  // ── 2. Correction: stale content must be fixed on the board ──
  const eventsBefore = agentEvents.length;
  await sendTask(
    "One thing on the current safety diagram is wrong or missing: the approval reviewer runs a separate cheap model (gpt-5.4-mini by default via WILEY_APPROVAL_MODEL), it is NOT the main luna model, and read-only bash commands skip it entirely. Verify against src/main/safety.ts and correct the existing diagram in place: fix or erase only the wrong parts, do not clear the board, do not draw a second diagram.",
    "The judge model part looks wrong, fix the diagram in place",
  );
  const correctionCalls = agentEvents.slice(eventsBefore).filter((event) =>
    event.type === "tool_started"
    && ["edit_canvas", "draw_on_canvas", "connect_shapes"].includes(event.payload?.toolName));
  const clearCalls = agentEvents.slice(eventsBefore).filter((event) =>
    event.type === "tool_started" && event.payload?.toolName === "clear_canvas");
  check("corrected in place with edits", correctionCalls.length >= 1,
    correctionCalls.map((event) => event.payload.toolName).join(", ") || "no edit tools used");
  check("did not clear the board to correct", clearCalls.length === 0);
  const boardAfter = await api("/api/board-state");
  const textsAfter = boardAfter.elements
    .filter((element) => element.type === "text")
    .map((element) => element.text);
  check("board text actually changed", JSON.stringify(textsBefore) !== JSON.stringify(textsAfter),
    `${textsBefore.length} -> ${textsAfter.length} texts`);

  // ── 3. Status reflects the session ──
  const status = await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({ name: "get_agent_status", args: {} }),
  });
  check("recentWork carries finished tasks with reports",
    status.recentWork.length >= 2 && status.recentWork.some((job) => job.report),
    `${status.recentWork.length} recent jobs`);

  // ── 4. New session: clean slate ──
  await api("/api/tool", { method: "POST", body: JSON.stringify({ name: "new_session", args: {} }) });
  await waitFor("board cleared", async () => {
    const state = await api("/api/board-state");
    return state.elements.filter((element) => element.isDeleted !== true).length === 0;
  }, 30_000);
  const statusAfterReset = await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({ name: "get_agent_status", args: {} }),
  });
  check("new session: board empty", true);
  check("new session: no stale recent work", statusAfterReset.recentWork.length === 0,
    `${statusAfterReset.recentWork.length} lingering jobs`);
  check("new session: nothing running", statusAfterReset.running === false);

  await sendTask(
    "Quick sanity check for a fresh session: draw a single small diagram with two nodes, Idea and Shipped, connected by an arrow labelled build.",
    "New topic: draw idea to shipped",
  );
  const freshBoard = await api("/api/board-state");
  check("fresh session draws cleanly", freshBoard.elements.length >= 3 && freshBoard.elements.length <= 12,
    `${freshBoard.elements.length} elements`);
  const statusFresh = await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({ name: "get_agent_status", args: {} }),
  });
  check("status shows only the fresh session's work", statusFresh.recentWork.length === 1,
    `${statusFresh.recentWork.length} recent jobs`);

  writeFileSync(path.join(runDir, "voice-feed.json"), JSON.stringify(voiceFeed, null, 2));
  writeFileSync(path.join(runDir, "board-timeline.json"), JSON.stringify(boardTimeline, null, 2));
  writeFileSync(path.join(runDir, "agent-events.json"), JSON.stringify(agentEvents, null, 2));
  await page.evaluate(async () => {
    const canvasApi = window.excalidrawAPI;
    const elements = canvasApi.getSceneElements();
    if (elements.length > 0) {
      await canvasApi.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.92, animate: false });
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(runDir, "final-canvas.png") });
  await browser.close();
}

let failed = false;
try {
  await main();
} catch (error) {
  console.error("\nScenario crashed:", error);
  failed = true;
} finally {
  observerRunning = false;
  samplerRunning = false;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

console.log("\n=== interactivity results ===");
for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
}
if (results.some((result) => !result.pass)) failed = true;
console.log(`artifacts: ${runDir}`);
process.exit(failed ? 1 : 0);
