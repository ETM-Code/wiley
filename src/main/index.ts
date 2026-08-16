import "dotenv/config";
import { app, BrowserWindow, dialog, nativeTheme, net, protocol, safeStorage, session } from "electron";
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
import { env } from "../shared/env";
import { isTrustedOrigin } from "./trusted-origin";
import { resolveSkillsDir } from "./skills";
import { resolvePackagedPath, resolveProjectDir, sweepStaleHandoffs } from "./host-environment";
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

/**
 * The renderer picks up the system appearance from prefers-color-scheme on its
 * own. This is only the colour the frame shows before the first paint, so it
 * has to be set here or a dark desktop gets a white flash on launch. Keep it in
 * step with --wiley-app-bg in the renderer stylesheet.
 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#121212" : "#ffffff";
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: windowBackgroundColor(),
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
  const followSystemAppearance = () => {
    if (!win.isDestroyed()) win.setBackgroundColor(windowBackgroundColor());
  };
  nativeTheme.on("updated", followSystemAppearance);
  win.on("closed", () => nativeTheme.off("updated", followSystemAppearance));
  if (env("DEBUG_RENDERER") === "1") {
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
  const swept = sweepStaleHandoffs();
  if (swept > 0) console.log(`Removed ${swept} terminal handoff ${swept === 1 ? "directory" : "directories"} older than a week`);
  // Read directly, not through env(): WILEY_CONFIG_DIR points at saved secrets
  // and never had a board-ai spelling, so it gets no deprecated alias.
  const configDir = process.env.WILEY_CONFIG_DIR?.trim() || app.getPath("userData");
  const settingsStore = SettingsStore.open(configDir, createSecretStore({ dir: configDir, safeStorage }));
  const dataDir = env("DATA_DIR")?.trim() || app.getPath("userData");
  ledger = new SqliteRuntimeLedger(path.join(dataDir, "runtime.sqlite"));
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
  const projectDir = resolveProjectDir({
    packaged: app.isPackaged,
    home: app.getPath("home"),
    configured: settingsStore.get().projectDir,
  });
  const skillsDir = resolveSkillsDir({ isPackaged: app.isPackaged, appRoot: app.getAppPath() });
  // A packaged app inherits launchd's PATH, which knows about none of the
  // places a CLI actually gets installed. Ask the user's login shell before
  // anything spawns a worker.
  if (app.isPackaged) {
    process.env.PATH = resolvePackagedPath({ currentPath: process.env.PATH, home: app.getPath("home") });
    console.log(`PATH for this run: ${process.env.PATH.split(path.delimiter).length} entries, ${process.env.PATH.length} characters`);
  }
  console.log(`Workspace: ${projectDir}`);
  pi = new PiRuntime(projectDir, ledger, transcript, canvasBridge, voiceBridge, skillsDir, settingsStore, dataDir);
  await pi.initialize();
  const settings = new SettingsService({
    store: settingsStore,
    modelRuntime: () => pi?.modelRuntime,
    probeWorkers: createWorkerProbes(() => settingsStore.get()),
  });
  // The agent changes settings through exactly the service the panel uses, so
  // a change it makes normalizes, persists, and broadcasts the same way.
  pi.useSettingsService(settings);
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
    // A packaged app has no terminal to print to, so a silent quit reads as
    // "it does not launch". Say what broke and where the two usual causes are.
    dialog.showErrorBox(
      "Wiley could not start",
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n` +
      "If this mentions an API key or authentication, open Settings and save your OpenAI key. " +
      "If it mentions a network or a host, check your connection and try again.",
    );
    app.quit();
    return;
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
