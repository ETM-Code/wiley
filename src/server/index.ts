import "dotenv/config";

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { CanvasBridge } from "../main/canvas-bridge";
import {
  IPC,
  type BoardSnapshot,
  type CanvasResponse,
  type RuntimeConfig,
  type TranscriptRole,
  type VoiceToolName,
} from "../shared/contracts";
import { env } from "../shared/env";
import { SqliteRuntimeLedger } from "../main/ledger";
import { PiRuntime } from "../main/pi-runtime";
import { RuntimeController } from "../main/runtime-controller";
import { resolveSkillsDir } from "../main/skills";
import { TranscriptStore } from "../main/transcript";
import { VoiceBridge } from "../main/voice-bridge";
import { callVoiceTool } from "../main/voice-tools";
import { mintConfiguredVoiceToken } from "../main/cloud/cloud-mode";
import { testCloudConnection } from "../main/cloud/cloud-account";
import { createSecretStore, isLoopbackHost } from "../main/settings/secret-store";
import { assertSecretName, SettingsService } from "../main/settings/settings-service";
import { resolveConfigDir, SettingsStore } from "../main/settings/settings-store";
import { createWorkerProbes } from "../main/workers/worker-runtime";
import { isCliWorkerKind } from "../main/workers/worker-types";

const host = env("HOST")?.trim() || "127.0.0.1";
const port = Number(env("PORT")?.trim() || 5174);
const projectDir = env("PROJECT_DIR")?.trim() || process.cwd();
const dataDir = env("DATA_DIR")?.trim() || defaultDataDir(projectDir);

/**
 * New workspaces get .wiley. One that already holds a .board-ai from before the
 * rename keeps using it, so an existing board and its ledger do not silently
 * vanish behind a fresh empty directory.
 */
function defaultDataDir(project: string): string {
  const current = path.join(project, ".wiley");
  if (existsSync(current)) return current;
  const legacy = path.join(project, ".board-ai");
  return existsSync(legacy) ? legacy : current;
}

type EventEnvelope = {
  sequence: number;
  channel: string;
  payload: unknown;
  targetClientId?: string;
};

type EventWaiter = {
  after: number;
  clientId: string;
  resolve: (events: EventEnvelope[]) => void;
  timer: NodeJS.Timeout;
};

class EventHub {
  #sequence = 0;
  #events: EventEnvelope[] = [];
  #waiters = new Set<EventWaiter>();
  #lastPoll = new Map<string, number>();
  #delivered = new Map<string, number>();

  get sequence(): number {
    return this.#sequence;
  }

  get latestClientId(): string | undefined {
    return [...this.#lastPoll.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  hasRecentClient(clientId?: string): boolean {
    if (!clientId) return false;
    return Date.now() - (this.#lastPoll.get(clientId) ?? 0) < 30_000;
  }

  publish(channel: string, payload: unknown, targetClientId?: string): boolean {
    const event: EventEnvelope = { sequence: ++this.#sequence, channel, payload, targetClientId };
    this.#events.push(event);
    if (this.#events.length > 1_000) this.#events.splice(0, this.#events.length - 1_000);
    for (const waiter of [...this.#waiters]) {
      if (event.sequence <= waiter.after) continue;
      this.#finish(waiter);
    }
    return targetClientId ? this.hasRecentClient(targetClientId) : Boolean(this.latestClientId);
  }

  wait(after: number | "latest", clientId: string, timeoutMs = 20_000): Promise<EventEnvelope[]> {
    this.#lastPoll.set(clientId, Date.now());
    const requested = after === "latest" || after > this.#sequence ? this.#sequence : Math.max(0, after);
    const cursor = Math.max(requested, this.#delivered.get(clientId) ?? 0);
    const ready = this.#forClient(cursor, clientId);
    if (ready.length > 0) {
      this.#delivered.set(clientId, this.#sequence);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      const waiter: EventWaiter = {
        after: cursor,
        clientId,
        resolve,
        timer: setTimeout(() => this.#finish(waiter), timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #forClient(after: number, clientId: string): EventEnvelope[] {
    return this.#events.filter(
      (event) => event.sequence > after && (!event.targetClientId || event.targetClientId === clientId),
    );
  }

  #finish(waiter: EventWaiter): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    const events = this.#forClient(waiter.after, waiter.clientId);
    this.#delivered.set(waiter.clientId, this.#sequence);
    waiter.resolve(events);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    // Board snapshots and canvas responses may carry base64 image files.
    if (size > 24_000_000) throw new Error("Request body exceeds 24 MB");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

await mkdir(dataDir, { recursive: true });
const configDir = resolveConfigDir({ env: process.env, home: os.homedir() });
const settingsStore = SettingsStore.open(
  configDir,
  createSecretStore({
    dir: configDir,
    host,
    allowRemoteHost: process.env.WILEY_ALLOW_REMOTE_SECRETS === "1",
  }),
);
const hub = new EventHub();
const ledger = new SqliteRuntimeLedger(path.join(dataDir, "runtime.sqlite"));
await ledger.initialize();
const transcript = new TranscriptStore(ledger);
let activeCanvasClientId: string | undefined;
const canvas = new CanvasBridge(
  ledger,
  (request) => {
    // Keep every open renderer mirror in sync. The first response resolves the
    // request; later identical responses are ignored by CanvasBridge. Human
    // snapshots remain restricted to the explicitly active tab below.
    if (!hub.latestClientId) return false;
    return hub.publish(IPC.canvasRequest, request);
  },
);
const voice = new VoiceBridge((message) => hub.publish(IPC.voiceInject, message));
canvas.onHumanChange = (summary) => voice.pushBoardUpdate(summary);
const pi = new PiRuntime(
  projectDir,
  ledger,
  transcript,
  canvas,
  voice,
  resolveSkillsDir({ isPackaged: false, appRoot: projectDir }),
  settingsStore,
  dataDir,
);
await pi.initialize();
const settings = new SettingsService({
  store: settingsStore,
  modelRuntime: () => pi.modelRuntime,
  probeWorkers: createWorkerProbes(() => settingsStore.get()),
});
// The agent changes settings through exactly the service the panel uses, so a
// change it makes normalizes, persists, and broadcasts the same way.
pi.useSettingsService(settings);
const runtime = new RuntimeController(
  ledger,
  transcript,
  pi,
  canvas,
  (channel, payload) => hub.publish(channel, payload),
  settingsStore,
);
await runtime.recoverInterruptedJobs();
settingsStore.onChange(() => {
  void settings.view().then(
    (view) => hub.publish(IPC.settingsChanged, view),
    (error: unknown) => console.error("Could not broadcast the settings change", error),
  );
});

const voiceToolDeps = { runtime, canvas, voice, ledger, pi };

/**
 * A secret typed into a browser tab crosses the wire, so only a loopback peer
 * may write one unless the operator opted in. The store enforces the same rule
 * against its own bind address; this checks who is actually asking.
 */
function assertLocalSecretWrite(request: IncomingMessage): void {
  if (process.env.WILEY_ALLOW_REMOTE_SECRETS === "1") return;
  const remote = request.socket.remoteAddress ?? "";
  const normalized = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
  if (!isLoopbackHost(normalized)) throw new Error("Secrets can only be set from this machine");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/events/poll") {
      const clientId = String(request.headers["x-wiley-client-id"] ?? "").trim();
      if (!clientId) throw new Error("Missing browser client id");
      const rawAfter = url.searchParams.get("after") ?? "latest";
      const after = rawAfter === "latest" ? "latest" : Number(rawAfter);
      if (after !== "latest" && !Number.isSafeInteger(after)) throw new Error("Invalid event cursor");
      const events = await hub.wait(after, clientId);
      return sendJson(response, 200, { events, cursor: hub.sequence });
    }
    if (request.method === "GET" && url.pathname === "/api/runtime-config") {
      const config: RuntimeConfig = { voiceDisabled: process.env.VOICE_DISABLED === "1" };
      return sendJson(response, 200, config);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, runtime.getState());
    }
    if (request.method === "GET" && url.pathname === "/api/board-state") {
      return sendJson(response, 200, canvas.getSnapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      return sendJson(response, 200, await settings.view());
    }
    if (request.method === "POST" && url.pathname === "/api/voice-token") {
      return sendJson(response, 200, await mintConfiguredVoiceToken({
        settings: settings.settings,
        secrets: settingsStore.secrets,
        apiKey: settings.resolveApiKey().key,
      }));
    }

    const body = request.method === "POST" ? await readJson(request) : {};
    if (request.method === "POST" && url.pathname === "/api/microphone") {
      if (typeof body.enabled !== "boolean") throw new Error("enabled must be boolean");
      return sendJson(response, 200, runtime.setMicrophoneEnabled(body.enabled));
    }
    if (request.method === "POST" && url.pathname === "/api/client-active") {
      const clientId = String(request.headers["x-wiley-client-id"] ?? "").trim();
      if (!clientId) throw new Error("Missing browser client id");
      activeCanvasClientId = clientId;
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/transcript") {
      const role = body.role as TranscriptRole | undefined;
      if (!role || !["user", "assistant", "system"].includes(role) || typeof body.text !== "string") {
        throw new Error("Invalid transcript entry");
      }
      return sendJson(response, 200, await transcript.append(role, body.text));
    }
    if (request.method === "POST" && url.pathname === "/api/tool") {
      if (typeof body.name !== "string") throw new Error("Tool name is required");
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? body.args as Record<string, unknown>
        : {};
      return sendJson(response, 200, await callVoiceTool(voiceToolDeps, body.name as VoiceToolName, args));
    }
    if (request.method === "POST" && url.pathname === "/api/board-snapshot") {
      const clientId = String(request.headers["x-wiley-client-id"] ?? "").trim();
      // Only the tab that explicitly announced itself as visible/focused may
      // author the canonical board. Background tabs still receive events, but
      // their passive Excalidraw onChange callbacks must never steal ownership
      // or overwrite the active scene.
      if (clientId && activeCanvasClientId && clientId !== activeCanvasClientId) {
        return sendJson(response, 200, canvas.getSnapshot());
      }
      return sendJson(response, 200, await canvas.submitHumanSnapshot(body as unknown as BoardSnapshot));
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      return sendJson(response, 200, await settings.update(body));
    }
    if (request.method === "POST" && url.pathname === "/api/settings/secret") {
      assertLocalSecretWrite(request);
      const name = assertSecretName(body.name);
      if (body.clear === true) return sendJson(response, 200, await settings.clearSecret(name));
      if (typeof body.value !== "string" || !body.value.trim()) throw new Error("A secret value is required");
      return sendJson(response, 200, await settings.setSecret(name, body.value));
    }
    if (request.method === "POST" && url.pathname === "/api/settings/probe") {
      return sendJson(response, 200, await settings.probeWorkers());
    }
    // The relay is reached from here, never from the tab: the renderer's
    // connect-src stays pinned to OpenAI and knows nothing about a relay.
    if (request.method === "POST" && url.pathname === "/api/cloud/test") {
      return sendJson(response, 200, await testCloudConnection(settings));
    }
    // The backend runs on the same machine as the browser tab, so opening a
    // terminal from here puts it on the user's own desktop, as it should.
    if (request.method === "POST" && url.pathname === "/api/workers/open-terminal") {
      if (typeof body.workerId !== "string" || !body.workerId.trim()) throw new Error("A worker id is required");
      return sendJson(response, 200, await pi.openWorkerTerminal(body.workerId.trim()));
    }
    if (request.method === "POST" && url.pathname === "/api/workers/new-terminal-session") {
      if (!isCliWorkerKind(body.kind)) throw new Error("kind must be claude or codex");
      return sendJson(response, 200, await pi.startTerminalSession(body.kind));
    }
    if (request.method === "POST" && url.pathname === "/api/canvas-response") {
      canvas.acceptResponse(body as unknown as CanvasResponse);
      return sendJson(response, 200, { ok: true });
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Browser API request failed", error);
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Wiley browser backend listening on http://${host}:${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  voice.close();
  canvas.failPending();
  await pi.dispose();
  ledger.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
// Nothing asynchronous survives here, so this is the sweep that guarantees a
// crash or a hard exit does not leave a worker running against a dead session.
process.on("exit", () => pi.killWorkersSync());
