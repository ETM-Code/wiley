import type { BoardSnapshot, BoardTransaction, CanvasRequest, CanvasResponse } from "./contracts";
import type { RuntimeLedger } from "./ledger";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CanvasBridge {
  #sequence = 0;
  #previewRequestSequence = 0;
  #diagramPreviewVersion = 0;
  #pending = new Map<number, PendingRequest>();
  #snapshot: BoardSnapshot;
  #leases = new Map<string, { agentId: string; elementIds: Set<string>; expiresAt: number }>();

  constructor(
    private readonly ledger: RuntimeLedger,
    private readonly sendRequest: (request: CanvasRequest) => boolean | void,
    private readonly sendTransaction: (transaction: BoardTransaction) => void,
    private readonly timeoutMs = 15_000,
  ) {
    this.#snapshot = { revision: 0, elements: [], appState: {} };
    const persisted = ledger.getBoardSnapshot();
    if (persisted) {
      try {
        this.#validateSnapshot(persisted);
        this.#snapshot = structuredClone(persisted);
      } catch {
        // Never poison a new runtime with a scene that an older build allowed
        // to persist. The invalid row remains available for forensic recovery.
      }
    }
  }

  request<T = unknown>(op: CanvasRequest["op"], params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = ++this.#sequence;
    if (this.sendRequest({ id, op, params }) === false) {
      return Promise.reject(new Error("Canvas unavailable: no active browser client"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Canvas request aborted"));
      };
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`canvas ${op} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  previewDiagram(params: Record<string, unknown>): boolean {
    return this.sendRequest({
      id: -(++this.#previewRequestSequence),
      op: "preview-diagram",
      params: { ...params, __previewVersion: ++this.#diagramPreviewVersion },
    }) !== false;
  }

  clearDiagramPreview(): boolean {
    return this.sendRequest({
      id: -(++this.#previewRequestSequence),
      op: "clear-diagram-preview",
      params: { __previewVersion: ++this.#diagramPreviewVersion },
    }) !== false;
  }

  acceptResponse(response: CanvasResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  }

  async submitHumanSnapshot(snapshot: BoardSnapshot): Promise<BoardSnapshot> {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error(`Invalid board snapshot revision ${snapshot.revision}`);
    }
    this.#validateSnapshot(snapshot);
    const previous = new Map(this.#snapshot.elements.map((element) => [String(element.id ?? ""), JSON.stringify(element)]));
    const next = new Map(snapshot.elements.map((element) => [String(element.id ?? ""), JSON.stringify(element)]));
    const changedIds = new Set<string>();
    for (const [id, value] of next) if (previous.get(id) !== value) changedIds.add(id);
    for (const id of previous.keys()) if (!next.has(id)) changedIds.add(id);
    // The renderer may not yet know that an agent transaction advanced the
    // gateway revision. It is the authoritative source for the resulting
    // scene, so normalize its snapshot to the next canonical revision instead
    // of discarding correct content as stale.
    this.#snapshot = structuredClone({
      ...snapshot,
      revision: Math.max(snapshot.revision, this.#snapshot.revision + 1),
    });
    await this.ledger.putBoardSnapshot(this.#snapshot);
    for (const [id, lease] of this.#leases) {
      if ([...lease.elementIds].some((elementId) => changedIds.has(elementId))) this.#leases.delete(id);
    }
    return this.getSnapshot();
  }

  getSnapshot(): BoardSnapshot {
    return structuredClone(this.#snapshot);
  }

  acquireLease(agentId: string, elementIds: string[], ttlMs = 3_000): { id: string; expiresAt: number } {
    this.#expireLeases();
    const requested = new Set(elementIds);
    for (const lease of this.#leases.values()) {
      if (lease.agentId !== agentId && [...requested].some((id) => lease.elementIds.has(id))) {
        throw new Error("Canvas elements are currently being edited by another agent");
      }
    }
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.#leases.set(id, { agentId, elementIds: requested, expiresAt });
    return { id, expiresAt };
  }

  releaseLease(id: string, agentId?: string): void {
    const lease = this.#leases.get(id);
    if (lease && (!agentId || lease.agentId === agentId)) this.#leases.delete(id);
  }

  async applyTransaction(
    transaction: BoardTransaction,
    signal?: AbortSignal,
  ): Promise<{ revision: number; result?: unknown; duplicate?: true }> {
    this.#expireLeases();
    if (this.ledger.hasBoardTransaction(transaction.idempotencyKey)) {
      return { revision: this.#snapshot.revision, duplicate: true };
    }
    if (transaction.baseRevision !== this.#snapshot.revision) {
      throw new Error(
        `Board revision conflict: transaction=${transaction.baseRevision}, current=${this.#snapshot.revision}`,
      );
    }
    this.#validateLeaseOwnership(transaction);
    this.#validateTransaction(transaction);

    // Persist intent before the renderer receives a mutating request. If the
    // renderer crashes, replay is safe because idempotencyKey is durable.
    await this.ledger.appendBoardTransaction(transaction);
    this.sendTransaction(transaction);

    const requestParams = transaction.operation === "layout-diagram"
      ? { ...(transaction.params as Record<string, unknown>), __previewVersion: ++this.#diagramPreviewVersion }
      : transaction.params;
    const response = await this.request<Record<string, unknown>>(transaction.operation, requestParams, signal);
    const rendered = response.__boardSnapshot as Omit<BoardSnapshot, "revision"> | undefined;
    const result = { ...response };
    delete result.__boardSnapshot;
    if (rendered && Array.isArray(rendered.elements)) {
      const nextSnapshot = structuredClone({
        revision: this.#snapshot.revision + 1,
        elements: rendered.elements,
        appState: rendered.appState ?? {},
        files: rendered.files,
      });
      this.#validateSnapshot(nextSnapshot);
      this.#snapshot = nextSnapshot;
      await this.ledger.putBoardSnapshot(this.#snapshot);
    } else {
      this.#snapshot.revision += 1;
    }
    return { revision: this.#snapshot.revision, result };
  }

  failPending(reason = "Canvas renderer closed"): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #validateLeaseOwnership(transaction: BoardTransaction): void {
    for (const id of transaction.leaseIds ?? []) {
      const lease = this.#leases.get(id);
      if (!lease || lease.agentId !== transaction.agentId) {
        throw new Error(`Missing or expired canvas lease: ${id}`);
      }
    }
  }

  #validateTransaction(transaction: BoardTransaction): void {
    if (!transaction.id || !transaction.idempotencyKey || !transaction.agentId) {
      throw new Error("Canvas transaction is missing identity fields");
    }
    if (!transaction.params || typeof transaction.params !== "object") {
      throw new Error("Canvas transaction params must be an object");
    }
    const serialized = JSON.stringify(transaction.params);
    if (serialized.length > 2_000_000) throw new Error("Canvas transaction exceeds 2 MB");
    if (/\b(?:NaN|Infinity|-Infinity)\b/.test(serialized)) {
      throw new Error("Canvas transaction contains non-finite geometry");
    }
  }

  #validateSnapshot(snapshot: BoardSnapshot): void {
    for (const element of snapshot.elements) {
      if (element.isDeleted === true) continue;
      for (const key of ["x", "y", "width", "height"] as const) {
        if (typeof element[key] !== "number" || !Number.isFinite(element[key])) {
          throw new Error(`Canvas element ${String(element.id ?? "unknown")} has invalid ${key}`);
        }
      }
    }
  }

  #expireLeases(): void {
    const now = Date.now();
    for (const [id, lease] of this.#leases) if (lease.expiresAt <= now) this.#leases.delete(id);
  }
}
