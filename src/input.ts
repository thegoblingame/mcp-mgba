/** Shared raw submission only: profile-specific validation/wait policy lives above it. */
export const VALID_KEYS = ["A", "B", "Select", "Start", "Right", "Left", "Up", "Down", "R", "L"] as const;
export type InputRpc = <T>(method: "press_buttons" | "press_sequence", params: Record<string, unknown>) => Promise<T>;
export interface ButtonReceipt { queued: boolean; queue_size: number }
export interface SequenceReceipt { queued: number; queue_size: number; frames: number }
export function submitButtons(rpc: InputRpc, p: Record<string, unknown>): Promise<ButtonReceipt> {
  return rpc("press_buttons", { buttons: p.buttons, frames: p.frames ?? 1, release_frames: p.release_frames ?? 1 });
}
export function submitSequence(rpc: InputRpc, p: Record<string, unknown>): Promise<SequenceReceipt> {
  return rpc("press_sequence", {
    presses: p.presses,
    ...(p.frames !== undefined ? { frames: p.frames } : {}),
    ...(p.release_frames !== undefined ? { release_frames: p.release_frames } : {}),
  });
}
