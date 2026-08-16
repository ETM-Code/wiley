import "dotenv/config";
import { app, BrowserWindow, dialog, Menu, nativeTheme, net, protocol, safeStorage, session } from "electron";
import { existsSync } from "node:fs";
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

/**
 * One project's runtime while it is being built. Every field is present by the
 * time it becomes the active one; they are optional here because a failure
 * part-way still has to tear down whatever did get made.
 */
type RuntimeParts = Partial<RuntimeHandles> & { projectDir: string };

let mainWindow: BrowserWindow | undefined;
/** Everything bound to the open project, or nothing while the picker is up. */
let active: RuntimeParts | undefined;
/**
 * Every runtime that still holds processes, including one part-way through
 * starting or stopping. The quit sweep reads this rather than the active one,
 * because quitting mid-switch is precisely when there is no active one.
 */
const liveRuntimes = new Set<RuntimeParts>();
/** The switch in flight, so a second one queues behind it instead of racing. */
let switching: Promise<void> = Promise.resolve();
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

  // Attached here rather than at the call site, so a window reopened from the
  // dock clears the reference too and nothing later talks to a destroyed one.
  win.on("closed", () => {
    active?.canvas?.failPending();
    if (mainWindow === win) mainWindow = undefined;
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

/** The open project's runtime, once every piece of it exists. */
function activeRuntime(): RuntimeHandles | undefined {
  if (!active?.controller || !active.transcript || !active.canvas) return undefined;
  if (!active.voice || !active.ledger || !active.pi) return undefined;
  return active as RuntimeHandles;
}

/** The open project, the ones opened before it, and whether more can be opened. */
function projectView(): ProjectView {
  return buildProjectView({
    current: active?.projectDir,
    recent: requireSettings().get().recentProjects,
    canOpen: true,
  });
}

/** Tears down whatever of a runtime exists, in the reverse order it was built. */
async function disposeParts(parts: RuntimeParts, reason: string): Promise<void> {
  try {
    parts.controller?.dispose();
    parts.voice?.close();
    parts.canvas?.failPending(reason);
    await parts.pi?.dispose();
    parts.ledger?.close();
  } finally {
    // Only after disposal has actually finished: until then this runtime still
    // holds worker process groups that the quit sweep has to be able to see.
    liveRuntimes.delete(parts);
  }
}

/**
 * Builds everything a project needs, in the order it needs it. Nothing here
 * outlives the project: the ledger, the board, the voice bridge and the Pi
 * runtime are all rebuilt against the new folder when the user switches, which
 * is what makes the catastrophic-command guard and the worker sandbox point at
 * the project actually open rather than the one opened at launch.
 *
 * A failure part-way leaves nothing behind. Pi starts its worker manager before
 * it finishes initializing, so an unwound half-built runtime is exactly how a
 * worker process group ends up with nobody left to kill it.
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
  const parts: RuntimeParts = { projectDir };
  liveRuntimes.add(parts);
  try {
    parts.ledger = new SqliteRuntimeLedger(path.join(dataDir, "runtime.sqlite"));
    await parts.ledger.initialize();
    parts.transcript = new TranscriptStore(parts.ledger);
    parts.canvas = new CanvasBridge(parts.ledger, (request) => sendToRenderer(IPC.canvasRequest, request));
    parts.voice = new VoiceBridge((message) => sendToRenderer(IPC.voiceInject, message));
    parts.canvas.onHumanChange = (summary) => parts.voice?.pushBoardUpdate(summary);
    parts.pi = new PiRuntime(
      projectDir, parts.ledger, parts.transcript, parts.canvas, parts.voice, skillsDir, settings, dataDir,
    );
    await parts.pi.initialize();
    // The agent changes settings through exactly the service the panel uses, so
    // a change it makes normalizes, persists, and broadcasts the same way.
    if (settingsService) parts.pi.useSettingsService(settingsService);
    parts.controller = new RuntimeController(
      parts.ledger, parts.transcript, parts.pi, parts.canvas, sendToRenderer, settings,
    );
    await parts.controller.recoverInterruptedJobs();
  } catch (error) {
    await disposeParts(parts, "Wiley could not open this project");
    throw error;
  }
  active = parts;
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
  await disposeParts(current, "Wiley is switching projects");
}

/**
 * Switches to a project without restarting the app: the old runtime is gone
 * before the new one exists, the registry records the opening, and the
 * renderer is told to drop the board it was showing and read the new
 * project's own.
 *
 * Serialized against itself. The menu, the picker and the chip can all ask at
 * once, and a second switch entering while the first is still killing workers
 * would leave that first runtime with no owner and its workers with nobody to
 * stop them.
 */
function openProject(target: string): Promise<ProjectView> {
  const next = switching.then(() => switchProject(target), () => switchProject(target));
  switching = next.then(() => undefined, () => undefined);
  return next;
}

async function switchProject(target: string): Promise<ProjectView> {
  const projectDir = toProjectPath(target, app.getPath("home"));
  // The same rule the launch path applies, at the boundary IPC can reach:
  // a project of "/" is always a mistake, however it was asked for.
  if (!projectDir) throw new Error(`${target || "That"} is not a folder Wiley can work in.`);
  if (!existsSync(projectDir)) throw new Error(`${projectDir} is no longer on disk.`);
  // The renderer keeps its microphone exactly where it was, so a controller
  // that came up believing nobody is listening would disagree with the window.
  const listening = active?.controller?.getState().microphoneEnabled ?? false;
  await stopRuntime();
  try {
    await startRuntime(projectDir);
  } catch (error) {
    // The previous project is already gone, so a window still showing its
    // board could do nothing at all with it. Send everyone back to the picker.
    announceProject();
    throw error;
  }
  if (listening) active?.controller?.setMicrophoneEnabled(true);
  const settings = requireSettings();
  settings.update({
    lastProject: projectDir,
    recentProjects: recordRecentProject(settings.get().recentProjects, projectDir),
  });
  return announceProject();
}

/** Tells the window, the title bar and the menu which project this now is. */
function announceProject(): ProjectView {
  const view = projectView();
  sendToRenderer(IPC.projectsChanged, view);
  mainWindow?.setTitle(windowTitle());
  installAppMenu();
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
    modelRuntime: () => active?.pi?.modelRuntime,
    probeWorkers: createWorkerProbes(() => requireSettings().get()),
  });
  disposeIpc = registerIpc({
    runtime: activeRuntime,
    projects: {
      view: projectView,
      open: (input, owner) => (input.path ? openProject(input.path) : promptForProject(owner)),
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
  active = undefined;
  for (const parts of [...liveRuntimes]) void disposeParts(parts, "Application is closing");
});

// dispose() is asynchronous and quitting does not wait for it, so this is the
// sweep that guarantees no worker process group outlives the app.
process.on("exit", () => {
  for (const parts of liveRuntimes) parts.pi?.killWorkersSync();
});
