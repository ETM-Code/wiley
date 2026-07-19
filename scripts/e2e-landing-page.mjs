#!/usr/bin/env node
/**
 * Layer-3+ scenario run (docs/agent-test-procedure.md): the full simulated
 * session the product must survive, against the real Pi model and a real
 * browser canvas.
 *
 *   1. Brief chat about the project (transcript seeding).
 *   2. Agent draws an architecture diagram of this project.
 *   3. "Human" (driven through the page's own Excalidraw pipeline) sketches
 *      a landing-page wireframe beside it.
 *   4. Agent fills in labels on the human's boxes without clearing anything.
 *   5. Agent builds the landing page, screenshots it, and places the
 *      screenshot on the board.
 *   6. Agent is asked to open it and must actually run bash `open`.
 *
 * Requires OPENAI_API_KEY (read from .env) and Google Chrome. Run with:
 *   npm run test:e2e:landing
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
const STEP_TIMEOUT_MS = Number(process.env.E2E_STEP_TIMEOUT_MS || 10 * 60 * 1000);

const runDir = path.join(root, ".e2e", `run-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = path.join(runDir, "workspace");
const dataDir = path.join(runDir, "data");
mkdirSync(workspace, { recursive: true });
mkdirSync(dataDir, { recursive: true });
cpSync(path.join(root, ".pi"), path.join(workspace, ".pi"), { recursive: true });
cpSync(path.join(root, "AGENTS.md"), path.join(workspace, "AGENTS.md"));
cpSync(path.join(root, "README.md"), path.join(workspace, "README.md"));
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

const fileEnv = loadEnvFile();
const apiKey = process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is required (in the environment or .env)");
  process.exit(2);
}

const children = [];
function spawnStep(name, command, args, env) {
  // Own process group: killing -pid takes the npx wrapper's children down
  // too, so no orphaned vite/tsx server can outlive the run.
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
        headers: { "x-wiley-client-id": "e2e-observer" },
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
    const idle = !status.agentRunning && status.activeJobs.length === 0;
    stable = idle ? stable + 1 : 0;
    return stable >= 3;
  }, STEP_TIMEOUT_MS, 2_000);
}

async function sendTask(task, userWords) {
  console.log(`\n▶ task: ${userWords}`);
  await api("/api/tool", {
    method: "POST",
    body: JSON.stringify({ name: "send_task_to_agent", args: { task, user_words: userWords } }),
  });
  await waitForIdle(`completion of: ${userWords.slice(0, 60)}`);
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "  PASS" : "  FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
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
  await waitFor("backend health", () => api("/api/health").then((body) => body.ok), 120_000);
  await waitFor("frontend", () => fetch(FRONTEND).then((response) => response.ok), 120_000);
  void observeEvents();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(FRONTEND);
  await page.waitForFunction(() => Boolean(window.excalidrawAPI && window.convertToExcalidrawElements), null, { timeout: 60_000 });

  // 1. Brief chat context, as the voice layer would have recorded it.
  await api("/api/transcript", { method: "POST", body: JSON.stringify({ role: "user", text: "Hey Wiley, what is this project about?" }) });
  await api("/api/transcript", { method: "POST", body: JSON.stringify({ role: "assistant", text: "It's Wiley itself: a voice-driven Excalidraw whiteboard backed by a Pi coding agent. Details are in README.md and docs." }) });

  // 2. Architecture diagram.
  await sendTask(
    "Draw one clear architecture diagram of this project (Wiley) on the whiteboard using draw_diagram. Read README.md first if needed. One node per real component (voice model, Pi orchestrator, subagents, Excalidraw canvas, ledger), labelled edges.",
    "Draw a diagram on the board explaining how this project works",
  );
  let board = await api("/api/board-state");
  const diagramArrows = board.elements.filter((element) => element.type === "arrow");
  check("diagram drawn", board.elements.length >= 8, `${board.elements.length} elements`);
  check("diagram arrows are bound", diagramArrows.length >= 3
    && diagramArrows.every((arrow) => arrow.startBinding?.elementId && arrow.endBinding?.elementId),
    `${diagramArrows.length} arrows`);

  // 3. Human sketches a landing-page wireframe through the app's pipeline.
  const wireframe = await page.evaluate(() => {
    const api = window.excalidrawAPI;
    const convert = window.convertToExcalidrawElements;
    const existing = api.getSceneElements();
    const bottom = Math.max(0, ...existing.map((element) => element.y + element.height));
    const left = Math.min(0, ...existing.map((element) => element.x));
    const baseY = bottom + 240;
    const skeletons = [
      { type: "rectangle", x: left, y: baseY, width: 900, height: 70 },
      { type: "rectangle", x: left, y: baseY + 90, width: 900, height: 220 },
      { type: "rectangle", x: left, y: baseY + 330, width: 280, height: 160 },
      { type: "rectangle", x: left + 310, y: baseY + 330, width: 280, height: 160 },
      { type: "rectangle", x: left + 620, y: baseY + 330, width: 280, height: 160 },
      { type: "rectangle", x: left, y: baseY + 520, width: 900, height: 60 },
    ];
    const created = convert(skeletons);
    api.updateScene({ elements: [...existing, ...created] });
    return created.map((element) => element.id);
  });
  await waitFor("wireframe in canonical board", async () => {
    const state = await api("/api/board-state");
    return wireframe.every((id) => state.elements.some((element) => element.id === id));
  }, 30_000);
  check("wireframe submitted", true, `${wireframe.length} boxes`);

  // 4. Fill in labels without clearing.
  await sendTask(
    `I just hand-drew a landing-page wireframe below the diagram (six plain rectangles: top bar, big hero box, three cards, bottom bar; their element ids are ${wireframe.join(", ")}). Label each of MY boxes with what that section should be, by patching text on those exact element ids with edit_canvas. Do not clear the canvas, do not delete or redraw my boxes, do not add a new diagram.`,
    "I sketched a landing page wireframe, fill in what each part should be",
  );
  board = await api("/api/board-state");
  const survivingWireframe = wireframe.filter((id) => board.elements.some((element) => element.id === id));
  const wireframeLabels = board.elements.filter((element) =>
    element.type === "text" && wireframe.includes(element.containerId));
  check("wireframe boxes survived (no clearing)", survivingWireframe.length === wireframe.length,
    `${survivingWireframe.length}/${wireframe.length}`);
  check("labels bound to the human's boxes", wireframeLabels.length >= 4,
    `${wireframeLabels.length} labels: ${wireframeLabels.map((label) => label.text).join(" | ")}`);
  const overflowing = wireframeLabels.filter((label) => {
    const box = board.elements.find((element) => element.id === label.containerId);
    return box && label.width > box.width;
  });
  check("labels fit inside their boxes", overflowing.length === 0,
    overflowing.map((label) => label.text).join(" | ") || "all within bounds");

  // 5. Build the site, screenshot it, place the screenshot on the board.
  await sendTask(
    "Now build that landing page for Wiley as a single self-contained file at site/index.html in the workspace, following the labelled wireframe and the site-preview and landing-page skills. Screenshot the rendered page headlessly and place the screenshot on the whiteboard near the wireframe with place_image. Do not clear the canvas.",
    "Build the landing page website from my wireframe and put a screenshot of it on the board",
  );
  const sitePath = path.join(workspace, "site", "index.html");
  check("site/index.html generated", existsSync(sitePath), sitePath);
  board = await api("/api/board-state");
  const images = board.elements.filter((element) => element.type === "image");
  check("screenshot placed on canvas", images.length >= 1, `${images.length} image elements`);
  check("image file payload stored", board.files && Object.keys(board.files).length >= 1,
    `${Object.keys(board.files ?? {}).length} files`);

  // 6. Open it for real.
  await sendTask(
    "Open the generated website (site/index.html) for the user in their browser now.",
    "Open the website for me",
  );
  const openCall = agentEvents.find((event) => event.type === "tool_started"
    && event.payload?.toolName === "bash"
    && JSON.stringify(event.payload?.input ?? "").includes("open"));
  check("agent ran bash to open the site", Boolean(openCall),
    openCall ? JSON.stringify(openCall.payload.input).slice(0, 120) : "no bash open call observed");

  writeFileSync(path.join(runDir, "final-board.json"), JSON.stringify(board, null, 2));
  writeFileSync(path.join(runDir, "agent-events.json"), JSON.stringify(agentEvents, null, 2));
  await page.screenshot({ path: path.join(runDir, "final-canvas.png"), fullPage: false });
  await page.evaluate(async () => {
    const canvasApi = window.excalidrawAPI;
    await canvasApi.scrollToContent(canvasApi.getSceneElements(), {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: false,
    });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(runDir, "full-board.png"), fullPage: false });
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
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

console.log("\n=== scenario results ===");
for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
}
if (results.some((result) => !result.pass)) failed = true;
console.log(`artifacts: ${runDir}`);
process.exit(failed ? 1 : 0);
