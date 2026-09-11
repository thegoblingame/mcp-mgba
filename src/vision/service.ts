import { randomUUID } from "node:crypto";
import type { CallToolResult, ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { MgbaError } from "../mgba.js";
import { VisionBridge } from "./bridge.js";
import { LIMITS, VisionFault, isVisionTool, validateArguments, type FutureToolName, type VisionToolName } from "./contracts.js";

export interface VisionPayload { data: Record<string, unknown>; images?: ImageContent[] }
/** Hooks receive only operation-scoped, signal-bound capabilities. */
export interface VisionOperation {
  readonly signal: AbortSignal;
  readonly session: () => ReturnType<VisionBridge["session"]>;
  readonly pressButtons: (args: Record<string, unknown>) => ReturnType<VisionBridge["pressButtons"]>;
  readonly pressSequence: (args: Record<string, unknown>) => ReturnType<VisionBridge["pressSequence"]>;
  readonly inputStatus: () => ReturnType<VisionBridge["inputStatus"]>;
}
export type VisionBackend = (args: Readonly<Record<string, unknown>>, operation: VisionOperation) => Promise<VisionPayload>;
export interface VisionServiceOptions {
  experimentId?: string;
  attemptId?: string;
  operationTimeoutMs?: number;
  backends?: Partial<Record<FutureToolName, VisionBackend>>;
}

export class VisionService {
  readonly sessionId = randomUUID();
  readonly experimentId: string;
  readonly attemptId: string;
  readonly #bridge: VisionBridge;
  readonly #backends: Readonly<Partial<Record<FutureToolName, VisionBackend>>>;
  readonly #timeoutMs: number;
  readonly #controllers = new Set<AbortController>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(bridge: VisionBridge, options: VisionServiceOptions = {}) {
    this.#bridge = bridge;
    this.experimentId = identifier(options.experimentId ?? randomUUID());
    this.attemptId = identifier(options.attemptId ?? randomUUID());
    this.#timeoutMs = options.operationTimeoutMs ?? LIMITS.operationMs;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > LIMITS.operationMs) throw new Error("Invalid vision operation timeout");
    this.#backends = Object.freeze({ ...options.backends });
  }

  async invoke(name: string, args?: unknown, callerSignal?: AbortSignal): Promise<CallToolResult> {
    const started = performance.now();
    try {
      if (!isVisionTool(name)) throw new VisionFault("UNKNOWN_TOOL", "Tool is not available in the vision profile.");
      const validated = validateArguments(name, args);
      if (this.#closed) throw new VisionFault("SESSION_CLOSED", "The vision session is closed.");
      // Validate before entering the serial queue or doing any bridge I/O.
      const controller = new AbortController();
      this.#controllers.add(controller);
      let timedOut = false;
      let executing = false;
      const abort = () => { if (executing) this.#bridge.cancelOperation(); controller.abort(); };
      const timer = setTimeout(() => { timedOut = true; abort(); }, this.#timeoutMs);
      callerSignal?.addEventListener("abort", abort, { once: true });
      if (callerSignal?.aborted) abort();
      let removeAbort = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new VisionFault(timedOut ? "OPERATION_TIMEOUT" : "CANCELLED", timedOut ? "Whole-operation deadline exceeded (including queue wait)." : "Operation cancelled.", this.#bridge.inputState));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
      });
      const task = this.#tail.then(async () => {
        if (controller.signal.aborted) throw new VisionFault("CANCELLED", "Operation cancelled before execution.");
        this.#bridge.assertUsable();
        executing = true;
        return this.#execute(name, validated, controller.signal);
      });
      // Never release serialization merely because a caller timed out. A future
      // backend must finish/cancel before another operation can enter.
      this.#tail = task.then(() => {}, () => {});
      try {
        const payload = await Promise.race([task, cancelled]);
        return this.#result(name, started, payload);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abort);
        removeAbort();
        this.#controllers.delete(controller);
      }
    } catch (error) { return this.#failure(name, started, error); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bridge.cancelOperation();
    for (const controller of this.#controllers) controller.abort();
    this.#bridge.close();
  }

  async #execute(name: VisionToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<VisionPayload> {
    switch (name) {
      case "vision_session": return { data: { ...await this.#bridge.session(signal) } };
      case "mgba_press_buttons": return { data: { ...await this.#bridge.pressButtons(args, signal) } };
      case "mgba_press_sequence": return { data: { ...await this.#bridge.pressSequence(args, signal) } };
      default: {
        const backend = this.#backends[name];
        if (!backend) throw new VisionFault("NOT_IMPLEMENTED", "This backend is not available in milestone 1. No action was taken.");
        const scope = new AbortController();
        const scopedSignal = AbortSignal.any([signal, scope.signal]);
        let active = true;
        let pending: Promise<unknown> | null = null;
        const use = <T>(operation: () => Promise<T>): Promise<T> => {
          if (!active || scopedSignal.aborted) return Promise.reject(new VisionFault("OPERATION_EXPIRED", "Operation capabilities have expired."));
          if (pending) return Promise.reject(new VisionFault("CONCURRENT_OPERATION", "Backend operations must be awaited sequentially."));
          const task = operation();
          const tracked = task.finally(() => { if (pending === tracked) pending = null; });
          pending = tracked;
          // A faulty backend must not create an unhandled detached rejection.
          void tracked.catch(() => {});
          return tracked;
        };
        try {
          const payload = await backend(Object.freeze(args), Object.freeze({
            signal: scopedSignal,
            session: () => use(() => this.#bridge.session(scopedSignal)),
            pressButtons: (p: Record<string, unknown>) => use(() => this.#bridge.pressButtons(p, scopedSignal)),
            pressSequence: (p: Record<string, unknown>) => use(() => this.#bridge.pressSequence(p, scopedSignal)),
            inputStatus: () => use(() => this.#bridge.inputStatus(scopedSignal)),
          }));
          if (pending) throw new VisionFault("UNAWAITED_OPERATION", "Backend returned before its operation completed.", this.#bridge.inputState);
          return payload;
        } finally {
          active = false;
          if (pending) this.#bridge.cancelOperation();
          scope.abort();
          const outstanding = pending as Promise<unknown> | null;
          await outstanding?.catch(() => {});
        }
      }
    }
  }

  #base(tool: string, started: number): Record<string, unknown> {
    return { tool: isVisionTool(tool) ? tool : "unknown", session_id: this.sessionId, experiment_id: this.experimentId,
      attempt_id: this.attemptId, timestamp: new Date().toISOString(), duration_ms: Math.round(performance.now() - started) };
  }
  #result(name: string, started: number, payload: VisionPayload): CallToolResult {
    const value = { ok: true, ...this.#base(name, started), data: payload.data };
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > LIMITS.resultBytes) throw new VisionFault("OUTPUT_LIMIT", "Tool metadata exceeded its output limit.", this.#bridge.inputState);
    return { content: [{ type: "text", text: json }, ...(payload.images ?? [])], structuredContent: value };
  }
  #failure(name: string, started: number, error: unknown): CallToolResult {
    const interrupted = this.#bridge.interrupted;
    const fault = error instanceof VisionFault ? error : error instanceof MgbaError
      ? new VisionFault(error.code, "Bridge request failed. No input will be automatically replayed.", this.#bridge.inputState)
      : new VisionFault("INTERNAL_ERROR", "The vision operation failed.", this.#bridge.inputState);
    const value = { ok: false, ...this.#base(name, started), error: { code: fault.code, message: fault.message,
      input_state: interrupted ? "unknown" : fault.inputState, technical_interruption: interrupted,
      ...(error instanceof MgbaError ? { rpc_delivery: error.delivery } : {}) } };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }
}
function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw new Error("Invalid vision run identifier");
  return value;
}
