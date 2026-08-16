import "dotenv/config";
import { app, BrowserWindow, dialog, Menu, nativeTheme, net, protocol, safeStorage, session } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteRuntimeLedger } from "./ledger";
import { TranscriptStore } from "./transcript";
import { CanvasBridge } from "./canvas-bridge";
import { VoiceBridge } from "./voice-bridge";
import { PiRuntime } from "./pi-runtime";
import { RuntimeController } from "./runtime-controller";
import { appMenuTemplate } from "./app-menu";
import { chooseProjectDirectory, registerIpc, type RuntimeHandles } from "./ipc";
import { IPC, type ProjectView } from "../shared/contracts";
import { env } from "../shared/env";
import { isTrustedOrigin } from "./trusted-origin";
import { resolveSkillsDir } from "./skills";
import { resolvePackagedPath, sweepStaleHandoffs } from "./host-environment";
import {
  adoptGlobalLedger,
  buildProjectView,
  projectDataDir,
  projectName,
  resolveLaunchProject,
  toProjectPath,
} from "./projects";
import { createSecretStore } from "./settings/secret-store";
import { SettingsService } from "./settings/settings-service";
import { SettingsStore } from "./settings/settings-store";
import { recordRecentProject } from "./settings/settings-schema";
import { createWorkerProbes } from "./workers/worker-runtime";

let mainWindow: BrowserWindow | undefined;
/** Everything bound to the open project, or nothing while the picker is up. */
let active: RuntimeHandles | undefined;
let disposeIpc: (() => void) | undefined;
let settingsStore: SettingsStore | undefined;
let settingsService: SettingsService | undefined;
let skillsDir: string | undefined;
/** Where the pre-project global ledger lived, and still lives as a .bak. */
let legacyDataDir: string | undefined;

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

/** Which project this is, so two open Wileys are not the same window twice. */
function windowTitle(): string {
  return active ? `Wiley — ${projectName(active.projectDir)}` : "Wiley";
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: windowBackgroundColor(),
    title: windowTitle(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The page's own <title> would otherwise win, and with it the project name
  // in the title bar would last only until the renderer finished loading.
  win.on("page-title-updated", (event) => event.preventDefault());
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

function requireSettings(): SettingsStore {
  if (!settingsStore) throw new Error("Settings are not open yet");
  return settingsStore;
}

/** The open project, the ones opened before it, and whether more can be opened. */
function projectView(): ProjectView {
  return buildProjectView({
    current: active?.projectDir,
    recent: requireSettings().get().recentProjects,
    canOpen: true,
  });
}

/**
 * Builds everything a project needs, in the order it needs it. Nothing here
 * outlives the project: the ledger, the board, the voice bridge and the Pi
 * runtime are all rebuilt against the new folder when the user switches, which
 * is what makes the catastrophic-command guard and the worker sandbox point at
 * the project actually open rather than the one opened at launch.
 */
async function startRuntime(projectDir: string): Promise<void> {
  const settings = requireSettings();
  const dataDir = env("DATA_DIR")?.trim() || projectDataDir(projectDir);
  if (legacyDataDir) {
    const adopted = adoptGlobalLedger({ legacyDir: legacyDataDir, dataDir });
    if (adopted) {
      console.log(`Adopted the previous shared ledger into ${adopted.to}; the original is kept at ${adopted.backup}`);
    }
  }
  const ledger = new SqliteRuntimeLedger(path.join(dataDir, "runtime.sqlite"));
  await ledger.initialize();
  const transcript = new TranscriptStore(ledger);
  const canvas = new CanvasBridge(ledger, (request) => sendToRenderer(IPC.canvasRequest, request));
  const voice = new VoiceBridge((message) => sendToRenderer(IPC.voiceInject, message));
  canvas.onHumanChange = (summary) => voice.pushBoardUpdate(summary);
  const pi = new PiRuntime(projectDir, ledger, transcript, canvas, voice, skillsDir, settings, dataDir);
  await pi.initialize();
  // The agent changes settings through exactly the service the panel uses, so
  // a change it makes normalizes, persists, and broadcasts the same way.
  if (settingsService) pi.useSettingsService(settingsService);
  const controller = new RuntimeController(ledger, transcript, pi, canvas, sendToRenderer, settings);
  await controller.recoverInterruptedJobs();
  active = { projectDir, controller, transcript, canvas, voice, ledger, pi };
  console.log(`Workspace: ${projectDir} (data in ${dataDir})`);
}

/**
 * Winds the open project down completely. Awaiting the Pi runtime's disposal
 * is the part that matters: it kills every worker process group, and a worker
 * from the old project still writing files while a new one starts is exactly
 * the failure the project boundary exists to prevent.
 */
async function stopRuntime(): Promise<void> {
  const current = active;
  if (!current) return;
  active = undefined;
  current.controller.dispose();
  current.voice.close();
  current.canvas.failPending("Wiley is switching projects");
  await current.pi.dispose();
  current.ledger.close();
}

/**
 * Switches to a project without restarting the app: the old runtime is gone
 * before the new one exists, the registry records the opening, and the
 * renderer is told to drop the board it was showing and read the new
 * project's own.
 */
async function openProject(projectDir: string): Promise<ProjectView> {
  // The renderer keeps its microphone exactly where it was, so a controller
  // that came up believing nobody is listening would disagree with the window.
  const listening = active?.controller.getState().microphoneEnabled ?? false;
  await stopRuntime();
  await startRuntime(projectDir);
  if (listening) active?.controller.setMicrophoneEnabled(true);
  const settings = requireSettings();
  settings.update({
    lastProject: projectDir,
    recentProjects: recordRecentProject(settings.get().recentProjects, projectDir),
  });
  const view = projectView();
  mainWindow?.setTitle(windowTitle());
  installAppMenu();
  sendToRenderer(IPC.projectsChanged, view);
  return view;
}

function installAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(projectView(), {
    openProject: () => void promptForProject(),
    openRecent: (target) => void openProject(target).catch(reportProjectFailure),
  })));
}

/** Asks for a folder and opens it. Cancelling leaves everything as it was. */
async function promptForProject(owner?: BrowserWindow): Promise<ProjectView> {
  const chosen = await chooseProjectDirectory(owner ?? mainWindow ?? null, active?.projectDir);
  if (!chosen) return projectView();
  return openProject(chosen);
}

function reportProjectFailure(error: unknown): void {
  console.error("Could not open the project", error);
  dialog.showErrorBox(
    "Wiley could not open that project",
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
}

async function bootstrap(): Promise<void> {
  installAppProtocol();
  installSecurityPolicy();
  const swept = sweepStaleHandoffs();
  if (swept > 0) console.log(`Removed ${swept} terminal handoff ${swept === 1 ? "directory" : "directories"} older than a week`);
  // Read directly, not through env(): WILEY_CONFIG_DIR points at saved secrets
  // and never had a board-ai spelling, so it gets no deprecated alias.
  const configDir = process.env.WILEY_CONFIG_DIR?.trim() || app.getPath("userData");
  settingsStore = SettingsStore.open(configDir, createSecretStore({ dir: configDir, safeStorage }));
  // Where every workspace's ledger used to live, before a project carried its
  // own. Only consulted to hand that history to the first project opened.
  legacyDataDir = app.getPath("userData");
  skillsDir = resolveSkillsDir({ isPackaged: app.isPackaged, appRoot: app.getAppPath() });
  // A packaged app inherits launchd's PATH, which knows about none of the
  // places a CLI actually gets installed. Ask the user's login shell before
  // anything spawns a worker.
  if (app.isPackaged) {
    process.env.PATH = resolvePackagedPath({ currentPath: process.env.PATH, home: app.getPath("home") });
    console.log(`PATH for this run: ${process.env.PATH.split(path.delimiter).length} entries, ${process.env.PATH.length} characters`);
  }
  settingsService = new SettingsService({
    store: settingsStore,
    modelRuntime: () => active?.pi.modelRuntime,
    probeWorkers: createWorkerProbes(() => requireSettings().get()),
  });
  disposeIpc = registerIpc({
    runtime: () => active,
    projects: {
      view: projectView,
      open: (input, owner) => (input.path
        ? openProject(toProjectPath(input.path, app.getPath("home")) ?? input.path)
        : promptForProject(owner)),
    },
    settings: settingsService,
    sendToRenderer,
  });

  const launch = resolveLaunchProject({
    settings: settingsStore.get(),
    home: app.getPath("home"),
  });
  if (launch) await startRuntime(launch);
  installAppMenu();
  mainWindow = await createWindow();
  if (launch) {
    // Recorded after the window exists, so a project that fails to start is
    // never remembered as the one to reopen next time.
    requireSettings().update({
      lastProject: launch,
      recentProjects: recordRecentProject(requireSettings().get().recentProjects, launch),
    });
  } else {
    console.log("No project to reopen: the window opens on the project picker");
  }
  mainWindow.on("closed", () => {
    active?.canvas.failPending();
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
  const current = active;
  if (!current) return;
  current.controller.dispose();
  current.voice.close();
  current.canvas.failPending("Application is closing");
  void current.pi.dispose();
  current.ledger.close();
});

// dispose() is asynchronous and quitting does not wait for it, so this is the
// sweep that guarantees no worker process group outlives the app.
process.on("exit", () => active?.pi.killWorkersSync());
