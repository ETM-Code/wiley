#!/usr/bin/env node
/**
 * Renders a persisted Wiley board (a BOARD_AI_DATA_DIR) to a PNG, fitted to
 * the whole scene. No model calls; used to visually inspect e2e artifacts.
 *
 *   node scripts/board-shot.mjs <dataDir> <outPng>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [dataDir, outPng] = process.argv.slice(2);
if (!dataDir || !outPng) {
  console.error("usage: node scripts/board-shot.mjs <dataDir> <outPng>");
  process.exit(2);
}
const BACKEND_PORT = 5716;
const WEB_PORT = 5715;

const children = [];
function spawnStep(command, args, env) {
  // Own process group so teardown can kill the npx wrapper's children too.
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });
  children.push(child);
  return child;
}

async function waitFor(probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out");
}

try {
  spawnStep("npx", ["tsx", "src/server/index.ts"], {
    BOARD_AI_PORT: String(BACKEND_PORT),
    BOARD_AI_DATA_DIR: path.resolve(dataDir),
    BOARD_AI_PROJECT_DIR: root,
    VOICE_DISABLED: "1",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "unused-for-viewing",
  });
  spawnStep("npx", ["vite", "--config", "vite.browser.config.ts"], {
    BOARD_AI_PORT: String(BACKEND_PORT),
    WILEY_WEB_PORT: String(WEB_PORT),
  });
  await waitFor(() => fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`).then((response) => response.ok));
  await waitFor(() => fetch(`http://127.0.0.1:${WEB_PORT}`).then((response) => response.ok));

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 2000, height: 1300 } });
  await page.goto(`http://127.0.0.1:${WEB_PORT}`);
  await page.waitForFunction(() => {
    const api = window.excalidrawAPI;
    return Boolean(api && api.getSceneElements().length > 0);
  }, null, { timeout: 60_000 });
  await page.evaluate(async () => {
    const api = window.excalidrawAPI;
    await api.scrollToContent(api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.92, animate: false });
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.resolve(outPng) });
  await browser.close();
  console.log(`wrote ${outPng}`);
} finally {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
process.exit(0);
