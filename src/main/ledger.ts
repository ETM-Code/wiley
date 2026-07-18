import { mkdir, open, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  AgentEvent,
  BoardTransaction,
  BoardSnapshot,
  JobSummary,
  JsonlRecord,
  TranscriptEntry,
} from "./contracts";

export interface RuntimeLedger {
  initialize(): Promise<void>;
  appendTranscript(entry: Omit<TranscriptEntry, "id" | "sequence" | "at">): Promise<TranscriptEntry>;
  getTranscript(afterSequence?: number): TranscriptEntry[];
  appendAgentEvent(entry: Omit<AgentEvent, "id" | "sequence" | "at">): Promise<AgentEvent>;
  getAgentEvents(afterSequence?: number): AgentEvent[];
  putJob(job: JobSummary): Promise<void>;
  getJob(id: string): JobSummary | undefined;
  listJobs(): JobSummary[];
  appendBoardTransaction(transaction: BoardTransaction): Promise<void>;
  hasBoardTransaction(idempotencyKey: string): boolean;
  putBoardSnapshot(snapshot: BoardSnapshot): Promise<void>;
  getBoardSnapshot(): BoardSnapshot | undefined;
}

/**
 * An append-only JSONL ledger. Its interface intentionally maps one-to-one to
 * tables so it can be replaced by SQLite without changing the agent runtime.
 * Writes are serialized and fsynced before returning.
 */
export class JsonlRuntimeLedger implements RuntimeLedger {
  readonly #file: string;
  #writeTail: Promise<void> = Promise.resolve();
  #transcriptTail: Promise<unknown> = Promise.resolve();
  #eventTail: Promise<unknown> = Promise.resolve();
  #transcript: TranscriptEntry[] = [];
  #events: AgentEvent[] = [];
  #jobs = new Map<string, JobSummary>();
  #transactionKeys = new Set<string>();
  #boardSnapshot?: BoardSnapshot;

  constructor(file: string) {
    this.#file = file;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    let raw = "";
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.#replay(JSON.parse(line) as JsonlRecord);
      } catch (error) {
        // A crash may leave one partial final line. Earlier durable records are
        // still usable, so only ignore a malformed final record.
        if (line !== raw.trimEnd().split("\n").at(-1)) throw error;
      }
    }
  }

  async appendTranscript(
    entry: Omit<TranscriptEntry, "id" | "sequence" | "at">,
  ): Promise<TranscriptEntry> {
    const run = this.#transcriptTail.then(async () => {
      const value: TranscriptEntry = {
        ...entry,
        id: crypto.randomUUID(),
        sequence: (this.#transcript.at(-1)?.sequence ?? 0) + 1,
        at: new Date().toISOString(),
      };
      await this.#append({ kind: "transcript", at: value.at, data: value });
      this.#transcript.push(value);
      return value;
    });
    this.#transcriptTail = run.catch(() => undefined);
    return run;
  }

  getTranscript(afterSequence = 0): TranscriptEntry[] {
    return this.#transcript
      .filter((entry) => entry.sequence > afterSequence)
      .map((entry) => structuredClone(entry));
  }

  async appendAgentEvent(
    entry: Omit<AgentEvent, "id" | "sequence" | "at">,
  ): Promise<AgentEvent> {
    const run = this.#eventTail.then(async () => {
      const value: AgentEvent = {
        ...entry,
        id: crypto.randomUUID(),
        sequence: (this.#events.at(-1)?.sequence ?? 0) + 1,
        at: new Date().toISOString(),
      };
      await this.#append({ kind: "agent_event", at: value.at, data: value });
      this.#events.push(value);
      return value;
    });
    this.#eventTail = run.catch(() => undefined);
    return run;
  }

  getAgentEvents(afterSequence = 0): AgentEvent[] {
    return this.#events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  async putJob(job: JobSummary): Promise<void> {
    await this.#append({ kind: "job", at: new Date().toISOString(), data: job });
    this.#jobs.set(job.id, structuredClone(job));
  }

  getJob(id: string): JobSummary | undefined {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  listJobs(): JobSummary[] {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  async appendBoardTransaction(transaction: BoardTransaction): Promise<void> {
    await this.#append({
      kind: "board_transaction",
      at: new Date().toISOString(),
      data: transaction,
    });
    this.#transactionKeys.add(transaction.idempotencyKey);
  }

  hasBoardTransaction(idempotencyKey: string): boolean {
    return this.#transactionKeys.has(idempotencyKey);
  }

  async putBoardSnapshot(snapshot: BoardSnapshot): Promise<void> {
    await this.#append({ kind: "board_snapshot", at: new Date().toISOString(), data: snapshot });
    this.#boardSnapshot = structuredClone(snapshot);
  }

  getBoardSnapshot(): BoardSnapshot | undefined {
    return this.#boardSnapshot ? structuredClone(this.#boardSnapshot) : undefined;
  }

  async #append(record: JsonlRecord): Promise<void> {
    const run = this.#writeTail.then(async () => {
      const handle = await open(this.#file, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#writeTail = run.catch(() => undefined);
    return run;
  }

  #replay(record: JsonlRecord): void {
    switch (record.kind) {
      case "transcript":
        this.#transcript.push(record.data as TranscriptEntry);
        break;
      case "agent_event":
        this.#events.push(record.data as AgentEvent);
        break;
      case "job": {
        const job = record.data as JobSummary;
        this.#jobs.set(job.id, job);
        break;
      }
      case "board_transaction":
        this.#transactionKeys.add((record.data as BoardTransaction).idempotencyKey);
        break;
      case "board_snapshot":
        this.#boardSnapshot = structuredClone(record.data as BoardSnapshot);
        break;
    }
  }
}

/** Production ledger with WAL durability and unique idempotency keys. */
export class SqliteRuntimeLedger implements RuntimeLedger {
  #db?: DatabaseSync;

  constructor(private readonly file: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS transcript (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        job_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        parent_agent_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_transactions (
        idempotency_key TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_snapshot (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    this.#db = db;
  }

  async appendTranscript(
    entry: Omit<TranscriptEntry, "id" | "sequence" | "at">,
  ): Promise<TranscriptEntry> {
    const value = { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() };
    const result = this.#requireDb()
      .prepare("INSERT INTO transcript (id, at, role, text) VALUES (?, ?, ?, ?)")
      .run(value.id, value.at, value.role, value.text);
    return { ...value, sequence: Number(result.lastInsertRowid) };
  }

  getTranscript(afterSequence = 0): TranscriptEntry[] {
    return this.#requireDb()
      .prepare("SELECT sequence, id, at, role, text FROM transcript WHERE sequence > ? ORDER BY sequence")
      .all(afterSequence)
      .map((row) => ({
        sequence: Number(row.sequence),
        id: String(row.id),
        at: String(row.at),
        role: String(row.role) as TranscriptEntry["role"],
        text: String(row.text),
      }));
  }

  async appendAgentEvent(
    entry: Omit<AgentEvent, "id" | "sequence" | "at">,
  ): Promise<AgentEvent> {
    const value = { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() };
    const result = this.#requireDb().prepare(`
      INSERT INTO agent_events (id, at, job_id, agent_id, parent_agent_id, type, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.id,
      value.at,
      value.jobId,
      value.agentId,
      value.parentAgentId ?? null,
      value.type,
      JSON.stringify(value.payload),
    );
    return { ...value, sequence: Number(result.lastInsertRowid) };
  }

  getAgentEvents(afterSequence = 0): AgentEvent[] {
    return this.#requireDb()
      .prepare(`
        SELECT sequence, id, at, job_id, agent_id, parent_agent_id, type, payload
        FROM agent_events WHERE sequence > ? ORDER BY sequence
      `)
      .all(afterSequence)
      .map((row) => ({
        sequence: Number(row.sequence),
        id: String(row.id),
        at: String(row.at),
        jobId: String(row.job_id),
        agentId: String(row.agent_id),
        parentAgentId: row.parent_agent_id == null ? undefined : String(row.parent_agent_id),
        type: String(row.type) as AgentEvent["type"],
        payload: JSON.parse(String(row.payload)) as unknown,
      }));
  }

  async putJob(job: JobSummary): Promise<void> {
    this.#requireDb().prepare(`
      INSERT INTO jobs (id, updated_at, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
    `).run(job.id, job.updatedAt, JSON.stringify(job));
  }

  getJob(id: string): JobSummary | undefined {
    const row = this.#requireDb().prepare("SELECT data FROM jobs WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.data)) as JobSummary : undefined;
  }

  listJobs(): JobSummary[] {
    return this.#requireDb()
      .prepare("SELECT data FROM jobs ORDER BY updated_at")
      .all()
      .map((row) => JSON.parse(String(row.data)) as JobSummary);
  }

  async appendBoardTransaction(transaction: BoardTransaction): Promise<void> {
    this.#requireDb().prepare(`
      INSERT OR IGNORE INTO board_transactions (idempotency_key, at, data) VALUES (?, ?, ?)
    `).run(transaction.idempotencyKey, new Date().toISOString(), JSON.stringify(transaction));
  }

  hasBoardTransaction(idempotencyKey: string): boolean {
    return Boolean(
      this.#requireDb()
        .prepare("SELECT 1 AS found FROM board_transactions WHERE idempotency_key = ?")
        .get(idempotencyKey),
    );
  }

  async putBoardSnapshot(snapshot: BoardSnapshot): Promise<void> {
    this.#requireDb().prepare(`
      INSERT INTO board_snapshot (singleton, revision, data) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, data = excluded.data
    `).run(snapshot.revision, JSON.stringify(snapshot));
  }

  getBoardSnapshot(): BoardSnapshot | undefined {
    const row = this.#requireDb().prepare("SELECT data FROM board_snapshot WHERE singleton = 1").get();
    return row ? JSON.parse(String(row.data)) as BoardSnapshot : undefined;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  #requireDb(): DatabaseSync {
    if (!this.#db) throw new Error("Ledger is not initialized");
    return this.#db;
  }
}
