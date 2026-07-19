import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { CanvasBridge } from "../main/canvas-bridge";
import { IPC, type BoardSnapshot, type CanvasResponse, type TranscriptRole, type VoiceToolName } from "../main/contracts";
import { SqliteRuntimeLedger } from "../main/ledger";
import { PiRuntime } from "../main/pi-runtime";
import { RuntimeController } from "../main/runtime-controller";
import { TranscriptStore } from "../main/transcript";
import { VoiceBridge } from "../main/voice-bridge";
import { callVoiceTool } from "../main/voice-tools";
import { mintRealtimeToken } from "../main/voice-token";

const host = process.env.BOARD_AI_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.BOARD_AI_PORT?.trim() || 5174);
const projectDir = process.env.BOARD_AI_PROJECT_DIR?.trim() || process.cwd();
const dataDir = process.env.BOARD_AI_DATA_DIR?.trim() || path.join(projectDir, ".board-ai");

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
  (transaction) => hub.publish(IPC.boardTransactions, transaction),
);
const voice = new VoiceBridge((message) => hub.publish(IPC.voiceInject, message));
canvas.onHumanChange = (summary) => voice.pushBoardUpdate(summary);
const pi = new PiRuntime(projectDir, ledger, transcript, canvas, voice);
await pi.initialize();
const runtime = new RuntimeController(ledger, transcript, pi, canvas, (channel, payload) => hub.publish(channel, payload));
await runtime.recoverInterruptedJobs();

const voiceToolDeps = { runtime, canvas, voice, ledger, pi };

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
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, runtime.getState());
    }
    if (request.method === "GET" && url.pathname === "/api/board-state") {
      return sendJson(response, 200, canvas.getSnapshot());
    }
    if (request.method === "POST" && url.pathname === "/api/voice-token") {
      return sendJson(response, 200, await mintRealtimeToken());
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
