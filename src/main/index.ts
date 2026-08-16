import "dotenv/config";
import { app, BrowserWindow, net, protocol, safeStorage, session } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteRuntimeLedger } from "./ledger";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";
import { VoiceBridge } from "./voice-bridge";
import { PiRuntime } from "./pi-runtime";
import { RuntimeController } from "./runtime-controller";
import { registerIpc } from "./ipc";
import { IPC } from "../shared/contracts";
import { isTrustedOrigin } from "./trusted-origin";
import { resolveSkillsDir } from "./skills";
import { createSecretStore } from "./settings/secret-store";
import { SettingsService } from "./settings/settings-service";
import { SettingsStore } from "./settings/settings-store";
import { createWorkerProbes } from "./workers/worker-runtime";

let mainWindow: BrowserWindow | undefined;
let pi: PiRuntime | undefined;
let ledger: SqliteRuntimeLedger | undefined;
let canvas: CanvasBridge | undefined;
let voice: VoiceBridge | undefined;
let disposeIpc: (() => void) | undefined;

/** Reports delivery so callers with no live window fail fast instead of waiting for a timeout. */
function sendToRenderer(channel: string, payload: unknown): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.webContents.send(channel, payload);
  return true;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "wiley",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function installAppProtocol(): void {
  const rendererRoot = path.resolve(__dirname, "../renderer");
  protocol.handle("wiley", (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(rendererRoot, relative);
    if (file !== rendererRoot && !file.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response("Invalid asset path", { status: 400 });
    }
    return net.fetch(pathToFileURL(file).toString()).then((response) => {
      if (!response.ok) console.error(`Local asset failed (${response.status}): ${relative}`);
      return response;
    }, (error) => {
      console.error(`Local asset could not be read: ${relative}`, error);
      return new Response("Asset unavailable", { status: 404 });
    });
  });
}

function installSecurityPolicy(): void {
  const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === "media" && isTrustedOrigin(requestingOrigin);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permission === "media" && isTrustedOrigin(details.requestingUrl || webContents.getURL()));
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    headers["Content-Security-Policy"] = [
      "default-src 'self'; " +
      `script-src 'self' 'sha256-VtYzmPgv0p0NmDyCBC0EANQjw/8yWpIy0/m8nIcctdk='${isDevelopment ? " 'unsafe-inline'" : ""}; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data:; " +
      "media-src 'self' blob:; " +
      "connect-src 'self' https://api.openai.com wss://api.openai.com; " +
      "worker-src 'self' blob:;",
    ];
    callback({ responseHeaders: headers });
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#ffffff",
    title: "Wiley",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.BOARD_AI_DEBUG_RENDERER === "1") {
    win.webContents.on("console-message", (details) => {
      const log = details.level === "error" ? console.error : details.level === "warning" ? console.warn : console.log;
      log(`[renderer:${details.level}] ${details.message}`);
    });
  }
  win.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    console.error(`Renderer failed to load ${validatedUrl}: ${code} ${description}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process exited", details);
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedOrigin(url)) event.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadURL("wiley://app/index.html");
  return win;
}

async function bootstrap(): Promise<void> {
  installAppProtocol();
  installSecurityPolicy();
  const configDir = process.env.WILEY_CONFIG_DIR?.trim() || app.getPath("userData");
  const settingsStore = SettingsStore.open(configDir, createSecretStore({ dir: configDir, safeStorage }));
  ledger = new SqliteRuntimeLedger(
    process.env.BOARD_AI_DATA_DIR
      ? path.join(process.env.BOARD_AI_DATA_DIR, "runtime.sqlite")
      : path.join(app.getPath("userData"), "runtime.sqlite"),
  );
  await ledger.initialize();
  const transcript = new TranscriptStore(ledger);
  const canvasBridge = new CanvasBridge(
    ledger,
    (request) => sendToRenderer(IPC.canvasRequest, request),
  );
  const voiceBridge = new VoiceBridge((message) => sendToRenderer(IPC.voiceInject, message));
  canvas = canvasBridge;
  voice = voiceBridge;
  canvasBridge.onHumanChange = (summary) => voiceBridge.pushBoardUpdate(summary);
  const projectDir = process.env.BOARD_AI_PROJECT_DIR ?? process.cwd();
  const skillsDir = resolveSkillsDir({ isPackaged: app.isPackaged, appRoot: app.getAppPath() });
  const dataDir = process.env.BOARD_AI_DATA_DIR?.trim() || app.getPath("userData");
  pi = new PiRuntime(projectDir, ledger, transcript, canvasBridge, voiceBridge, skillsDir, settingsStore, dataDir);
  await pi.initialize();
  const settings = new SettingsService({
    store: settingsStore,
    modelRuntime: () => pi?.modelRuntime,
    probeWorkers: createWorkerProbes(() => settingsStore.get()),
  });
  const runtime = new RuntimeController(ledger, transcript, pi, canvasBridge, sendToRenderer, settingsStore);
  await runtime.recoverInterruptedJobs();
  disposeIpc = registerIpc({
    runtime,
    transcript,
    canvas: canvasBridge,
    voice: voiceBridge,
    ledger,
    pi,
    settings,
    sendToRenderer,
  });
  mainWindow = await createWindow();
  mainWindow.on("closed", () => {
    canvasBridge.failPending();
    mainWindow = undefined;
  });
}

void app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    console.error("Failed to start Wiley", error);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().then((win) => { mainWindow = win; });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  disposeIpc?.();
  voice?.close();
  canvas?.failPending("Application is closing");
  void pi?.dispose();
  ledger?.close();
});

// dispose() is asynchronous and quitting does not wait for it, so this is the
// sweep that guarantees no worker process group outlives the app.
process.on("exit", () => pi?.killWorkersSync());
