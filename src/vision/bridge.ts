import { MgbaClient, MgbaError } from "../mgba.js";
import { submitButtons, submitSequence } from "../input.js";
import { LIMITS, VisionFault, normalizeBatch, normalizePress, validateArguments } from "./contracts.js";

export interface InputStatus { pending: number; queued: number; active: boolean }
export interface InputReceipt {
  input_state: "queued" | "drained";
  accepted_presses: number;
  requested_frames: number;
  queue_size: number;
  pending: number;
  game_acceptance: "not_verified";
}
export interface SessionInfo {
  connected: true;
  lease_version: 1;
  exclusive_controller: true;
  connection_generation: number;
  rom_loaded: boolean;
  title?: string;
  code?: string;
  frame?: number;
  platform?: number | string;
  capabilities: { screenshot: boolean; controller_input: boolean; frame_counter: boolean };
  expected_dimensions: { width: 240; height: 160 };
  input_status: InputStatus;
}
const RPC_ALLOWLIST = new Set(["vision_claim", "ping", "get_info", "input_status", "press_buttons", "press_sequence", "screenshot"]);
export interface VisionLifecycleEvent {
  event: "connected" | "disconnected" | "claimed" | "reclaimed" | "interrupted" | "closed";
  timestamp: string;
  generation: number | null;
}

/** Capability boundary: no public generic RPC, memory, reset, or file reads. */
export class VisionBridge {
  readonly #client: MgbaClient;
  #claimedGeneration: number | null = null;
  #pending = false;
  #sending = false;
  #reservedFrames = 0;
  #interruption: string | null = null;
  #closed = false;
  #everClaimed = false;
  readonly #onLifecycle?: (event: VisionLifecycleEvent) => void;
  #metadata: Omit<SessionInfo, "connected" | "lease_version" | "exclusive_controller" | "connection_generation" | "input_status"> | null = null;
  readonly #removeDisconnect: () => void;

  constructor(client: MgbaClient, onLifecycle?: (event: VisionLifecycleEvent) => void) {
    this.#client = client;
    this.#onLifecycle = onLifecycle;
    this.#removeDisconnect = client.onDisconnect(generation => {
      this.#emit("disconnected", generation);
      if (generation === this.#claimedGeneration && this.#pending) this.interrupt("Connection lost with input completion unverified.");
    });
  }
  get interrupted(): boolean { return this.#interruption !== null; }
  get inputState(): "not_sent" | "queued" | "unknown" { return this.interrupted ? "unknown" : this.#pending ? "queued" : "not_sent"; }
  interrupt(reason: string): void {
    if (this.#interruption) return;
    this.#interruption = reason;
    this.#emit("interrupted", this.#claimedGeneration);
  }
  cancelOperation(): void { if (this.#sending || this.#pending) this.interrupt("Operation ended before input completion could be verified."); }
  assertUsable(): void {
    if (this.#closed) throw new VisionFault("SESSION_CLOSED", "The vision session is closed.");
    if (this.#interruption) throw new VisionFault("TECHNICAL_INTERRUPTION", "Input completion is uncertain. Stop this attempt; only the operator may start a new attempt.", "unknown");
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.disconnect();
    this.#removeDisconnect();
    this.#emit("closed", this.#claimedGeneration);
  }

  async session(signal: AbortSignal): Promise<SessionInfo> {
    await this.#ensureClaim(signal);
    if (await this.#rpc("ping", {}, signal) !== "pong") throw badResponse();
    this.#metadata = sanitizeInfo(await this.#rpc("get_info", {}, signal));
    const status = await this.inputStatus(signal);
    return { connected: true, lease_version: 1, exclusive_controller: true,
      connection_generation: this.#claimedGeneration!, ...this.#metadata, input_status: status };
  }

  async pressButtons(args: Record<string, unknown>, signal: AbortSignal): Promise<InputReceipt> {
    const press = normalizePress(validateArguments("mgba_press_buttons", args));
    const frames = press.frames + press.release_frames;
    await this.#prepareInput(frames, signal);
    return this.#submit(async () => {
      const receipt = await submitButtons((method, params) => this.#rpc(method, params, signal), { ...press });
      if (!record(receipt) || receipt.queued !== true || !count(receipt.queue_size, 1)) throw badResponse();
      return { accepted_presses: 1, queue_size: receipt.queue_size };
    }, frames);
  }

  async pressSequence(args: Record<string, unknown>, signal: AbortSignal): Promise<InputReceipt> {
    const batch = normalizeBatch(validateArguments("mgba_press_sequence", args));
    await this.#prepareInput(batch.total_frames, signal);
    const receipt = await this.#submit(async () => {
      const result = await submitSequence((method, params) => this.#rpc(method, params, signal), { presses: batch.presses, frames: batch.frames, release_frames: batch.release_frames });
      if (!record(result) || result.queued !== batch.presses.length || result.frames !== batch.total_frames || !count(result.queue_size, batch.presses.length)) throw badResponse();
      return { accepted_presses: result.queued, queue_size: result.queue_size };
    }, batch.total_frames);
    if (!batch.wait) return receipt;
    const deadline = performance.now() + batch.timeout_ms;
    const drainTimeout = new AbortController();
    const timer = setTimeout(() => drainTimeout.abort(), batch.timeout_ms);
    const drainSignal = AbortSignal.any([signal, drainTimeout.signal]);
    try {
      for (;;) {
        const status = await this.inputStatus(drainSignal);
        if (status.pending === 0) return { ...receipt, input_state: "drained", pending: 0 };
        if (performance.now() >= deadline) throw new VisionFault("INPUT_DRAIN_TIMEOUT", "Accepted input did not reach a confirmed queue drain before the deadline.", "unknown");
        await delay(Math.min(LIMITS.pollMs, Math.max(1, deadline - performance.now())), drainSignal);
      }
    } catch (error) {
      this.interrupt("Accepted input could not be confirmed drained.");
      if (drainTimeout.signal.aborted) throw new VisionFault("INPUT_DRAIN_TIMEOUT", "Accepted input did not reach a confirmed queue drain before the deadline.", "unknown");
      if (error instanceof VisionFault) throw error;
      throw new VisionFault(error instanceof MgbaError ? error.code : "CANCELLED", "Input was accepted, but completion is uncertain. Do not replay it.", "unknown");
    } finally { clearTimeout(timer); }
  }

  async inputStatus(signal: AbortSignal): Promise<InputStatus> {
    this.assertUsable();
    const value = await this.#rpc("input_status", {}, signal);
    if (!record(value) || !count(value.pending) || !count(value.queued) || typeof value.active !== "boolean" || value.pending !== value.queued + (value.active ? 1 : 0)) {
      if (this.#pending) this.interrupt("Invalid input status after a submission.");
      throw badResponse(this.#pending ? "unknown" : "not_sent");
    }
    if (value.pending === 0) { this.#pending = false; this.#reservedFrames = 0; }
    else if (!this.#pending) {
      this.interrupt("Unexpected input queue in an exclusive session.");
      throw new VisionFault("UNEXPECTED_INPUT_QUEUE", "Unexpected queued input; do not clear or continue this session.", "unknown");
    }
    return { pending: value.pending, queued: value.queued, active: value.active };
  }

  /** Only future trusted capture code supplies a harness-generated path. */
  async captureTo(harnessPath: string, signal: AbortSignal): Promise<void> {
    await this.#ensureClaim(signal);
    const result = await this.#rpc("screenshot", { path: harnessPath }, signal);
    if (result !== harnessPath) throw badResponse();
  }

  async #ensureClaim(signal: AbortSignal): Promise<void> {
    this.assertUsable();
    if (this.#client.generation === this.#claimedGeneration && this.#claimedGeneration !== null) return;
    if (this.#pending) {
      this.interrupt("A connection changed before input completion was verified.");
      this.assertUsable();
    }
    await this.#client.connect({ signal });
    this.assertUsable();
    const generation = this.#client.generation!;
    this.#emit("connected", generation);
    const result = await this.#client.call("vision_claim", {}, { signal, generation, timeoutMs: LIMITS.rpcMs });
    if (!record(result) || result.version !== 1 || result.claimed !== true || result.controlling_clients !== 1 || result.pending !== 0) {
      this.#client.disconnect();
      throw new VisionFault("SESSION_PREFLIGHT_FAILED", "Bridge must support an exclusive vision lease with an empty input queue.");
    }
    this.#claimedGeneration = generation;
    this.#emit(this.#everClaimed ? "reclaimed" : "claimed", generation);
    this.#everClaimed = true;
    this.#metadata = sanitizeInfo(await this.#rpc("get_info", {}, signal));
  }

  async #prepareInput(frames: number, signal: AbortSignal): Promise<void> {
    await this.#ensureClaim(signal);
    if (!this.#metadata?.rom_loaded || !this.#metadata.capabilities.controller_input) throw new VisionFault("INPUT_UNAVAILABLE", "A running ROM and controller-input capability are required.");
    await this.inputStatus(signal);
    if (this.#reservedFrames + frames > LIMITS.totalFrames) throw new VisionFault("QUEUE_LIMIT", "Outstanding requested frames plus this input exceed the 3600-frame queue cap.", this.#pending ? "queued" : "not_sent");
  }

  async #submit(submit: () => Promise<{ accepted_presses: number; queue_size: number }>, frames: number): Promise<InputReceipt> {
    this.#sending = true;
    try {
      const receipt = await submit();
      this.#pending = true;
      this.#reservedFrames += frames;
      if (this.#client.generation !== this.#claimedGeneration) {
        this.interrupt("Connection changed after acknowledgement without a queue drain.");
        this.assertUsable();
      }
      return { ...receipt, input_state: "queued", requested_frames: frames, pending: receipt.queue_size, game_acceptance: "not_verified" };
    } catch (error) {
      if (!(error instanceof MgbaError && error.delivery === "not_sent")) {
        this.#pending = true;
        this.interrupt("Input submission had an uncertain acknowledgement.");
        throw new VisionFault(error instanceof MgbaError ? error.code : "INVALID_INPUT_RECEIPT", "Input delivery or completion is uncertain. Do not replay it.", "unknown");
      }
      throw error;
    } finally { this.#sending = false; }
  }

  async #rpc<T = unknown>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    this.assertUsable();
    if (!RPC_ALLOWLIST.has(method)) throw new VisionFault("FORBIDDEN_BRIDGE_METHOD", "Bridge method is outside the vision allowlist.");
    if (this.#claimedGeneration === null) throw new VisionFault("SESSION_NOT_READY", "An exclusive vision session must be established first.");
    try { return await this.#client.call<T>(method, params, { signal, generation: this.#claimedGeneration, timeoutMs: LIMITS.rpcMs }); }
    catch (error) {
      if (this.#pending) this.interrupt("Bridge request failed while queued input completion was unverified.");
      throw error;
    }
  }
  #emit(event: VisionLifecycleEvent["event"], generation: number | null): void {
    try { this.#onLifecycle?.({ event, timestamp: new Date().toISOString(), generation }); }
    catch { this.#interruption ??= "Lifecycle diagnostics failed."; }
  }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function count(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= 4096; }
function badResponse(inputState: "not_sent" | "unknown" = "not_sent"): VisionFault { return new VisionFault("INVALID_BRIDGE_RESPONSE", "Bridge returned invalid approved metadata.", inputState); }
function sanitizeInfo(value: unknown): Omit<SessionInfo, "connected" | "lease_version" | "exclusive_controller" | "connection_generation" | "input_status"> {
  if (!record(value) || typeof value.rom_loaded !== "boolean") throw badResponse();
  const caps = value.capabilities;
  if (value.rom_loaded && !record(caps)) throw badResponse();
  const capability = (name: string): boolean => {
    const v = record(caps) ? caps[name] : undefined;
    if (v !== undefined && typeof v !== "boolean") throw badResponse();
    return v === true;
  };
  const result: Omit<SessionInfo, "connected" | "lease_version" | "exclusive_controller" | "connection_generation" | "input_status"> = {
    rom_loaded: value.rom_loaded, expected_dimensions: { width: 240, height: 160 },
    capabilities: { screenshot: capability("screenshot"), controller_input: capability("setKeys"), frame_counter: capability("currentFrame") },
  };
  for (const field of ["title", "code"] as const) {
    if (value[field] === undefined) continue;
    // Metadata isn't an arbitrary text/error channel or a filesystem path.
    if (typeof value[field] !== "string" || value[field].length > 32 || !/^[A-Za-z0-9 _.-]*\x00*$/.test(value[field])) throw badResponse();
    result[field] = value[field].replace(/\x00+$/, "");
  }
  if (value.frame !== undefined) {
    if (!Number.isSafeInteger(value.frame) || (value.frame as number) < 0) throw badResponse();
    result.frame = value.frame as number;
  }
  if (value.platform !== undefined) {
    if (![0, 1, "GBA", "GB", "GBC"].includes(value.platform as string | number)) throw badResponse();
    result.platform = value.platform as string | number;
  }
  return result;
}

export function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new VisionFault("CANCELLED", "Operation cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
