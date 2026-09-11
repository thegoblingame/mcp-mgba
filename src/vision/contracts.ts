import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Ajv, type ValidateFunction } from "ajv";
import { VALID_KEYS } from "../input.js";

export const LIMITS = Object.freeze({
  batchLength: 256, pressFrames: 600, totalFrames: 3600,
  operationMs: 120_000, connectMs: 1500, rpcMs: 3000, pollMs: 16,
  waitMs: 60_000, waitFrames: 3600, settleMs: 5000,
  noteCharacters: 4000, recallCharacters: 12_000, resultBytes: 64 * 1024,
});
export const BUTTONS = VALID_KEYS;
export type Button = typeof BUTTONS[number];
export interface Press { buttons: Button[]; frames: number; release_frames: number }
export interface Batch { presses: Press[]; frames: number; release_frames: number; wait: boolean; timeout_ms: number; total_frames: number }
export const TOOL_NAMES = ["vision_session", "vision_observe", "mgba_press_buttons", "mgba_press_sequence", "vision_step", "vision_wait", "vision_note", "vision_recall"] as const;
export type VisionToolName = typeof TOOL_NAMES[number];
export type FutureToolName = Exclude<VisionToolName, "vision_session" | "mgba_press_buttons" | "mgba_press_sequence">;

type Schema = Record<string, unknown>;
const integer = (minimum: number, maximum: number, defaultValue?: number): Schema => ({ type: "integer", minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const object = (properties: Record<string, Schema>, required: string[] = []): Tool["inputSchema"] => ({ type: "object", properties, required, additionalProperties: false });
const timing = integer(1, LIMITS.pressFrames, 1);
const buttons: Schema = { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", enum: BUTTONS } };
const press = object({ buttons, frames: timing, release_frames: timing }, ["buttons"]);
const sequence = {
  presses: { type: "array", minItems: 1, maxItems: LIMITS.batchLength, items: { oneOf: [{ type: "string", enum: BUTTONS }, press] } },
  frames: timing, release_frames: timing,
  wait: { type: "boolean", default: true }, timeout_ms: integer(1, LIMITS.operationMs),
};
const crop = object({ x: integer(0, 239), y: integer(0, 159), width: integer(1, 240), height: integer(1, 160) }, ["x", "y", "width", "height"]);
const observation = { crop, scale: { type: "integer", enum: [1, 3], default: 3 } };
const identifier: Schema = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" };
const references: Schema = { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: identifier };
const tags: Schema = { type: "array", maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } };

const definitions: Tool[] = [
  { name: "vision_session", description: "Check bridge health, exclusive controller ownership, allowed emulator metadata and run IDs. Requires an empty input queue on the initial claim. Does not change game controls.", inputSchema: object({}) },
  { name: "vision_observe", description: "Observe the current visible screen. Crop uses native 240x160 coordinates, then scale 1 or 3 (default 3), nearest-neighbor. Returns inline image and capture metadata. Not implemented in milestone 1; fails before capture.", inputSchema: object(observation) },
  { name: "mgba_press_buttons", description: "Queue one button press or simultaneous combination. Returns an accepted/queued receipt, NOT proof of game acceptance or completed execution. Defaults: hold 1 frame, release 1. Never automatically replay after uncertainty. The reset chord A+B+Select+Start is prohibited.", inputSchema: press },
  { name: "mgba_press_sequence", description: "Submit a validated ordered batch once; bare button names and per-press objects may be mixed. Waits for the input queue to drain by default; wait:false returns a queued receipt. Queue drain is not proof the game accepted the actions. At most 256 presses and 3600 requested hold+release frames. Uncertain input ends this session; never replay.", inputSchema: object(sequence, ["presses"]) },
  { name: "vision_step", description: "Submit one bounded batch, wait for queue drain, settle for milliseconds, and observe. Not implemented in milestone 1; fails before sending any input.", inputSchema: object({ ...sequence, wait: { type: "boolean", const: true, default: true }, ...observation, settle_ms: integer(0, LIMITS.settleMs, 0) }, ["presses"]) },
  { name: "vision_wait", description: "Let the continuously running emulator proceed for exactly one requested duration: milliseconds or frame-counter delta. An observation is optional (default true). Frame waits may overshoot. Not implemented in milestone 1; fails before waiting or capture.", inputSchema: { ...object({ milliseconds: integer(1, LIMITS.waitMs), frames: integer(1, LIMITS.waitFrames), observe: { type: "boolean", default: true }, ...observation, timeout_ms: integer(1, LIMITS.operationMs) }), oneOf: [{ required: ["milliseconds"] }, { required: ["frames"] }] } },
  { name: "vision_note", description: "Append player-authored knowledge with authorized observation/action evidence IDs; corrections use supersedes. Notes persist across operator-started retries. Not implemented in milestone 1; does not write anything.", inputSchema: object({ claim: { type: "string", minLength: 1, maxLength: LIMITS.noteCharacters }, category: { type: "string", enum: ["observation", "hypothesis", "lesson", "plan"] }, tags, evidence: references, supersedes: references }, ["claim", "category", "evidence"]) },
  { name: "vision_recall", description: "Retrieve only authorized player-authored notes by bounded keyword, category or tag search; no query lists compact recent notes. Not implemented in milestone 1; does not read files.", inputSchema: object({ query: { type: "string", maxLength: 200 }, category: { type: "string", enum: ["observation", "hypothesis", "lesson", "plan"] }, tags, limit: integer(1, 20, 10), offset: integer(0, 100_000, 0), max_characters: integer(1, LIMITS.recallCharacters, 6000) }) },
];

// One authoritative schema drives discovery AND runtime validation. Defaults
// are normalized explicitly, never by mutating caller objects in Ajv.
const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: false, ownProperties: true });
const validators = new Map<string, ValidateFunction>(definitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
export function listVisionTools(): Tool[] { return structuredClone(definitions); }
export function isVisionTool(name: string): name is VisionToolName { return validators.has(name); }
export class VisionFault extends Error {
  constructor(readonly code: string, message: string, readonly inputState: "not_sent" | "queued" | "drained" | "unknown" = "not_sent") { super(message); this.name = "VisionFault"; }
}
export function validateArguments(name: VisionToolName, value: unknown): Record<string, unknown> {
  const args = value === undefined ? {} : value;
  if (!validators.get(name)!(args)) throw new VisionFault("INVALID_ARGUMENTS", "Arguments do not match the published tool schema.");
  const p = structuredClone(args) as Record<string, unknown>;
  if (p.crop) {
    const c = p.crop as { x: number; y: number; width: number; height: number };
    if (c.x + c.width > 240 || c.y + c.height > 160) throw new VisionFault("INVALID_ARGUMENTS", "Crop must fit inside the native 240x160 display.");
  }
  if (name === "mgba_press_buttons") normalizePress(p);
  if (name === "mgba_press_sequence" || name === "vision_step") normalizeBatch(p);
  if (name === "vision_step" && p.wait === false) throw new VisionFault("INVALID_ARGUMENTS", "vision_step always waits for queue drain.");
  if (name === "vision_wait" && p.observe === false && (p.crop !== undefined || p.scale !== undefined)) throw new VisionFault("INVALID_ARGUMENTS", "Image options require observe:true.");
  if (typeof p.claim === "string" && !p.claim.trim()) throw new VisionFault("INVALID_ARGUMENTS", "A note claim must contain text.");
  return p;
}

export function normalizePress(p: Record<string, unknown>, hold = 1, release = 1): Press {
  const result = { buttons: p.buttons as Button[], frames: p.frames as number ?? hold, release_frames: p.release_frames as number ?? release };
  if (["A", "B", "Select", "Start"].every(button => result.buttons.includes(button as Button))) {
    throw new VisionFault("PROHIBITED_INPUT", "The reset chord A+B+Select+Start is not permitted.");
  }
  return result;
}
export function normalizeBatch(p: Record<string, unknown>): Batch {
  const frames = p.frames as number ?? 1;
  const release_frames = p.release_frames as number ?? 1;
  const presses = (p.presses as (Button | Record<string, unknown>)[]).map(step => normalizePress(typeof step === "string" ? { buttons: [step] } : step, frames, release_frames));
  const total_frames = presses.reduce((sum, step) => sum + step.frames + step.release_frames, 0);
  if (total_frames > LIMITS.totalFrames) throw new VisionFault("INVALID_ARGUMENTS", "Batch exceeds 3600 requested hold/release frames.");
  return { presses, frames, release_frames, total_frames, wait: p.wait !== false, timeout_ms: p.timeout_ms as number ?? Math.min(LIMITS.operationMs, total_frames * 50 + 2000) };
}
