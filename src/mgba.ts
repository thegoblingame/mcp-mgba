import net from "node:net";

export interface RpcRequest { id: number; method: string; params?: Record<string, unknown> }
export interface RpcResponse { id: number | null; result?: unknown; error?: { code: number; message: string } }
export type Delivery = "not_sent" | "unknown";

/** No request is retried. `unknown` means bytes may have reached the bridge. */
export class MgbaError extends Error {
  constructor(
    readonly code: "CONNECT_FAILED" | "CONNECT_TIMEOUT" | "RPC_TIMEOUT" | "DISCONNECTED" | "CANCELLED" | "PROTOCOL_ERROR" | "RPC_ERROR" | "INVALID_REQUEST",
    readonly delivery: Delivery,
    readonly generation: number | null,
    message?: string,
  ) {
    super(message ?? `mGBA bridge ${code.toLowerCase().replaceAll("_", " ")} (${delivery})`);
    this.name = "MgbaError";
  }
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Require the existing connection; never reconnect across a preflight. */
  generation?: number;
}
export interface MgbaClientOptions {
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  maxResponseBytes?: number;
  strictResponses?: boolean;
  /** Dependency injection for deterministic connection-timeout tests. */
  createConnection?: typeof net.createConnection;
}
interface Pending { finish: (error?: MgbaError, result?: unknown) => void }
interface Connection {
  socket: net.Socket;
  generation: number;
  ready: boolean;
  ended: boolean;
  buffer: string;
  pending: Map<number, Pending>;
  promise: Promise<void>;
  finishConnect: (error?: MgbaError) => void;
}

export class MgbaClient {
  private current: Connection | null = null;
  private nextId = 1;
  private nextGeneration = 1;
  private readonly connectTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly strictResponses: boolean;
  private readonly createConnection: typeof net.createConnection;
  private readonly disconnectListeners = new Set<(generation: number) => void>();

  constructor(private readonly host = "127.0.0.1", private readonly port = 8765, options: MgbaClientOptions = {}) {
    // Full server's synchronous frame/search operations need generous defaults.
    // The vision profile opts into substantially smaller limits.
    this.connectTimeoutMs = positive(options.connectTimeoutMs ?? 5000);
    this.rpcTimeoutMs = positive(options.rpcTimeoutMs ?? 120_000);
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 32 * 1024 * 1024);
    this.strictResponses = options.strictResponses ?? false;
    this.createConnection = options.createConnection ?? net.createConnection;
  }

  get connected(): boolean { return !!this.current?.ready && !this.current.ended; }
  get generation(): number | null { return this.connected ? this.current!.generation : null; }
  onDisconnect(listener: (generation: number) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async connect(options: Pick<CallOptions, "signal" | "timeoutMs"> = {}): Promise<void> {
    if (options.signal?.aborted) throw new MgbaError("CANCELLED", "not_sent", null);
    const state = this.current ?? this.open();
    if (state.ready) return;
    // Cancelling one waiter does not cancel another caller's shared connection.
    await bounded(state.promise, options.timeoutMs ?? this.connectTimeoutMs, options.signal,
      () => new MgbaError("CONNECT_TIMEOUT", "not_sent", state.generation),
      () => new MgbaError("CANCELLED", "not_sent", state.generation));
  }

  disconnect(): void { if (this.current) this.end(this.current, "DISCONNECTED"); }

  async call<T = unknown>(method: string, params?: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
    const timeoutMs = positive(options.timeoutMs ?? this.rpcTimeoutMs);
    const deadline = performance.now() + timeoutMs;
    if (options.signal?.aborted) throw new MgbaError("CANCELLED", "not_sent", this.generation);
    const id = this.nextId++;
    let message: string;
    try { message = JSON.stringify({ id, method, params: params ?? {} }) + "\n"; }
    catch { throw new MgbaError("INVALID_REQUEST", "not_sent", this.generation); }
    if (options.generation === undefined) await this.connect({ signal: options.signal, timeoutMs });
    const state = this.current;
    if (!state?.ready || state.ended || (options.generation !== undefined && state.generation !== options.generation)) {
      throw new MgbaError("DISCONNECTED", "not_sent", options.generation ?? null);
    }
    if (options.signal?.aborted) throw new MgbaError("CANCELLED", "not_sent", state.generation);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new MgbaError("RPC_TIMEOUT", "not_sent", state.generation);
    return new Promise<T>((resolve, reject) => {
      let sent = false;
      let settled = false;
      const finish = (error?: MgbaError, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        state.pending.delete(id);
        if (error) reject(error); else resolve(result as T);
      };
      const fail = (code: MgbaError["code"]) => finish(new MgbaError(code, sent ? "unknown" : "not_sent", state.generation));
      const abort = () => fail("CANCELLED");
      const timer = setTimeout(() => fail("RPC_TIMEOUT"), remaining);
      state.pending.set(id, { finish });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      try {
        sent = true; // A write exception may follow partial delivery.
        state.socket.write(message, error => { if (error) fail("DISCONNECTED"); });
      } catch { fail("DISCONNECTED"); }
    });
  }

  private open(): Connection {
    const generation = this.nextGeneration++;
    let socket: net.Socket;
    try { socket = this.createConnection({ host: this.host, port: this.port }); }
    catch { throw new MgbaError("CONNECT_FAILED", "not_sent", generation); }
    let resolve!: () => void;
    let reject!: (error: MgbaError) => void;
    let connectDone = false;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    void promise.catch(() => {}); // All callers may have cancelled their waits.
    const timer = setTimeout(() => this.end(state, "CONNECT_TIMEOUT"), this.connectTimeoutMs);
    const state: Connection = {
      socket, generation, ready: false, ended: false, buffer: "", pending: new Map(), promise,
      finishConnect: error => {
        if (connectDone) return;
        connectDone = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      },
    };
    this.current = state;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (state.ended) return;
      state.ready = true;
      state.finishConnect();
    });
    socket.on("error", () => this.end(state, state.ready ? "DISCONNECTED" : "CONNECT_FAILED"));
    socket.on("close", () => this.end(state, "DISCONNECTED"));
    socket.on("data", (chunk: string) => this.receive(state, chunk));
    return state;
  }

  private end(state: Connection, code: MgbaError["code"]): void {
    if (state.ended) return;
    state.ended = true;
    state.finishConnect(new MgbaError(code, "not_sent", state.generation));
    state.buffer = "";
    for (const request of state.pending.values()) request.finish(new MgbaError(code, "unknown", state.generation));
    state.pending.clear();
    if (this.current === state) this.current = null;
    state.socket.destroy();
    for (const listener of this.disconnectListeners) listener(state.generation);
  }

  private receive(state: Connection, chunk: string): void {
    if (state.ended || this.current !== state) return;
    state.buffer += chunk;
    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxResponseBytes) { this.end(state, "PROTOCOL_ERROR"); return; }
      if (!line) continue;
      let response: RpcResponse;
      try {
        response = JSON.parse(line);
        if (!response || typeof response !== "object" || !Number.isSafeInteger(response.id)) throw new Error();
        const hasResult = Object.hasOwn(response, "result");
        const hasError = Object.hasOwn(response, "error");
        if (hasResult && hasError) throw new Error();
        if (this.strictResponses && !hasResult && !hasError) throw new Error();
        if (hasError && (!response.error || typeof response.error !== "object" ||
          !Number.isSafeInteger(response.error.code) || typeof response.error.message !== "string")) throw new Error();
      } catch { this.end(state, "PROTOCOL_ERROR"); return; }
      const pending = state.pending.get(response.id!);
      if (!pending) continue; // Late/duplicate responses never satisfy another call.
      if (response.error) pending.finish(new MgbaError("RPC_ERROR", "unknown", state.generation,
        `mGBA RPC error [${response.error.code}]: ${response.error.message}`));
      else pending.finish(undefined, response.result);
    }
    if (Buffer.byteLength(state.buffer, "utf8") > this.maxResponseBytes) this.end(state, "PROTOCOL_ERROR");
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Expected a positive bounded integer");
  return value;
}

function bounded<T>(promise: Promise<T>, milliseconds: number, signal: AbortSignal | undefined,
  timeoutError: () => Error, abortError: () => Error): Promise<T> {
  positive(milliseconds);
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, result?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result as T);
    };
    const abort = () => finish(abortError());
    const timer = setTimeout(() => finish(timeoutError()), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(result => finish(undefined, result), error => finish(error));
  });
}
