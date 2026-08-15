import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  AgentEvent,
  BoardTransaction,
  BoardSnapshot,
  JobSummary,
  TranscriptEntry,
} from "../shared/contracts";

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
  close(): void;
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
