import "dotenv/config";
import { app, BrowserWindow, net, protocol, session } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteRuntimeLedger } from "./ledger";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";
import { VoiceBridge } from "./voice-bridge";
import { PiRuntime } from "./pi-runtime";
import { RuntimeController } from "./runtime-controller";
import { registerIpc } from "./ipc";

let mainWindow: BrowserWindow | undefined;
let pi: PiRuntime | undefined;
let ledger: SqliteRuntimeLedger | undefined;
let disposeIpc: (() => void) | undefined;

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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

function isTrustedOrigin(url: string): boolean {
  return url.startsWith("wiley://app/") || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(url);
}

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
  ledger = new SqliteRuntimeLedger(
    process.env.BOARD_AI_DATA_DIR
      ? path.join(process.env.BOARD_AI_DATA_DIR, "runtime.sqlite")
      : path.join(app.getPath("userData"), "runtime.sqlite"),
  );
  await ledger.initialize();
  const transcript = new TranscriptStore(ledger);
  const canvas = new CanvasBridge(
    ledger,
    (request) => sendToRenderer("canvas:request", request),
    (transaction) => sendToRenderer("board:transaction", transaction),
  );
  const voice = new VoiceBridge((message) => sendToRenderer("voice:inject", message));
  canvas.onHumanChange = (summary) => voice.pushBoardUpdate(summary);
  pi = new PiRuntime(process.env.BOARD_AI_PROJECT_DIR ?? process.cwd(), ledger, transcript, canvas, voice);
  await pi.initialize();
  const runtime = new RuntimeController(ledger, transcript, pi, canvas, sendToRenderer);
  await runtime.recoverInterruptedJobs();
  disposeIpc = registerIpc({ runtime, transcript, canvas, voice, ledger, pi });
  mainWindow = await createWindow();
  mainWindow.on("closed", () => {
    canvas.failPending();
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
  void pi?.dispose();
  ledger?.close();
});
