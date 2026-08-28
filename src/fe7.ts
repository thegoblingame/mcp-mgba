// fe7.ts — Fire Emblem 7 (US, AGB-AE7E) game-specific tool layer.
//
// WHY THIS LIVES IN TYPESCRIPT AND NOT bridge.lua
// ----------------------------------------------
// bridge.lua's RPC handlers are dispatched from inside mGBA's frame callback.
// A handler that blocked waiting for frames to pass would prevent the callback
// from returning, so no frames would ever advance — an immediate deadlock.
// Node is a separate process, so it can press a button, poll memory, and press
// again, verifying every step. That is exactly what these tools need, so all
// orchestration happens here on top of the existing generic primitives
// (read_range / press_sequence / input_status). No Lua changes required.
//
// THE PROBLEM THESE SOLVE
// -----------------------
// Driving FE7 blind fails because inputs are silently swallowed during walk
// animations and menu transitions, and a swallowed input is indistinguishable
// from an illegal move. Every routine here confirms BY EFFECT: cursor moves are
// verified against the live cursor, selection against the unit's +0x0C bit 0,
// a completed move against the unit's +0x10/+0x11, and a committed action
// against +0x0C == 0x42. Nothing is assumed to have landed.
//
// Addresses are from llm_plays_fe7/RAM.md and are US-release specific.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MgbaClient } from "./mgba.js";
import { readFile, unlink, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ── Addresses (US release, ROM title FIREEMBLEME / AGB-AE7E) ────────────────

const A = {
  phase:        0x0202bc07, // u8  0x00 player, 0x40 green/prep, 0x80 enemy
  turn:         0x0202bc08, // u8
  cursorX:      0x0202bbcc, // u16 live cursor, tile coords
  cursorY:      0x0202bbce, // u16
  playerArray:  0x0202bd50,
  enemyArray:   0x0202cec0,
  greenArray:   0x0202dcd0, // NPC / green faction, roster indices 0x41+
  textBuf:      0x0202a5b4, // decoded ASCII staging buffer
  gridTable:    0x03000440, // movement grid ROW-POINTER TABLE (IWRAM); its data follows it
  battleActor:  0x0203a3f0, // gBattleActor  — 128-byte BattleUnit
  battleTarget: 0x0203a470, // gBattleTarget — 128-byte BattleUnit
  uiArena:      0x02024000, // where menus and selection procs get allocated
} as const;

const UI_ARENA_LEN = 8192;

// ROM item table: entry = ITEM_TABLE + 0x24*id.
//   +0x07 weapon type (0 sword 1 lance 2 axe 3 bow 4 staff 5 anima 6 light 7 dark, 9 consumable)
//   +0x14 max uses, +0x15 Mt, +0x16 Hit, +0x17 Wt, +0x18 Crit, +0x19 range (hi nibble max, lo min)
const ITEM_TABLE  = 0x08be222c;
const ITEM_STRIDE = 0x24;
const WTYPE_STAFF = 4;

// The staff-targeting proc carries this ROM script pointer at its +0x00, and the
// highlighted target's unit-struct pointer at +0x2C. Searching for it returns
// exactly one match while staff target select is up and zero otherwise, so it is
// both the readback AND the state gate. The proc address itself is dynamic.
const STAFF_PROC_SIG = [0x98, 0x69, 0xb9, 0x08];
const STAFF_PROC_TARGET_OFF = 0x2c;

// Battle-copy field offsets (u16 unless noted). See RAM.md "Combat forecast".
const BF = {
  weaponAfter: 0x48, weaponBefore: 0x4a, wtype: 0x50,
  triHit: 0x53, triDmg: 0x54, terrainId: 0x55, terrainDef: 0x56, terrainAvo: 0x57,
  atk: 0x5a, def: 0x5c, as: 0x5e, hit: 0x60, avo: 0x62,
  effHit: 0x64, crit: 0x66, dodge: 0x68, effCrit: 0x6a,
} as const;

const UNIT_STRIDE  = 0x48;

// Each array's slot cap is set by where the NEXT array begins, so a scan can
// never wander into the following structure and invent phantom units:
//   player 0x0202BD50 .. enemy 0x0202CEC0 = 62 slots
//   enemy  0x0202CEC0 .. green 0x0202DCD0 = 50 slots
//   green  0x0202DCD0 .. 0x0202E000       = 11 slots
const SLOT_CAP: Record<number, number> = {
  [0x0202bd50]: 62,
  [0x0202cec0]: 50,
  [0x0202dcd0]: 11,
};
// The movement grid's geometry is PER CHAPTER. The game allocates it at map
// load, sized to that map, so row count and stride are NOT constants:
//   Lyn ch.1  = 14 rows x 17 bytes, data at 0x03000478
//   Lyn ch.7  = 18 rows x 22 bytes, data at 0x03000488
//   ch.22 HM  = 27 rows x 24 bytes, data at 0x030004AC
// Hardcoding any one of these silently misreads every other map. Derive them
// from the row-pointer table instead — see readGrid().
const GRID_Y_OFF   = 2;      // row index = y + 2 (two top border rows)
const GRID_PROBE   = 2048;   // table + data in ONE read for any observed map
const CLASS_BASE   = 0x08be015c;
const CLASS_STRIDE = 0x54;

const UNREACHABLE = 0xff;

// ── Low-level helpers ──────────────────────────────────────────────────────

/** read_range is capped at 4096 bytes per call; chunk transparently. */
async function readRange(m: MgbaClient, addr: number, len: number): Promise<number[]> {
  const out: number[] = [];
  let off = 0;
  while (off < len) {
    const n = Math.min(4096, len - off);
    const chunk = await m.call<number[]>("read_range", { address: addr + off, length: n });
    out.push(...chunk);
    off += n;
  }
  return out;
}

const u16 = (b: number[], o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: number[], o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Queue presses and block until the bridge's input queue has drained. */
async function press(
  m: MgbaClient,
  presses: Array<string | { buttons: string[]; frames?: number; release_frames?: number }>,
  frames = 4,
  release = 6,
): Promise<void> {
  await m.call("press_sequence", { presses, frames, release_frames: release });
  const deadline = Date.now() + 8000;
  for (;;) {
    const s = await m.call<{ pending: number }>("input_status");
    if (s.pending === 0) return;
    if (Date.now() >= deadline) return;
    await sleep(8);
  }
}

/** Poll `probe` until it returns true, or the timeout expires. */
async function waitUntil(probe: () => Promise<boolean>, timeoutMs: number, pollMs = 16): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

// ── Unit decoding ──────────────────────────────────────────────────────────

export interface Unit {
  slot: number;
  addr: number;
  roster: number;
  classId: number;
  level: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  str: number; skl: number; spd: number; def: number; res: number; lck: number;
  flags: number;
  acted: boolean;
  selected: boolean;
  deployed: boolean;
  dead: boolean;
  items: Array<{ id: number; uses: number }>;
  /** Weapon ranks at +0x28, indexed by weapon type. 0 = cannot use that type at all. */
  ranks: number[];
}

function decodeUnit(b: number[], base: number, slot: number, arrayAddr: number): Unit | null {
  const o = base + slot * UNIT_STRIDE;
  const charPtr = u32(b, o);
  if (charPtr === 0) return null; // arrays are contiguous; first zero ends them

  const classPtr = u32(b, o + 0x04);
  const classId = classPtr > CLASS_BASE ? Math.floor((classPtr - CLASS_BASE) / CLASS_STRIDE) : -1;
  const flags = u32(b, o + 0x0c);
  const low = flags & 0xff;

  const items: Array<{ id: number; uses: number }> = [];
  for (let i = 0; i < 5; i++) {
    const w = u16(b, o + 0x1e + i * 2);
    if ((w & 0xff) !== 0) items.push({ id: w & 0xff, uses: (w >> 8) & 0xff });
  }

  return {
    slot,
    addr: arrayAddr + slot * UNIT_STRIDE,
    roster: b[o + 0x0b],
    classId,
    level: b[o + 0x08],
    x: b[o + 0x10],
    y: b[o + 0x11],
    maxHp: b[o + 0x12],
    hp: b[o + 0x13],
    str: b[o + 0x14], skl: b[o + 0x15], spd: b[o + 0x16],
    def: b[o + 0x17], res: b[o + 0x18], lck: b[o + 0x19],
    flags,
    // "Spent" is bit 1, not the exact value 0x42.
    //
    // RAM.md records 0x42 for a unit that chose Wait, and testing against that
    // exact value worked until a unit finished COMBAT and settled on 0x02 —
    // stable across many seconds, definitely spent, but `low === 0x42` called
    // it unspent and the tool would happily have moved it a second time.
    // Bit 1 is common to both; bit 6 appears to track something else.
    // Deliberately a bit-test, not an equality test, because the set of exact
    // values a spent unit can hold is evidently not fully known.
    acted: (low & 0x02) !== 0,
    selected: (low & 0x01) !== 0,
    deployed: b[o + 0x10] !== 0xff,
    dead: b[o + 0x13] === 0,
    items,
    ranks: Array.from({ length: 8 }, (_, i) => b[o + 0x28 + i]),
  };
}

/**
 * Scan a whole unit array.
 *
 * These arrays are NOT strictly contiguous: a unit leaving mid-chapter zeroes
 * its slot and later slots stay populated (observed live — player slot 23 was
 * empty while 24-29 held units). Stopping at the first empty slot silently
 * truncated the roster 30 -> 23 and hid Merlinus, so we scan every slot up to
 * the array's cap and skip holes instead.
 */
async function readArray(m: MgbaClient, arrayAddr: number): Promise<Unit[]> {
  const cap = SLOT_CAP[arrayAddr] ?? 62;
  const bytes = await readRange(m, arrayAddr, cap * UNIT_STRIDE);
  const units: Unit[] = [];
  for (let s = 0; s < cap; s++) {
    const u = decodeUnit(bytes, 0, s, arrayAddr);
    if (u) units.push(u);
  }
  return units;
}

/** Arrays are sparse, so index by slot number rather than array position. */
const bySlot = (units: Unit[], slot: number) => units.find((u) => u.slot === slot);

/** Every tile currently occupied by a live unit of ANY faction. */
function occupancy(...groups: Array<{ units: Unit[]; mark: string }>): Map<string, { mark: string; u: Unit }> {
  const map = new Map<string, { mark: string; u: Unit }>();
  for (const g of groups) {
    for (const u of g.units) {
      if (u.deployed && !u.dead) map.set(`${u.x},${u.y}`, { mark: g.mark, u });
    }
  }
  return map;
}

/**
 * Re-read a single unit's record. This is the verification probe used between
 * presses, so it stays small (0x30 bytes covers through the inventory block)
 * and is called in tight polling loops.
 */
async function readUnit(m: MgbaClient, arrayAddr: number, slot: number): Promise<Unit | null> {
  const b = await readRange(m, arrayAddr + slot * UNIT_STRIDE, 0x30);
  const u = decodeUnit(b, 0, 0, arrayAddr);
  if (!u) return null;
  u.slot = slot;
  u.addr = arrayAddr + slot * UNIT_STRIDE;
  return u;
}

const PHASE_NAME: Record<number, string> = { 0x00: "player", 0x40: "green/prep", 0x80: "enemy" };

async function readCursor(m: MgbaClient): Promise<{ x: number; y: number }> {
  const b = await readRange(m, A.cursorX, 4);
  return { x: u16(b, 0), y: u16(b, 2) };
}

// ── Movement grid ──────────────────────────────────────────────────────────
//
// A table of 4-byte row pointers at A.gridTable, immediately followed by the
// row data it points at. Value = movement cost spent to reach the tile;
// 0xFF = not reachable. row index = y + 2.
//
// The geometry is derived, never assumed. The table ends exactly where its own
// data begins, so the FIRST pointer tells you how long the table is and hence
// how many rows there are; the gap between the first two gives the stride.
// Confirmed on three maps: (0x478-0x440)/4 = 14, (0x488-0x440)/4 = 18,
// (0x4AC-0x440)/4 = 27, with strides 17, 22 and 24.
//
// Do NOT walk the table looking for a terminator: ch.1 ends it with 0xFFFFFFFF
// but ch.7 ends it with 0x00000000, so no single sentinel works.
//
// IMPORTANT: this is the PATHFINDING COST map. It includes tiles occupied by
// other units (you may route through allies but not stop on them), so
// `cost != 0xFF` alone is NOT a legal-destination test.

type GridGeom = {
  stride: number;    // bytes per row, INCLUDING the 2 padding columns
  rowCount: number;  // rows in the buffer, including the 2 top border rows
  width: number;     // playable columns (stride - 2)
  height: number;    // addressable rows (rowCount - GRID_Y_OFF)
  rowPtrs: number[];
};

type Grid = GridGeom & { rows: number[][] };

/** Derive the grid's shape from the head of its own pointer table. */
function parseGridGeom(buf: number[]): GridGeom {
  const p0 = u32(buf, 0), p1 = u32(buf, 4);
  const tableBytes = p0 - A.gridTable;
  if (tableBytes <= 0 || tableBytes % 4 !== 0 || tableBytes > 512) {
    throw new Error(
      `movement grid: first row pointer 0x${p0.toString(16)} is not a plausible end for the ` +
      `table at 0x${A.gridTable.toString(16)} (implies ${tableBytes} table bytes). ` +
      `The grid is probably not allocated — is a map loaded?`);
  }
  const rowCount = tableBytes / 4;
  const stride = p1 - p0;
  if (stride <= 2 || stride > 64) {
    throw new Error(`movement grid: implausible row stride ${stride} from pointers ` +
      `0x${p0.toString(16)} / 0x${p1.toString(16)}.`);
  }
  const rowPtrs: number[] = [];
  for (let i = 0; i < rowCount; i++) rowPtrs.push(u32(buf, i * 4));
  return { stride, rowCount, width: stride - 2, height: rowCount - GRID_Y_OFF, rowPtrs };
}

async function readGrid(m: MgbaClient): Promise<Grid> {
  // One read covers table AND data, since the data begins where the table ends.
  const probe = await readRange(m, A.gridTable, GRID_PROBE);
  const g = parseGridGeom(probe);
  const need = (g.rowPtrs[g.rowCount - 1] - A.gridTable) + g.stride;
  // Read exactly what the grid occupies and never a byte more — over-reading is
  // what let unrelated IWRAM be presented as movement cost, and a stray 0x00
  // past the end decodes as "cost 0 = legal destination".
  const bytes = need <= probe.length ? probe : await readRange(m, A.gridTable, need);
  const rows: number[][] = [];
  for (let y = 0; y < g.height; y++) {
    const off = g.rowPtrs[y + GRID_Y_OFF] - A.gridTable;
    rows.push(bytes.slice(off, off + g.stride));
  }
  return { ...g, rows };
}

/** Just the shape, for callers that need bounds but not costs. */
async function readGridGeometry(m: MgbaClient): Promise<GridGeom> {
  return parseGridGeom(await readRange(m, A.gridTable, 8));
}

/** The tile the grid marks cost 0 — i.e. who the game thinks is selected. */
function gridOrigin(grid: Grid): { x: number; y: number } | null {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.stride; x++) if (grid.rows[y][x] === 0) return { x, y };
  }
  return null;
}

// The cheapest possible check that the grid was decoded correctly: cost 0 must
// land on the unit we selected. Every historical misread of this structure --
// wrong stride, wrong base, stale buffer -- fails exactly here.
function gridMismatch(grid: Grid, u: { x: number; y: number }): string | null {
  const o = gridOrigin(grid);
  if (!o) return `movement grid holds no cost-0 tile — it was not populated for this unit.`;
  if (o.x !== u.x || o.y !== u.y) {
    return `movement grid decoded WRONG: cost 0 is at (${o.x},${o.y}) but the unit is at ` +
      `(${u.x},${u.y}). Refusing to act on it. ` +
      `[${grid.rowCount} rows x stride ${grid.stride}]`;
  }
  return null;
}

function gridCost(grid: Grid, x: number, y: number): number {
  if (y < 0 || y >= grid.height || x < 0 || x >= grid.stride) return UNREACHABLE;
  return grid.rows[y][x];
}

// ── Cursor driving ─────────────────────────────────────────────────────────
//
// Presses directions and verifies against the live cursor, retrying what did
// not land. This is what makes a dropped input recoverable instead of silently
// corrupting the rest of a blind sequence.

// Long traversals scroll the map, and scrolling eats presses — a 7-tile move
// legitimately stalls for a moment partway. The original limits gave up one
// tile short of the target and reported "input blocked", which was wrong.
// Be patient: only conclude input is blocked after sustained no movement.
async function moveCursorTo(m: MgbaClient, tx: number, ty: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastX = -1, lastY = -1, stuck = 0;

  for (;;) {
    const c = await readCursor(m);
    if (c.x === tx && c.y === ty) return true;
    if (Date.now() >= deadline) return false;

    if (c.x === lastX && c.y === lastY) {
      stuck++;
      // Back off and let the game settle rather than spamming presses. 20
      // consecutive no-progress rounds with a 200ms wait is ~4s of genuinely
      // frozen cursor, which really does mean input is blocked.
      if (stuck > 20) return false;
      await sleep(200);
    } else {
      stuck = 0;
    }
    lastX = c.x; lastY = c.y;

    const seq: string[] = [];
    const dx = tx - c.x, dy = ty - c.y;
    // Cap the batch so we re-verify often; a long blind run is what loses presses.
    const n = Math.min(4, Math.abs(dx) + Math.abs(dy));
    for (let i = 0; i < n; i++) {
      if (Math.abs(dx) > 0 && i < Math.abs(dx)) seq.push(dx > 0 ? "Right" : "Left");
      else seq.push(dy > 0 ? "Down" : "Up");
    }
    await press(m, seq, 3, 6);
  }
}

// ── Menu handling ──────────────────────────────────────────────────────────
//
// Menus are dynamically allocated, so their address is never hardcoded. Two
// facts from RAM.md make blind navigation safe: entry order puts Wait LAST, and
// the highlight index WRAPS. So a single Up from the freshly-opened index 0
// always lands on Wait.
//
// Rather than locate the menu, we verify by effect and retry: press Up+A, check
// whether the unit committed (+0x0C == 0x42), and if not, press B to unwind
// whatever submenu opened and try again. B is always safe here — Attack and
// Item both require a further confirm, so nothing is spent by backing out.

// Confirming Wait by the has-acted flag ALONE is a trap. If this unit was the
// last unspent one, its Wait ends the player phase; the enemy phase runs and the
// new turn CLEARS has-acted again. The flag then reads 0 for the best possible
// reason, the retry fires, and by then no menu is open — so "Up, A" lands on the
// live map, walking the cursor up one tile and pressing A on whatever is there.
// That is exactly the cursor drift observed across Lyn ch.1, and on empty ground
// the A opens the FIELD menu, whose last entry (reached by the next retry's Up)
// is End Turn. On a full roster that would end the phase with units unmoved.
//
// So latch turn and phase first: if either moved, the Wait landed. Only the turn
// counter can tell "already acted" apart from "not acted yet".
async function commitWait(
  m: MgbaClient, arrayAddr: number, slot: number, attempts = 4,
): Promise<{ ok: boolean; via: "flag" | "phase" | "nomenu"; turnBefore: number; turnAfter: number }> {
  const c0 = await phaseClock(m);
  let via: "flag" | "phase" = "flag";
  let turnAfter = c0.turn;

  for (let i = 0; i < attempts; i++) {
    // "Up" here is MENU navigation, not a map input — it wraps the action menu
    // to its last entry, Wait. If no menu has focus it walks the MAP CURSOR
    // instead, and the A behind it lands on the board: on empty ground that
    // opens the field menu, whose last entry (one more Up) is End Turn. That is
    // how a retry could silently end the phase with units unmoved.
    //
    // So make the press verifiable rather than blind: press Up, then read the
    // live cursor. A menu swallows Up and the cursor holds still; a bare map
    // does not. Only fire A once we know something has focus.
    const cur0 = await readCursor(m);
    await press(m, [{ buttons: ["Up"], frames: 4, release_frames: 14 }]);
    await sleep(120);
    const cur1 = await readCursor(m);

    if (cur1.x !== cur0.x || cur1.y !== cur0.y) {
      // The cursor moved, so there was no menu. Put it back and stop — do NOT
      // send A at the board. Retrying cannot help: input is plainly being
      // accepted, so the menu is gone because the action already resolved.
      await press(m, [{ buttons: ["Down"], frames: 4, release_frames: 14 }]);
      const c = await phaseClock(m);
      if (c.phase !== c0.phase || c.turn !== c0.turn) {
        return { ok: true, via: "phase", turnBefore: c0.turn, turnAfter: c.turn };
      }
      return { ok: false, via: "nomenu", turnBefore: c0.turn, turnAfter: c.turn };
    }

    // Cursor held still: a menu has focus, or input is being swallowed. A is the
    // right press for both. (At y = 0 the map edge also blocks Up, so the test is
    // inconclusive there — press A anyway and let the checks below decide. That
    // is the steamroller default: a wasted press beats a stall.)
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 14 }]);
    const done = await waitUntil(async () => {
      const [c, u] = await Promise.all([phaseClock(m), readUnit(m, arrayAddr, slot)]);
      if (c.phase !== c0.phase || c.turn !== c0.turn) { via = "phase"; turnAfter = c.turn; return true; }
      return !!u && u.acted;
    }, 900);
    if (done) return { ok: true, via, turnBefore: c0.turn, turnAfter };
    // Something else opened (item list / attack targeting). Unwind and retry.
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    await sleep(120);
  }
  return { ok: false, via: "flag", turnBefore: c0.turn, turnAfter: c0.turn };
}

// ── ASCII staging buffer ───────────────────────────────────────────────────
//
// NOT a menu-highlight mirror — it holds the last string the game RENDERED, and
// it goes stale. It read "Wait" at index 2 of 4 AND at index 0 of 4, so it can
// never be used to tell which entry is highlighted. It IS reliable for prompts
// that only appear in one state ("Select a character to restore HP to.") and for
// refusals ("There's no need for that."), which is all we use it for.

async function readText(m: MgbaClient, len = 64): Promise<string> {
  const b = await readRange(m, A.textBuf, len);
  let out = "";
  for (const c of b) {
    if (c === 0) break;
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ".";
  }
  return out;
}

// ── ROM item table ─────────────────────────────────────────────────────────

const itemTypeCache = new Map<number, number>();

/** Weapon type of an item id. 4 = staff. Cached; the table is in ROM and never moves. */
async function itemType(m: MgbaClient, id: number): Promise<number> {
  const hit = itemTypeCache.get(id);
  if (hit !== undefined) return hit;
  const b = await readRange(m, ITEM_TABLE + ITEM_STRIDE * id, 8);
  const t = b[0x07];
  itemTypeCache.set(id, t);
  return t;
}

/** Min/max attack range of an item, from the ROM table's packed range nibbles. */
async function itemRange(m: MgbaClient, id: number): Promise<{ min: number; max: number }> {
  const b = await readRange(m, ITEM_TABLE + ITEM_STRIDE * id + 0x19, 1);
  return { min: b[0] & 0x0f, max: (b[0] >> 4) & 0x0f };
}

/** Inventory slot indices holding staves, in inventory order = the staff list's order. */
async function staffSlots(m: MgbaClient, u: Unit): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < u.items.length; i++) {
    if ((await itemType(m, u.items[i].id)) === WTYPE_STAFF) out.push(i);
  }
  return out;
}

// ── Combat forecast ────────────────────────────────────────────────────────

export interface BattleSide {
  atk: number; def: number; as: number; hit: number; avo: number;
  effHit: number; crit: number; dodge: number; effCrit: number;
  weaponId: number; usesBefore: number; usesAfter: number;
  wtype: number; terrainDef: number; terrainAvo: number;
  hpNow: number; projHp: number;
}

function decodeSide(b: number[], o: number): BattleSide {
  const before = u16(b, o + BF.weaponBefore);
  const after  = u16(b, o + BF.weaponAfter);
  return {
    atk: u16(b, o + BF.atk), def: u16(b, o + BF.def), as: u16(b, o + BF.as),
    hit: u16(b, o + BF.hit), avo: u16(b, o + BF.avo),
    effHit: u16(b, o + BF.effHit), crit: u16(b, o + BF.crit),
    dodge: u16(b, o + BF.dodge), effCrit: u16(b, o + BF.effCrit),
    weaponId: before & 0xff, usesBefore: (before >> 8) & 0xff, usesAfter: (after >> 8) & 0xff,
    wtype: b[o + BF.wtype], terrainDef: b[o + BF.terrainDef], terrainAvo: b[o + BF.terrainAvo],
    hpNow: b[o + 0x72], projHp: b[o + 0x13],
  };
}

/**
 * The forecast structs are STALE GARBAGE outside a live forecast — they are not
 * cleared between battles, so a plain read always returns believable numbers.
 * gBattleTarget's class pointer at +0x04 is the documented gate: zero means the
 * pair has not been populated for this selection yet.
 */
async function forecastLive(m: MgbaClient): Promise<boolean> {
  const b = await readRange(m, A.battleTarget + 0x04, 4);
  return u32(b, 0) !== 0;
}

/**
 * Zero the forecast gate so that forecastLive() means "the game populated this
 * JUST NOW" instead of "a forecast happened at some point this session".
 *
 * The structs are never cleared by the game, so after the first forecast the raw
 * gate reads non-zero forever — it reported an attack target selection as open
 * while the cursor was demonstrably free on the map. Clearing first turns a
 * stale-prone read into a confirm-by-effect test, which is the only kind worth
 * making decisions on here: the item path uses it to refuse to press A when it
 * has accidentally opened Attack.
 */
async function clearForecastGate(m: MgbaClient): Promise<void> {
  await m.call("write_range", { address: A.battleTarget + 0x04, bytes: [0, 0, 0, 0] });
}

async function readForecast(m: MgbaClient): Promise<{ actor: BattleSide; target: BattleSide }> {
  const b = await readRange(m, A.battleActor, 0x100);
  return { actor: decodeSide(b, 0x00), target: decodeSide(b, 0x80) };
}

/** Attack count for one side: uses(before) - uses(after). 2 means it doubles. */
const blows = (s: BattleSide) => Math.max(0, s.usesBefore - s.usesAfter);

function formatSide(label: string, s: BattleSide, oppDef: number): string {
  const dmg = Math.max(0, s.atk - oppDef);
  const n = blows(s);
  return (
    `${label}: dmg ${dmg} x${n} (ATK ${s.atk} - DEF ${oppDef})  hit ${s.effHit}%  crit ${s.effCrit}%  ` +
    `AS ${s.as}  avo ${s.avo}  ddg ${s.dodge}`
  );
}

// ── Locating things that move ──────────────────────────────────────────────

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Is this a plausible live unit-struct address (any of the three arrays)? */
function unitRefFromAddr(addr: number): { array: number; slot: number } | null {
  for (const base of [A.playerArray, A.enemyArray, A.greenArray]) {
    const cap = SLOT_CAP[base] ?? 0;
    if (addr >= base && addr < base + cap * UNIT_STRIDE && (addr - base) % UNIT_STRIDE === 0) {
      return { array: base, slot: (addr - base) / UNIT_STRIDE };
    }
  }
  return null;
}

/**
 * Find the live menu by behaviour, never by address — the same logical menu lands
 * in a different arena slot almost every time, and stale copies survive at the old
 * addresses looking perfectly plausible.
 *
 * Presses Down (the index byte and its mirror move together as an adjacent pair),
 * then presses Up to put the highlight back where it was.
 *
 * DIFF TWICE: press_sequence returns when the input queue drains, not when the
 * game has settled, so the first diff routinely catches a mid-transition frame —
 * 30-70 bytes of sprite churn with no pair in sight. The second returns the
 * settled 4-7 with the pair obvious.
 */
async function locateMenu(m: MgbaClient): Promise<{ addr: number; count: number; index: number } | null> {
  await m.call("snapshot_memory", { name: "fe7_menu", address: A.uiArena, length: UI_ARENA_LEN });
  await press(m, [{ buttons: ["Down"], frames: 4, release_frames: 16 }]);

  let changes: Array<{ address: number; before: number; after: number }> = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(attempt === 0 ? 110 : 180);
    const r = await m.call<{ changes: unknown }>("diff_memory", {
      name: "fe7_menu", predicate: "changed", width: 1, max_results: 256,
    });
    changes = asArray<{ address: number; before: number; after: number }>(r.changes);
    if (changes.length > 0 && changes.length < 40) break;
  }

  // The index byte and its mirror move TOGETHER, so require both to show the
  // identical before/after transition. Sprite churn produces plenty of adjacent
  // changed bytes, but almost never a matched pair with a sane count in front.
  const byAddr = new Map(changes.map((c) => [c.address, c]));
  const cands: Array<{ addr: number; count: number; vDown: number }> = [];
  for (const c of changes) {
    const mirror = byAddr.get(c.address + 1);
    if (!mirror || mirror.before !== c.before || mirror.after !== c.after) continue;
    const b = await readRange(m, c.address - 1, 1);
    const count = b[0];
    if (count >= 2 && count <= 10 && c.after < count) cands.push({ addr: c.address, count, vDown: c.after });
  }

  // CONFIRM BY EFFECT. A pattern match is not enough — an earlier version of this
  // accepted a bogus 8-entry "menu", and the caller then drove Down/A against the
  // real menu and committed Wait, silently costing a unit its turn. So undo the
  // Down and require the candidate to move back exactly as a wrapping index must.
  await press(m, [{ buttons: ["Up"], frames: 4, release_frames: 16 }]);
  await sleep(120);

  for (const c of cands) {
    const b = await readRange(m, c.addr - 1, 3);
    const [count2, vUp, mirror2] = b;
    if (count2 !== c.count || vUp !== mirror2) continue;
    if (vUp !== (c.vDown - 1 + c.count) % c.count) continue;
    return { addr: c.addr, count: c.count, index: vUp };
  }
  return null;
}

/** Move a menu highlight from its current index to `to`, wrapping downward. */
async function menuGoTo(m: MgbaClient, menuAddr: number, to: number, count: number): Promise<boolean> {
  for (let guard = 0; guard < count + 2; guard++) {
    const b = await readRange(m, menuAddr, 1);
    if (b[0] === to) return true;
    await press(m, [{ buttons: ["Down"], frames: 4, release_frames: 16 }]);
    await sleep(60);
  }
  const b = await readRange(m, menuAddr, 1);
  return b[0] === to;
}

/**
 * Which unit is highlighted in a unit-target selection (staff target, trade
 * partner, rescue target, attack target).
 *
 * Two mechanisms. The staff proc signature is exact and side-effect free, so it
 * is tried first. The general form costs a Right press — it finds the 4-byte
 * slot holding the highlighted unit's struct address by seeing what moves — and
 * then a Left to put the highlight back.
 *
 * Do NOT reach for a remembered offset instead: the trade proc's +0x28 holds the
 * INITIAL partner and then goes stale, staying put across three Right presses
 * while the real highlight moved twice. Location is not semantics.
 */
async function findTargetPointerAddr(m: MgbaClient): Promise<number | null> {
  const r = await m.call<{ count: number; shown: unknown }>("search_memory", {
    bytes: STAFF_PROC_SIG, region: "EWRAM", align: 4, max_results: 8,
  });
  const shown = asArray<number>(r.shown);
  if (r.count === 1 && shown.length === 1) return shown[0] + STAFF_PROC_TARGET_OFF;

  await m.call("snapshot_memory", { name: "fe7_tgt", address: A.uiArena, length: UI_ARENA_LEN });
  await press(m, [{ buttons: ["Right"], frames: 4, release_frames: 18 }]);
  let hit: number | null = null;
  for (let attempt = 0; attempt < 3 && hit === null; attempt++) {
    await sleep(attempt === 0 ? 90 : 160);
    const d = await m.call<{ changes: unknown }>("diff_memory", {
      name: "fe7_tgt", predicate: "changed", width: 4, max_results: 256,
    });
    for (const c of asArray<{ address: number; before: number; after: number }>(d.changes)) {
      if (unitRefFromAddr(c.before >>> 0) && unitRefFromAddr(c.after >>> 0)) { hit = c.address; break; }
    }
  }
  await press(m, [{ buttons: ["Left"], frames: 4, release_frames: 18 }]);
  return hit;
}

/**
 * Which unit the attack forecast is currently aimed at.
 *
 * gBattleTarget embeds a COPY of the target's unit struct, so its tile, roster
 * index and max HP identify the selection outright — no proc search, no diff, no
 * side effects. This is strictly better than the generic pointer hunt for attacks,
 * where the generic hunt can also come up empty: with only one enemy in range a
 * Right press changes nothing, so there is no delta to find.
 *
 * Match on the TILE. +0x13 in this copy is the projected post-battle HP, not the
 * current HP, so matching on HP would fail exactly when the target is about to die.
 */
async function battleTargetTile(m: MgbaClient): Promise<{ x: number; y: number; maxHp: number; roster: number } | null> {
  if (!(await forecastLive(m))) return null;
  const b = await readRange(m, A.battleTarget, 0x14);
  return { x: b[0x10], y: b[0x11], maxHp: b[0x12], roster: b[0x0b] };
}

/** Cycle attack targets with Right until the forecast is aimed at `want`. */
async function cycleToEnemyTile(
  m: MgbaClient, wantX: number, wantY: number, maxSteps = 12,
): Promise<{ ok: boolean; landedX: number; landedY: number } | null> {
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= maxSteps; i++) {
    const t = await battleTargetTile(m);
    if (!t) return null;
    last = t;
    if (t.x === wantX && t.y === wantY) return { ok: true, landedX: t.x, landedY: t.y };
    await press(m, [{ buttons: ["Right"], frames: 4, release_frames: 18 }]);
    await sleep(90);
  }
  return { ok: false, landedX: last?.x ?? -1, landedY: last?.y ?? -1 };
}

async function readTargetRef(m: MgbaClient, ptrAddr: number): Promise<{ array: number; slot: number } | null> {
  const b = await readRange(m, ptrAddr, 4);
  return unitRefFromAddr(u32(b, 0));
}

/** Cycle a target selection with Right until it lands on `want`, verifying each step. */
async function cycleToTarget(
  m: MgbaClient, ptrAddr: number, wantArray: number, wantSlot: number, maxSteps = 12,
): Promise<boolean> {
  for (let i = 0; i <= maxSteps; i++) {
    const ref = await readTargetRef(m, ptrAddr);
    if (ref && ref.array === wantArray && ref.slot === wantSlot) return true;
    await press(m, [{ buttons: ["Right"], frames: 4, release_frames: 18 }]);
    await sleep(70);
  }
  const ref = await readTargetRef(m, ptrAddr);
  return !!ref && ref.array === wantArray && ref.slot === wantSlot;
}

/**
 * Press B until the unit is back where it started, unselected and unspent.
 *
 * Every pre-commit screen (Attack, Staff, Item, Rescue, Trade and their target
 * selections) unwinds with B; only Wait commits. Backing all the way out also
 * returns the unit to its origin tile, so a forecast leaves no trace.
 */
async function unwind(m: MgbaClient, slot: number, startX: number, startY: number, presses = 6): Promise<boolean> {
  for (let i = 0; i < presses; i++) {
    const v = await readUnit(m, A.playerArray, slot);
    if (v && !v.selected && !v.acted && v.x === startX && v.y === startY) return true;
    if (v?.acted) return false; // committed — B cannot take that back
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
    await sleep(140);
  }
  const v = await readUnit(m, A.playerArray, slot);
  return !!v && !v.selected && !v.acted && v.x === startX && v.y === startY;
}

/**
 * Wait for an action to commit, pressing A to clear anything blocking it.
 *
 * A LEVEL-UP screen blocks the spent flag: after a heal that levelled Lucius,
 * +0x0C stayed 0x01 and the staff uses stayed unchanged across consecutive reads
 * until three A presses dismissed the level-up, at which point everything landed
 * at once. A single post-action read is not enough for any action granting exp.
 */
/** Turn clock, for telling "already acted" apart from "not acted yet". */
async function phaseClock(m: MgbaClient): Promise<{ phase: number; turn: number }> {
  const b = await readRange(m, A.phase, 2);
  return { phase: b[0], turn: b[1] };
}

type Commit = { ok: boolean; via: "flag" | "phase" | "discard"; turnBefore: number; turnAfter: number };

// This polls has-acted AND presses A to clear dialogue (level-up, battle result,
// item-use text) that would otherwise stall forever. Two hazards, both hit live:
//
//  1. If this unit was the last unspent one, its action ends the player phase and
//     the NEW TURN CLEARS has-acted. Polling the flag alone then reads "never
//     committed" for an action that committed perfectly — and the loop keeps
//     pressing A. At 420ms over a 12s item timeout that is ~28 blind A presses
//     into a live map. Latch the turn clock and stop the moment it moves.
//  2. Never press A while the text buffer reads "Discard." — that is the item
//     sub-menu's other entry, and one more A there destroys the item. Observed
//     live on Lyn ch.1 with a Vulnerary. Bail out instead.
async function awaitCommit(m: MgbaClient, slot: number, timeoutMs = 25000): Promise<Commit> {
  const c0 = await phaseClock(m);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [c, v] = await Promise.all([phaseClock(m), readUnit(m, A.playerArray, slot)]);
    if (c.phase !== c0.phase || c.turn !== c0.turn) {
      return { ok: true, via: "phase", turnBefore: c0.turn, turnAfter: c.turn };
    }
    if (v?.acted) return { ok: true, via: "flag", turnBefore: c0.turn, turnAfter: c.turn };
    if (Date.now() >= deadline) return { ok: false, via: "flag", turnBefore: c0.turn, turnAfter: c.turn };
    if (/discard/i.test(await readText(m))) {
      return { ok: false, via: "discard", turnBefore: c0.turn, turnAfter: c.turn };
    }
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 14 }]);
    await sleep(420);
  }
}

// ── Run log ────────────────────────────────────────────────────────────────
//
// The point of a run is to find out what the tool layer cannot do. That list is
// worthless if it lives in a conversation that ends, so it is written to disk as
// it happens. TWO channels, because they catch different things:
//
//   1. Every fe7_* call and its result is appended automatically. This captures
//      tools FAILING — refused destinations, unlocatable menus, targets out of
//      range. No discipline required from the caller, and nothing is judged at
//      write time: everything is logged and triaged later, because deciding what
//      counts as a failure while writing is how you lose the interesting ones.
//
//   2. fe7_note, which the caller invokes deliberately. This captures tools
//      MISSING, which channel 1 structurally cannot see: if there is no rescue
//      action, nothing errors — the caller just never tries, and the log stays
//      silent. An absence produces no failure. Only the player knows it wanted
//      something that was not there.

const RUN_LOG =
  process.env.FE7_RUN_LOG ??
  `${process.env.HOME}/Desktop/repos/llm_plays_fe7/runs/${new Date().toISOString().slice(0, 10)}.jsonl`;

async function logLine(rec: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(RUN_LOG), { recursive: true });
    await appendFile(RUN_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");
  } catch {
    // Logging must never break play. A run that dies because its diary failed
    // to write would be the stupidest possible way to lose an afternoon.
  }
}

async function fe7Note(kind: string, detail: string, wanted: string): Promise<string> {
  await logLine({ kind: "note", note_kind: kind, detail, wanted });
  return (
    `Recorded to the run log (${RUN_LOG}):\n  [${kind}] ${detail}` +
    (wanted ? `\n  wanted: ${wanted}` : "") +
    `\nCarry on — this is for the backlog afterwards, not something to wait on.`
  );
}

// ── Tool implementations ───────────────────────────────────────────────────

async function fe7State(m: MgbaClient, brief: boolean): Promise<string> {
  const [ps, players, enemies, greens, cur] = await Promise.all([
    readRange(m, A.phase, 2),
    readArray(m, A.playerArray),
    readArray(m, A.enemyArray),
    readArray(m, A.greenArray),
    readCursor(m),
  ]);
  const phase = ps[0];
  const turn = ps[1];

  const alive = (u: Unit) => !u.dead;
  const live = players.filter((u) => u.deployed && alive(u));
  const foes = enemies.filter(alive);
  const npcs = greens.filter((u) => u.deployed && alive(u));

  const L: string[] = [];
  L.push(`Turn ${turn} | phase ${PHASE_NAME[phase] ?? `0x${hex2(phase)}`} | cursor (${cur.x},${cur.y})`);
  L.push(`players deployed ${live.length}/${players.length}  enemies alive ${foes.length}/${enemies.length}  green ${npcs.length}`);

  L.push(`PLAYERS:`);
  for (const u of live) {
    const st = u.acted ? " ACTED" : "";
    if (brief) {
      L.push(`  #${u.slot} cls${hex2(u.classId)} (${u.x},${u.y}) ${u.hp}/${u.maxHp}${st}`);
    } else {
      const items = u.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",");
      L.push(
        `  #${u.slot} r${hex2(u.roster)} cls${hex2(u.classId)} Lv${u.level} (${u.x},${u.y}) HP${u.hp}/${u.maxHp}` +
        ` S${u.str} K${u.skl} P${u.spd} D${u.def} R${u.res} L${u.lck}${st}` + (items ? ` [${items}]` : ""),
      );
    }
  }
  const benched = players.filter((u) => !u.deployed).length;
  const fallen = players.filter((u) => u.deployed && u.dead).length;
  if (benched || fallen) L.push(`  (${benched} benched, ${fallen} fallen)`);

  L.push(`ENEMIES:`);
  for (const u of foes) {
    if (brief) {
      L.push(`  #${u.slot} cls${hex2(u.classId)} (${u.x},${u.y}) ${u.hp}/${u.maxHp}`);
    } else {
      const items = u.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",");
      L.push(
        `  #${u.slot} cls${hex2(u.classId)} Lv${u.level} (${u.x},${u.y}) HP${u.hp}/${u.maxHp}` +
        ` S${u.str} K${u.skl} P${u.spd} D${u.def} R${u.res}` + (items ? ` [${items}]` : ""),
      );
    }
  }

  // Green units block destinations exactly like allies do, and they fight the
  // enemy on their own during the green phase, so their positions and HP matter.
  if (npcs.length) {
    L.push(`GREEN (allied NPCs — block tiles, act on the green phase):`);
    for (const u of npcs) {
      L.push(`  g${hex2(u.roster)} cls${hex2(u.classId)} Lv${u.level} (${u.x},${u.y}) HP${u.hp}/${u.maxHp}`);
    }
  }
  return L.join("\n");
}

/** Select a unit and return its decoded reachable set, then deselect. */
async function fe7Reachable(m: MgbaClient, slot: number, keepSelected: boolean): Promise<string> {
  const players = await readArray(m, A.playerArray);
  const enemies = await readArray(m, A.enemyArray);
  const greens = await readArray(m, A.greenArray);
  const u = bySlot(players, slot);
  if (!u) return `No player unit in slot ${slot}.`;
  if (!u.deployed) return `Unit #${slot} is benched (x=0xFF).`;
  if (u.dead) return `Unit #${slot} is dead.`;

  if (!u.selected) {
    if (!(await moveCursorTo(m, u.x, u.y))) return `Could not move cursor onto unit #${slot} at (${u.x},${u.y}) — input may be blocked.`;
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 20 }]);
    const okSel = await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && v.selected;
    }, 1500);
    if (!okSel) return `Pressed A on (${u.x},${u.y}) but unit #${slot} never became selected — input swallowed.`;
  }

  const grid = await readGrid(m);
  const bad = gridMismatch(grid, u);
  if (bad) {
    if (!keepSelected) await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return bad;
  }

  const occMap = occupancy(
    { units: players.filter((p) => p.slot !== slot), mark: "U" },
    { units: enemies, mark: "E" },
    { units: greens, mark: "G" },
  );
  const occupied = new Map<string, string>();
  for (const [k, v] of occMap) occupied.set(k, v.mark);

  // Bound the printed map to the interesting rows so output stays compact.
  let minY = grid.height, maxY = -1, minX = grid.stride, maxX = -1;
  const tiles: Array<{ x: number; y: number; cost: number }> = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.stride; x++) {
      if (grid.rows[y][x] !== UNREACHABLE) {
        tiles.push({ x, y, cost: grid.rows[y][x] });
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
    }
  }

  const L: string[] = [];
  if (tiles.length === 0) {
    L.push(`Unit #${slot} at (${u.x},${u.y}): grid is EMPTY — the movement map was not populated.`);
  } else {
    const legal = tiles.filter((t) => !occupied.has(`${t.x},${t.y}`));
    L.push(`Unit #${slot} cls${hex2(u.classId)} at (${u.x},${u.y}) — ${tiles.length} tiles in cost map, ${legal.length} legal destinations (unoccupied).`);
    L.push(`max cost ${Math.max(...tiles.map((t) => t.cost))} (= Move)`);
    L.push(`map ${grid.width}x${grid.height} (grid ${grid.rowCount} rows x stride ${grid.stride}, derived from the row-pointer table)`);
    const pad = (s: string) => s.padStart(2, " ");
    L.push(`     ${Array.from({ length: maxX - minX + 1 }, (_, i) => pad(String(minX + i))).join("")}`);
    for (let y = minY; y <= maxY; y++) {
      let row = "";
      for (let x = minX; x <= maxX; x++) {
        const c = grid.rows[y][x];
        if (c === UNREACHABLE) row += " .";
        else row += pad(occupied.get(`${x},${y}`) ?? String(c));
      }
      L.push(`  ${String(y).padStart(2, " ")} ${row}`);
    }
    L.push(`legend: digits = move cost (legal stop), U = ally, G = green NPC, E = enemy (all pass-through only), . = unreachable`);
  }

  if (!keepSelected) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && !v.selected;
    }, 1200);
  }
  return L.join("\n");
}

interface ActResult { text: string }

/**
 * The shared opening every unit action needs: verify it is legal to act, select
 * the unit, validate the destination against the game's own cost map, walk there
 * and confirm the walk landed.
 *
 * Extracted so staff / item / forecast all inherit the same checks — and, more
 * importantly, the same DIAGNOSTIC messages. A failure here names which of the
 * three distinguishable causes fired instead of reporting a generic no-op.
 */
type PrologueResult =
  | { ok: false; text: string }
  | {
      ok: true;
      u: Unit; players: Unit[]; enemies: Unit[]; greens: Unit[];
      cost: number; startX: number; startY: number;
    };

async function prologue(
  m: MgbaClient,
  slot: number,
  destX: number,
  destY: number,
): Promise<PrologueResult> {
  const phaseB = await readRange(m, A.phase, 1);
  if (phaseB[0] !== 0x00) {
    return { ok: false, text: `Refusing to act: phase byte is 0x${hex2(phaseB[0])} (${PHASE_NAME[phaseB[0]] ?? "?"}), not the player phase. Input would be swallowed.` };
  }

  const players = await readArray(m, A.playerArray);
  const enemies = await readArray(m, A.enemyArray);
  const greens = await readArray(m, A.greenArray);
  const u = bySlot(players, slot);
  if (!u) return { ok: false, text: `No player unit in slot ${slot}.` };
  if (!u.deployed) return { ok: false, text: `Unit #${slot} is benched.` };
  if (u.dead) return { ok: false, text: `Unit #${slot} is dead.` };
  if (u.acted) return { ok: false, text: `Unit #${slot} has already acted this phase (+0x0C = 0x42).` };

  const startX = u.x, startY = u.y;

  // 1. Cursor onto the unit, then select.
  if (!u.selected) {
    if (!(await moveCursorTo(m, startX, startY))) {
      return { ok: false, text: `Could not drive the cursor onto unit #${slot} at (${startX},${startY}). Input appears blocked (event/animation).` };
    }
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 20 }]);
    const okSel = await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && v.selected;
    }, 1500);
    if (!okSel) return { ok: false, text: `Selection failed: pressed A on (${startX},${startY}) but +0x0C bit 0 never set.` };
  }

  // 2. Validate the destination against the game's own cost map BEFORE pressing.
  //    This is what makes a later failure diagnosable.
  const grid = await readGrid(m);
  const bad = gridMismatch(grid, { x: startX, y: startY });
  if (bad) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { ok: false, text: `${bad} Move cancelled; unit #${slot} still at (${startX},${startY}) and unspent.` };
  }
  const cost = gridCost(grid, destX, destY);
  if (cost === UNREACHABLE) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { ok: false, text: `Destination (${destX},${destY}) is NOT reachable for unit #${slot} (grid = 0xFF: out of range, or blocked terrain). Move cancelled; unit still at (${startX},${startY}) and unspent.` };
  }
  // Occupancy must cover ALL THREE factions. Green NPCs were the cause of a
  // whole class of "legal but refused" failures before they were included here:
  // they sit in the cost map as pass-through, exactly like allies.
  const occ = occupancy(
    { units: players.filter((o) => o.slot !== slot), mark: "ally" },
    { units: enemies, mark: "enemy" },
    { units: greens, mark: "green" },
  ).get(`${destX},${destY}`);
  if (occ) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { ok: false, text: `Destination (${destX},${destY}) has cost ${cost} but is OCCUPIED by a ${occ.mark} unit (slot #${occ.u.slot}, cls${hex2(occ.u.classId)}, HP ${occ.u.hp}/${occ.u.maxHp}). The cost map allows routing through units but not stopping on them. Move cancelled.` };
  }

  // 3. Drive to the destination and confirm.
  if (!(await moveCursorTo(m, destX, destY))) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { ok: false, text: `Could not drive the cursor to (${destX},${destY}) while unit #${slot} was selected. Move cancelled.` };
  }
  await press(m, [{ buttons: ["A"], frames: 4, release_frames: 10 }]);

  // Wait for the walk animation: the unit's own coordinates are the signal.
  const moved = await waitUntil(async () => {
    const v = await readUnit(m, A.playerArray, slot);
    return !!v && v.x === destX && v.y === destY;
  }, 4000);
  if (!moved) {
    // Do NOT call this a dropped input. That claim was wrong in practice: green
    // NPCs occupying the tile produced this exact signature while the cost map
    // still read it as reachable. Retrying is what separates the two cases —
    // a dropped input succeeds on the retry, a refused tile fails identically.
    const v = await readUnit(m, A.playerArray, slot);
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return {
      ok: false,
      text:
        `Pressed A at (${destX},${destY}) (cost ${cost}, no unit found there in any of the three arrays) ` +
        `but unit #${slot} is still at (${v?.x},${v?.y}). The game REFUSED the destination for a reason not ` +
        `visible in the cost map — most likely a unit this tool cannot see, or special terrain — or the press ` +
        `was genuinely dropped. Retry once: success means it was a dropped input, an identical failure means ` +
        `the tile is refused and you should pick another. Move cancelled; unit is unspent.`,
    };
  }

  // Let the walk animation and menu slide finish before touching the menu.
  await sleep(260);

  const fresh = await readUnit(m, A.playerArray, slot);
  return {
    ok: true,
    u: fresh ?? u, players, enemies, greens,
    cost, startX, startY,
  };
}

async function fe7Act(
  m: MgbaClient,
  slot: number,
  destX: number,
  destY: number,
  action: string,
  targetCycle: number,
  targetSlot: number | null,
  itemSlot: number | null,
  targetFaction: string,
): Promise<ActResult> {
  const pro = await prologue(m, slot, destX, destY);
  if (!pro.ok) return { text: pro.text };
  const { u, players, enemies, greens, cost, startX, startY } = pro;


  if (action === "wait") {
    const w = await commitWait(m, A.playerArray, slot);
    const v = await readUnit(m, A.playerArray, slot);
    if (w.ok && w.via === "phase") {
      return {
        text: `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, Wait committed. ` +
          `It was the last unspent unit, so the player phase ended (turn ${w.turnBefore} -> ${w.turnAfter}). ` +
          `Its has-acted flag has already been cleared by the new turn — that is success, not failure.`,
      };
    }
    if (!w.ok && w.via === "nomenu") {
      return {
        text:
          `Unit #${slot} MOVED to (${destX},${destY}) cost ${cost}, but Wait was NOT confirmed and the action menu ` +
          `was not open when the retry ran — the Up press moved the map cursor instead, so nothing had focus. ` +
          `Cursor restored and NO A was sent at the board (that is what could otherwise open the field menu and ` +
          `end the phase). Unit's +0x0C = 0x${hex2((v?.flags ?? 0) & 0xff)}; the turn did not advance. ` +
          `The move landed; re-issue the action if the unit is still unspent.`,
      };
    }
    return {
      text: w.ok
        ? `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, Wait committed (+0x0C = 0x42).`
        : `Unit #${slot} MOVED to (${destX},${destY}) but Wait did not commit after retries (+0x0C = 0x${hex2((v?.flags ?? 0) & 0xff)}). The action menu is probably still open.`,
    };
  }

  if (action === "attack") {
    // Range comes from the WEAPONS THIS UNIT CAN ACTUALLY USE, not from an
    // assumption of melee. Hardcoding distance == 1 silently refused every hand
    // axe, bow and tome attack and made the unit Wait instead — wasting the turn
    // and reporting "no enemy is adjacent", which was true and irrelevant.
    let minR = 99, maxR = 0;
    for (const it of u.items) {
      const t = await itemType(m, it.id);
      if (t === WTYPE_STAFF || t === 9 || u.ranks[t] === 0) continue;
      const r = await itemRange(m, it.id);
      if (r.max > maxR) maxR = r.max;
      if (r.min < minR) minR = r.min;
    }
    const adj = maxR === 0 ? [] : enemies.filter((e) => {
      if (e.dead) return false;
      const d = Math.abs(e.x - destX) + Math.abs(e.y - destY);
      return d >= minR && d <= maxR;
    });
    if (adj.length === 0) {
      const committed = await commitWait(m, A.playerArray, slot);
      const why = maxR === 0
        ? `unit #${slot} has no usable weapon (inventory ${u.items.map((i) => hex2(i.id)).join(",") || "empty"})`
        : `no enemy is within its weapon range ${minR}-${maxR} of (${destX},${destY})`;
      return { text: `Unit #${slot} moved to (${destX},${destY}) but Attack is unavailable — ${why}. ${committed ? "Waited instead." : "Wait also failed to commit."}` };
    }
    const before = adj.map((e) => ({ slot: e.slot, hp: e.hp }));

    // The attack flow has a VARIABLE number of steps:
    //   Attack -> [weapon list, only if the unit carries >1 usable weapon]
    //          -> target select -> confirm
    // Hardcoding two A presses stalled on a 3-step flow; hardcoding three
    // would overshoot on a 2-step flow and the surplus A opens the field menu
    // (observed — it left Suspend one keypress away). So advance one step at a
    // time and stop the moment the unit reports spent.
    let picked = false;
    let forecast = "";
    await clearForecastGate(m);
    for (let step = 0; step < 4; step++) {
      await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);

      // The forecast pair is populated exactly when target select is up, so it
      // tells us we have arrived without counting menu steps. Target choice used
      // to be blind Right presses verified only from the HP deltas afterwards —
      // which meant a wrong pick was discovered by killing the wrong unit.
      if (!picked && (await forecastLive(m))) {
        picked = true;
        if (targetSlot !== null) {
          const want = bySlot(enemies, targetSlot);
          if (!want) {
            await unwind(m, slot, startX, startY);
            return { text: `No enemy in slot ${targetSlot}. Unit #${slot} left unspent at (${startX},${startY}).` };
          }
          const landed = await cycleToEnemyTile(m, want.x, want.y);
          if (!landed || !landed.ok) {
            await unwind(m, slot, startX, startY);
            return {
              text:
                `Could not aim at enemy #${targetSlot} at (${want.x},${want.y}) from (${destX},${destY}) — the forecast ` +
                `settled on (${landed?.landedX},${landed?.landedY}). It is probably out of this weapon's range. ` +
                `Nothing was committed; unit #${slot} is unwound to (${startX},${startY}) and unspent.`,
            };
          }
        } else if (targetCycle > 0) {
          await press(m, Array.from({ length: targetCycle }, () => ({ buttons: ["Right"], frames: 4, release_frames: 12 })));
        }
        const f = await readForecast(m);
        forecast =
          `\n  forecast  ${formatSide("attacker", f.actor, f.target.def)}` +
          `\n            ${formatSide("defender", f.target, f.actor.def)}`;
      }
      // Stop pressing as soon as EITHER the unit is spent OR combat has visibly
      // started (any adjacent enemy's HP moved, or it died and left a hole).
      //
      // Waiting only on `spent` overshoots badly: a fight takes longer than any
      // sane per-step timeout, so the loop fired one more A after the fight had
      // already resolved, and that surplus press opens the FIELD MENU — which
      // sits one keypress away from Suspend. Observed twice.
      const started = await waitUntil(async () => {
        const v = await readUnit(m, A.playerArray, slot);
        if (v?.acted) return true;
        const now = await readArray(m, A.enemyArray);
        return before.some((b) => {
          const n = bySlot(now, b.slot);
          return !n || n.hp !== b.hp;
        });
      }, 3000, 120);
      if (started) break;
    }

    // Combat resolves long after the last menu press. Wait it out WITHOUT
    // pressing anything further.
    await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && v.acted;
    }, 25000, 150);

    // Combat + animation can run long; wait on the unit becoming spent. As with
    // Wait and Item, a unit that was the last unspent one ends the phase, and the
    // new turn clears has-acted — so the turn clock, not the flag, is the truth.
    // This path presses nothing while polling, so the old bug only mis-REPORTED.
    const clk0 = await phaseClock(m);
    let endedPhase = false;
    const done = await waitUntil(async () => {
      const [c, v] = await Promise.all([phaseClock(m), readUnit(m, A.playerArray, slot)]);
      if (c.phase !== clk0.phase || c.turn !== clk0.turn) { endedPhase = true; return true; }
      return !!v && v.acted;
    }, 20000, 100);

    const after = await readArray(m, A.enemyArray);
    const self = await readUnit(m, A.playerArray, slot);
    const deltas = before
      .map((b) => {
        const now = bySlot(after, b.slot);
        return now ? `#${b.slot} ${b.hp}->${now.hp}${now.hp === 0 ? " KILLED" : ""}` : `#${b.slot} gone`;
      })
      .join(", ");
    return {
      text: done
        ? `Unit #${slot} attacked from (${destX},${destY}). Enemy HP: ${deltas}. Self: HP ${self?.hp}/${self?.maxHp}, ` +
          (endedPhase
            ? `and it was the last unspent unit, so the player phase ended.${forecast}`
            : `+0x0C=0x${hex2((self?.flags ?? 0) & 0xff)}.${forecast}`)
        : `Unit #${slot} moved to (${destX},${destY}) and Attack was chosen, but the unit never became spent within 20s. Enemy HP: ${deltas}. Something is still on screen.`,
    };
  }

  // ── Staff and Item ───────────────────────────────────────────────────────
  //
  // Both need the action menu's entry index, and the index is NOT derivable:
  // FE7 omits entries that don't apply, so the count shifts with adjacency and
  // terrain, and one observed 5-entry menu still has an unidentified extra
  // entry. So we TRY a candidate and verify by effect before going deeper.
  //
  // That is safe because of a structural fact: from the action menu, the first
  // A can only open a list or a target selection, and the second A can only
  // open a target selection or a sub-menu. Neither commits. Only the THIRD A
  // commits — so every path below confirms what it is looking at before ever
  // pressing a third time.
  //
  // The two exceptions are Rescue and Trade, which jump straight to a target
  // selection where the SECOND A would commit. Both announce themselves in the
  // ASCII buffer ("unit to rescue." / "unit to trade with."), so they are
  // detected and unwound after the first press.

  if (action === "staff" || action === "item") {
    const label = action === "staff" ? "Staff" : "Item";

    if (action === "staff" && targetSlot === null) {
      await unwind(m, slot, startX, startY);
      return { text: `action="staff" needs target_slot (who to heal). Unit #${slot} left unspent at (${startX},${startY}).` };
    }
    const staves = action === "staff" ? await staffSlots(m, u) : [];
    if (action === "staff" && staves.length === 0) {
      await unwind(m, slot, startX, startY);
      return { text: `Unit #${slot} carries no staff (inventory: ${u.items.map((i) => hex2(i.id)).join(",") || "empty"}). Left unspent at (${startX},${startY}).` };
    }
    // Carrying a staff is not the same as being able to swing it. Rank 0 in the
    // weapon-rank block means the class cannot use that type at all, so the game
    // omits Staff from the menu entirely — observed on a unit hauling a Heal staff
    // it could not use. Check the rank first; otherwise we would drive the whole
    // menu scan looking for an entry that was never going to be there.
    if (action === "staff" && u.ranks[WTYPE_STAFF] === 0) {
      await unwind(m, slot, startX, startY);
      return {
        text:
          `Unit #${slot} carries a staff (${staves.map((i) => hex2(u.items[i].id)).join(",")}) but has STAFF RANK 0 — ` +
          `its class cannot use staves, so the game offers no Staff entry. It is only carrying it. Left unspent at (${startX},${startY}).`,
      };
    }
    if (action === "item" && u.items.length === 0) {
      await unwind(m, slot, startX, startY);
      return { text: `Unit #${slot} carries no items. Left unspent at (${startX},${startY}).` };
    }

    // Which entry of the sub-list we want: for a staff, the staff list holds only
    // type-4 items in inventory order, so an inventory slot has to be mapped into
    // that shorter list. For an item, list index == inventory slot exactly.
    const wantInvSlot = itemSlot ?? (action === "staff" ? staves[0] : 0);
    const listIndex = action === "staff" ? Math.max(0, staves.indexOf(wantInvSlot)) : wantInvSlot;
    if (action === "item" && wantInvSlot >= u.items.length) {
      await unwind(m, slot, startX, startY);
      return { text: `item_slot ${wantInvSlot} is out of range — unit #${slot} carries ${u.items.length} item(s). Left unspent.` };
    }

    const menu = await locateMenu(m);
    if (!menu) {
      await unwind(m, slot, startX, startY);
      return { text: `Unit #${slot} moved to (${destX},${destY}) but the action menu could not be located by diff. Left unspent — retry, or use action="wait".` };
    }

    // DERIVE the entry index; do not scan for it. Scanning meant pressing A on
    // entries that could not be identified in advance, and a bad guess is
    // expensive: one run committed Wait and cost a unit its turn, another left two
    // units sharing a tile. The order is fixed — Attack, Staff, Rescue, Item,
    // Trade, ..., Wait — and the one entry we cannot predict (Rescue, which needs
    // Con and Aid that the live struct does not expose) never moves either target:
    //   Staff is 0, or 1 when Attack is present. Rescue sits BELOW it.
    //   Item is counted from the BOTTOM — Wait last, Trade above it when present.
    //   Rescue sits ABOVE Item.
    let hasAttack = false;
    for (const it of u.items) {
      const t = await itemType(m, it.id);
      if (t === WTYPE_STAFF || t === 9 || u.ranks[t] === 0) continue;
      const rng = await itemRange(m, it.id);
      if (enemies.some((e) => {
        if (e.dead) return false;
        const d = Math.abs(e.x - destX) + Math.abs(e.y - destY);
        return d >= rng.min && d <= rng.max;
      })) { hasAttack = true; break; }
    }
    const hasTrade = players.some(
      (o) => o.slot !== slot && o.deployed && !o.dead &&
             Math.abs(o.x - destX) + Math.abs(o.y - destY) === 1,
    );

    const wantIndex = action === "staff"
      ? (hasAttack ? 1 : 0)
      : menu.count - 2 - (hasTrade ? 1 : 0);

    const shape = `menu count ${menu.count}, attack ${hasAttack ? "yes" : "no"}, trade ${hasTrade ? "yes" : "no"} -> index ${wantIndex}`;
    if (wantIndex < 0 || wantIndex > menu.count - 2) {
      await unwind(m, slot, startX, startY);
      return { text: `Could not place ${label} in unit #${slot}'s action menu (${shape}). Refusing to guess — the last entry is Wait and pressing it would spend the turn. Unit unwound to (${startX},${startY}), unspent.` };
    }
    if (!(await menuGoTo(m, menu.addr, wantIndex, menu.count))) {
      await unwind(m, slot, startX, startY);
      return { text: `Could not move unit #${slot}'s action-menu highlight to index ${wantIndex} (${shape}). Nothing pressed; unit unwound and unspent.` };
    }

    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 24 }]);
    await sleep(200);

    // Rescue and Trade jump straight to a target selection where the NEXT A
    // commits. If the derivation was wrong and we landed on one, stop here.
    const opened = await readText(m);
    if (/unit to rescue|unit to trade/i.test(opened)) {
      await unwind(m, slot, startX, startY);
      return { text: `Index ${wantIndex} opened ${opened.includes("rescue") ? "Rescue" : "Trade"}, not ${label} (${shape}). Backed out before anything committed; unit #${slot} unspent at (${startX},${startY}).` };
    }

    // A one-entry sub-list (a single staff) cannot be located by diff — Down moves
    // nothing, so there is no delta. Only look when we need a later entry.
    const list = listIndex === 0 ? null : await locateMenu(m);
    if (listIndex > 0 && !list) {
      await unwind(m, slot, startX, startY);
      return { text: `Opened ${label}'s list but could not locate it to reach entry ${listIndex}. Backed out; unit #${slot} unspent.` };
    }
    if (list && !(await menuGoTo(m, list.addr, listIndex, list.count))) {
      await unwind(m, slot, startX, startY);
      return { text: `Could not move ${label}'s list highlight to entry ${listIndex}. Backed out; unit #${slot} unspent.` };
    }

    await clearForecastGate(m);
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    await sleep(240);

    if (action === "item") {
      // DECISIVE GUARD. If this was really the weapon list we are now in attack
      // target select, where the next A commits an attack. The forecast pair is
      // populated exactly there and nowhere else.
      if (await forecastLive(m)) {
        await unwind(m, slot, startX, startY);
        return { text: `Index ${wantIndex} turned out to be Attack, not Item (${shape}) — the forecast went live. Backed out before committing; unit #${slot} unspent at (${startX},${startY}).` };
      }
      const sub = await locateMenu(m);
      if (!sub || !(await menuGoTo(m, sub.addr, 0, sub.count))) {
        await unwind(m, slot, startX, startY);
        return { text: `Reached an item sub-menu but could not put the highlight on Use. Backed out; unit #${slot} unspent. (Discard is the LAST entry — never guessed at.)` };
      }

      const beforeHp = (await readUnit(m, A.playerArray, slot))?.hp ?? u.hp;
      await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
      const c = await awaitCommit(m, slot, 12000);
      const after = await readUnit(m, A.playerArray, slot);
      const note = await readText(m);
      if (c.ok && c.via === "phase") {
        return {
          text:
            `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, used item ` +
            `${hex2(u.items[wantInvSlot].id)} (inv slot ${wantInvSlot}). HP ${beforeHp} -> ${after?.hp}/${after?.maxHp}. ` +
            `It was the last unspent unit, so the player phase ended (turn ${c.turnBefore} -> ${c.turnAfter}); ` +
            `its has-acted flag has already been cleared by the new turn — that is success, not failure.`,
        };
      }
      if (c.via === "discard") {
        await unwind(m, slot, startX, startY);
        return {
          text:
            `ABORTED before pressing A again: the text buffer read "Discard.", meaning the highlight was on the ` +
            `item sub-menu's Discard entry, not Use. One more A would have destroyed item ` +
            `${hex2(u.items[wantInvSlot].id)}. HP ${beforeHp} -> ${after?.hp}. Backed out; unit #${slot} unspent.`,
        };
      }
      if (!c.ok) {
        // A full-HP unit produces IDENTICAL menu shapes and simply refuses. The
        // menus never tell you an item is unusable — only the effect does.
        await unwind(m, slot, startX, startY);
        return {
          text:
            `Unit #${slot} selected item ${hex2(u.items[wantInvSlot].id)} but nothing committed. HP ${beforeHp} -> ${after?.hp}. ` +
            `Text buffer: ${JSON.stringify(note)}. ` +
            (/no need/i.test(note) ? `The game REFUSED it (already at full HP). ` : ``) +
            `Unit left unspent at (${after?.x},${after?.y}).`,
        };
      }
      return {
        text:
          `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, used item ${hex2(u.items[wantInvSlot].id)} ` +
          `(inv slot ${wantInvSlot}). HP ${beforeHp} -> ${after?.hp}/${after?.maxHp}. +0x0C=0x${hex2((after?.flags ?? 0) & 0xff)}.`,
      };
    }

    // ── staff ──
    // The staff proc signature is present in exactly one place during staff target
    // select and nowhere else, so finding it PROVES the state rather than guessing.
    const ptr = await findTargetPointerAddr(m);
    const ref0 = ptr ? await readTargetRef(m, ptr) : null;
    if (!ptr || !ref0) {
      await unwind(m, slot, startX, startY);
      return { text: `Index ${wantIndex} did not lead to staff target select (${shape}) — the staff proc signature was not found. Backed out; unit #${slot} unspent at (${startX},${startY}).` };
    }

    const wantArray = targetFaction === "green" ? A.greenArray : A.playerArray;
    const tgtBefore = await readUnit(m, wantArray, targetSlot as number);
    if (!tgtBefore) {
      await unwind(m, slot, startX, startY);
      return { text: `No ${targetFaction} unit in slot ${targetSlot} to heal. Unit #${slot} left unspent.` };
    }
    if (!(await cycleToTarget(m, ptr, wantArray, targetSlot as number))) {
      const cur = await readTargetRef(m, ptr);
      await unwind(m, slot, startX, startY);
      return {
        text:
          `Could not cycle the staff target onto ${targetFaction} #${targetSlot} at (${tgtBefore.x},${tgtBefore.y}) — ` +
          `it settled on ${cur ? `slot #${cur.slot}` : "nothing readable"}. Most likely out of range from (${destX},${destY}). ` +
          `Unit #${slot} left unspent.`,
      };
    }

    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    const c = await awaitCommit(m, slot, 25000);
    const tgtAfter = await readUnit(m, wantArray, targetSlot as number);
    const self = await readUnit(m, A.playerArray, slot);
    const staffId = u.items[wantInvSlot]?.id ?? 0;
    if (c.ok && c.via === "phase") {
      return {
        text:
          `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, used staff ${hex2(staffId)} on ` +
          `${targetFaction} #${targetSlot} — HP ${tgtBefore.hp} -> ${tgtAfter?.hp}/${tgtAfter?.maxHp} ` +
          `(+${(tgtAfter?.hp ?? 0) - tgtBefore.hp}). It was the last unspent unit, so the player phase ended ` +
          `(turn ${c.turnBefore} -> ${c.turnAfter}); the cleared has-acted flag is success, not failure.`,
      };
    }
    if (!c.ok) {
      return { text: `Unit #${slot} selected ${targetFaction} #${targetSlot} for staff ${hex2(staffId)} but never became spent. Target HP ${tgtBefore.hp} -> ${tgtAfter?.hp}. Something is still on screen.` };
    }
    return {
      text:
        `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, used staff ${hex2(staffId)} on ` +
        `${targetFaction} #${targetSlot} — HP ${tgtBefore.hp} -> ${tgtAfter?.hp}/${tgtAfter?.maxHp} ` +
        `(+${(tgtAfter?.hp ?? 0) - tgtBefore.hp}). +0x0C=0x${hex2((self?.flags ?? 0) & 0xff)}.`,
    };
  }

  return { text: `Unknown action "${action}". Use "wait", "attack", "staff" or "item".` };
}

/**
 * Read the combat forecast for a hypothetical attack, then put everything back.
 *
 * NOT a pure read, despite the name. The forecast pair is stale garbage until
 * target select is actually on screen, so this has to select the unit, walk it,
 * open Attack, read, and then unwind — which also returns the unit to its origin
 * tile. It ends with the unit exactly as it started: unmoved, unselected, unspent.
 *
 * Everything reported comes out of the game's own BattleUnit structs. Do not be
 * tempted to recompute any of it from base stats: support bonuses are already
 * folded in (a control run measured +1 Def / +5 Avo / +2 Crit / +5 Ddg on a unit
 * standing near allies, which vanished when the allies were moved away), as are
 * terrain and the weapon triangle.
 */
async function fe7Forecast(
  m: MgbaClient,
  slot: number,
  destX: number,
  destY: number,
  targetSlot: number | null,
): Promise<string> {
  const pro = await prologue(m, slot, destX, destY);
  if (!pro.ok) return pro.text;
  const { u, enemies, startX, startY } = pro;

  const menu = await locateMenu(m);
  if (!menu) {
    await unwind(m, slot, startX, startY);
    return `Unit #${slot} reached (${destX},${destY}) but the action menu could not be located. Nothing changed.`;
  }

  const tried: string[] = [];
  for (let cand = 0; cand < menu.count - 1; cand++) {
    if (!(await menuGoTo(m, menu.addr, cand, menu.count))) continue;
    await clearForecastGate(m);
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 24 }]);
    await sleep(180);

    const txt = await readText(m);
    if (/unit to rescue|unit to trade/i.test(txt)) {
      tried.push(`${cand}=${txt.includes("rescue") ? "Rescue" : "Trade"}`);
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(140);
      continue;
    }

    // Attack opens a weapon list; one more A reaches target select. Both presses
    // are safe — only a third commits.
    let live = await forecastLive(m);
    if (!live) {
      await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
      await sleep(220);
      live = await forecastLive(m);
    }
    if (!live) {
      tried.push(`${cand}=no-forecast`);
      await press(m, [
        { buttons: ["B"], frames: 4, release_frames: 22 },
        { buttons: ["B"], frames: 4, release_frames: 22 },
      ]);
      await sleep(160);
      continue;
    }

    if (targetSlot !== null) {
      const want = bySlot(enemies, targetSlot);
      if (!want) {
        await unwind(m, slot, startX, startY);
        return `No enemy in slot ${targetSlot}. Nothing changed.`;
      }
      const landed = await cycleToEnemyTile(m, want.x, want.y);
      if (!landed || !landed.ok) {
        await unwind(m, slot, startX, startY);
        return (
          `Could not aim at enemy #${targetSlot} at (${want.x},${want.y}) from (${destX},${destY}) — the forecast ` +
          `settled on (${landed?.landedX},${landed?.landedY}). Probably out of range. Nothing changed.`
        );
      }
    }

    const f = await readForecast(m);
    const t = await battleTargetTile(m);
    const foe = t ? enemies.find((e) => e.x === t.x && e.y === t.y) ?? null : null;

    const restored = await unwind(m, slot, startX, startY);
    const lines = [
      `Forecast — unit #${slot} cls${hex2(u.classId)} attacking from (${destX},${destY})` +
        (foe ? ` vs enemy #${foe.slot} cls${hex2(foe.classId)} at (${foe.x},${foe.y}) HP ${foe.hp}/${foe.maxHp}`
             : t ? ` vs the unit on (${t.x},${t.y}) (not matched to an enemy slot)` : ""),
      `  ${formatSide("attacker", f.actor, f.target.def)}`,
      `  ${formatSide("defender", f.target, f.actor.def)}`,
      `  projected HP after: attacker ${f.actor.projHp}, defender ${f.target.projHp}` +
        `  <- a deterministic every-blow-lands projection, NOT a prediction; real combat rolls hit and crit`,
      restored
        ? `  (unit returned to (${startX},${startY}), unselected and unspent — nothing was committed)`
        : `  WARNING: could not fully unwind. Check fe7_state before acting.`,
    ];
    return lines.join("\n");
  }

  await unwind(m, slot, startX, startY);
  return (
    `Unit #${slot} moved to (${destX},${destY}) but no menu entry led to a forecast ` +
    `(menu count ${menu.count}; tried ${tried.join(", ") || "nothing"}). Most likely nothing is in range. Nothing changed.`
  );
}

/**
 * Move one item between two adjacent units.
 *
 * Trade does NOT consume the action — after backing out, +0x0C is still 0x01 and
 * the action menu reopens — so this is free to do before deciding what a unit
 * actually does. That is the whole reason it is its own tool rather than an
 * action on fe7_act, whose contract is "commit this unit's turn".
 *
 * LIMITATION: the two units must ALREADY be adjacent; pass the acting unit's
 * current tile. Trading after a move is not supported, because whether cancelling
 * the move also reverts an already-written trade has not been tested, and
 * guessing wrong would silently corrupt inventories.
 */
async function fe7Trade(
  m: MgbaClient,
  slot: number,
  partnerSlot: number,
  giveItemSlot: number,
): Promise<string> {
  const players = await readArray(m, A.playerArray);
  const me = bySlot(players, slot);
  const partner = bySlot(players, partnerSlot);
  if (!me) return `No player unit in slot ${slot}.`;
  if (!partner) return `No player unit in slot ${partnerSlot}.`;
  if (me.acted) return `Unit #${slot} has already acted.`;
  const dist = Math.abs(me.x - partner.x) + Math.abs(me.y - partner.y);
  if (dist !== 1) {
    return (
      `Units #${slot} (${me.x},${me.y}) and #${partnerSlot} (${partner.x},${partner.y}) are ${dist} tiles apart; ` +
      `trade needs them adjacent. Move one with fe7_act first — this tool deliberately does not move units.`
    );
  }
  if (giveItemSlot >= me.items.length) {
    return `item_slot ${giveItemSlot} is out of range — unit #${slot} carries ${me.items.length} item(s).`;
  }
  if (partner.items.length >= 5) {
    return `Unit #${partnerSlot} already carries 5 items; there is no free slot to receive one.`;
  }

  const invBefore = async (u: Unit) => (await readRange(m, u.addr + 0x1e, 10)).map(hex2).join(" ");
  const meBefore = await invBefore(me);
  const partnerBefore = await invBefore(partner);

  const pro = await prologue(m, slot, me.x, me.y);
  if (!pro.ok) return pro.text;
  const { startX, startY } = pro;

  const menu = await locateMenu(m);
  if (!menu) {
    await unwind(m, slot, startX, startY);
    return `Could not locate unit #${slot}'s action menu. Nothing changed.`;
  }

  for (let cand = menu.count - 2; cand >= 0; cand--) {
    // Trade sits immediately above Wait when present, so scan upward from the
    // bottom — everything whose presence we cannot predict (Attack, Staff,
    // Rescue) sits ABOVE Trade in the fixed order.
    if (!(await menuGoTo(m, menu.addr, cand, menu.count))) continue;
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 24 }]);
    await sleep(200);

    // The "…unit to trade with." prompt is TRANSIENT — by the time we read the
    // buffer it has often been overwritten (observed: an item description, then a
    // weapon name). So identify Trade structurally instead: it is the only entry
    // at count-2 that opens a unit-target selection rather than a list.
    const asc = await readText(m);
    if (/unit to rescue/i.test(asc)) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(140);
      continue;
    }
    // In a unit-target selection the MAP CURSOR jumps onto the highlighted unit;
    // a menu never moves it. That is a cheap, reliable discriminator — and unlike
    // locateMenu it has no side effects, which matters because locateMenu's own
    // Down press moves the partner highlight and then finds a false "menu".
    const cur = await readCursor(m);
    const onAlly = players.some(
      (o) => o.slot !== slot && o.deployed && !o.dead && o.x === cur.x && o.y === cur.y,
    );
    if (!onAlly) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(140);
      continue;
    }

    const ptr = await findTargetPointerAddr(m);
    if (!ptr || !(await cycleToTarget(m, ptr, A.playerArray, partnerSlot))) {
      await unwind(m, slot, startX, startY);
      return `Reached trade partner select but could not put the highlight on #${partnerSlot}. Nothing changed.`;
    }
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    await sleep(300);

    // The trade screen's two cursor fields live in a dynamically allocated
    // struct, so find them by what moves. Do NOT reuse a remembered offset: the
    // trade proc's +0x28 holds the INITIAL partner and then goes stale, which
    // already fooled one investigation.
    const findByPress = async (btn: string, back: string): Promise<number | null> => {
      await m.call("snapshot_memory", { name: "fe7_trade", address: A.uiArena, length: UI_ARENA_LEN });
      await press(m, [{ buttons: [btn], frames: 4, release_frames: 18 }]);
      let hit: number | null = null;
      for (let a = 0; a < 3 && hit === null; a++) {
        await sleep(a === 0 ? 90 : 160);
        const d = await m.call<{ changes: unknown }>("diff_memory", {
          name: "fe7_trade", predicate: "changed", width: 1, max_results: 256,
        });
        const ch = asArray<{ address: number; before: number; after: number }>(d.changes);
        if (ch.length > 0 && ch.length < 30) {
          const c = ch.find((x) => x.before < 8 && x.after < 8 && x.before !== x.after);
          if (c) hit = c.address;
        }
      }
      await press(m, [{ buttons: [back], frames: 4, release_frames: 18 }]);
      return hit;
    };

    const rowAddr = await findByPress("Down", "Up");
    const colAddr = await findByPress("Right", "Left");
    if (rowAddr === null || colAddr === null) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 24 }]);
      await unwind(m, slot, startX, startY);
      return `Opened the trade screen but could not locate its row/column cursor bytes by diff. Backed out; nothing changed.`;
    }

    // Column 0 is the acting unit's list.
    for (let g = 0; g < 4; g++) {
      if ((await readRange(m, colAddr, 1))[0] === 0) break;
      await press(m, [{ buttons: ["Left"], frames: 4, release_frames: 18 }]);
      await sleep(70);
    }
    for (let g = 0; g < 8; g++) {
      if ((await readRange(m, rowAddr, 1))[0] === giveItemSlot) break;
      await press(m, [{ buttons: ["Down"], frames: 4, release_frames: 18 }]);
      await sleep(70);
    }
    if ((await readRange(m, rowAddr, 1))[0] !== giveItemSlot) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 24 }]);
      await unwind(m, slot, startX, startY);
      return `Could not move the trade cursor onto inventory slot ${giveItemSlot}. Backed out; nothing changed.`;
    }

    // A on one of our items auto-jumps to the partner's column at its first
    // empty slot; a second A completes the transfer.
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 22 }]);
    await sleep(200);
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 22 }]);
    await sleep(260);

    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 26 }]);
    await sleep(220);

    const meNow = await readUnit(m, A.playerArray, slot);
    const partnerNow = await readUnit(m, A.playerArray, partnerSlot);
    const meAfter = await invBefore(me);
    const partnerAfter = await invBefore(partner);
    const changed = meAfter !== meBefore || partnerAfter !== partnerBefore;

    await unwind(m, slot, startX, startY);
    const spent = meNow?.acted ? " WARNING: the unit is now marked spent, which trade should not do." : "";
    return (
      `Trade #${slot} -> #${partnerSlot}, giving inventory slot ${giveItemSlot}.\n` +
      `  #${slot}        ${meBefore}\n  ->            ${meAfter}\n` +
      `  #${partnerSlot}        ${partnerBefore}\n  ->            ${partnerAfter}\n` +
      (changed
        ? `Inventories changed as expected. Unit #${slot} is still unspent, so it can still act this turn.${spent}`
        : `NOTHING CHANGED — the trade did not take. Unit #${slot} is unspent; check adjacency and free slots.${spent}`)
    );
  }

  await unwind(m, slot, startX, startY);
  return `No action-menu entry announced itself as Trade (menu count ${menu.count}). Nothing changed.`;
}

/**
 * Diagnose a stuck game and say what to press.
 *
 * WHY THIS EXISTS, AND WHY IT LEADS WITH MEMORY
 * ---------------------------------------------
 * "Nothing is happening" has three completely different causes that look
 * identical from the outside: input is being swallowed by an event or animation,
 * a menu is open and eating direction presses, or the game is simply on another
 * phase. Guessing wrong wastes presses and can commit something.
 *
 * The input-signature probe separates all three from memory, which is checkable:
 * press a direction and see what moves. If the live cursor moved, input is being
 * accepted. If it did not but a menu's index byte and its mirror did, a menu is
 * open — and the same diff LOCATES it. If nothing meaningful moved at all, input
 * is going nowhere.
 *
 * The screenshot is corroboration, and it is here for the one job memory cannot
 * do: saying WHAT is on screen — which dialogue, whose portrait, what the
 * objective text says. It is deliberately not the thing state is inferred from,
 * because reading state off pixels is how you end up confidently wrong.
 */
async function fe7Unstick(m: MgbaClient): Promise<{ text: string; png?: string }> {
  const L: string[] = [];

  const [ps, cur] = await Promise.all([readRange(m, A.phase, 2), readCursor(m)]);
  const phase = ps[0], turn = ps[1];

  const players = await readArray(m, A.playerArray);
  const selected = players.find((u) => u.deployed && !u.dead && u.selected) ?? null;

  L.push(`STATE  phase 0x${hex2(phase)} (${PHASE_NAME[phase] ?? "?"}) | turn ${turn} | cursor (${cur.x},${cur.y})`);
  L.push(`       selected unit: ${selected ? `#${selected.slot} cls${hex2(selected.classId)} at (${selected.x},${selected.y})` : "none"}`);

  const fcLive = await forecastLive(m);
  const staffHit = await m.call<{ count: number }>("search_memory", {
    bytes: STAFF_PROC_SIG, region: "EWRAM", align: 4, max_results: 4,
  });
  // Reported, not trusted: the game never clears these structs, so a non-zero
  // gate only means a forecast happened at SOME point. The probe below is the
  // authority, which is why the verdict checks cursor movement first.
  L.push(`       forecast pair: ${fcLive ? "populated (may be stale from an earlier forecast — not proof a target selection is open)" : "never populated"}`);
  L.push(`       staff target proc: ${staffHit.count === 1 ? "PRESENT (a staff target selection is open)" : "absent"}`);
  L.push(`       text buffer: ${JSON.stringify(await readText(m))}`);

  // ── Input-signature probe ────────────────────────────────────────────────
  // Press away from the map edge so a blocked cursor is never mistaken for
  // swallowed input, then press back so the probe restores whatever it moved —
  // true whether it moved a cursor, a menu index, or nothing at all.
  const dir = cur.y > 0 ? "Up" : "Down";
  const back = dir === "Up" ? "Down" : "Up";

  await m.call("snapshot_memory", { name: "fe7_stuck", address: A.uiArena, length: UI_ARENA_LEN });
  await press(m, [{ buttons: [dir], frames: 4, release_frames: 18 }]);
  await sleep(140);

  const curAfter = await readCursor(m);
  let changes: Array<{ address: number; before: number; after: number }> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await m.call<{ changes: unknown; count: number }>("diff_memory", {
      name: "fe7_stuck", predicate: "changed", width: 1, max_results: 256,
    });
    changes = asArray<{ address: number; before: number; after: number }>(r.changes);
    if (changes.length > 0 && changes.length < 40) break;
    await sleep(160);
  }

  const cursorMoved = curAfter.x !== cur.x || curAfter.y !== cur.y;
  const byAddr = new Map(changes.map((c) => [c.address, c]));
  let menuPair: { addr: number; count: number } | null = null;
  for (const c of changes) {
    const mir = byAddr.get(c.address + 1);
    if (!mir || mir.before !== c.before || mir.after !== c.after) continue;
    const b = await readRange(m, c.address - 1, 1);
    if (b[0] >= 2 && b[0] <= 10 && c.after < b[0]) { menuPair = { addr: c.address, count: b[0] }; break; }
  }

  await press(m, [{ buttons: [back], frames: 4, release_frames: 18 }]);

  let verdict: string;
  const rec: string[] = [];
  if (phase !== 0x00) {
    verdict = "NOT THE PLAYER PHASE";
    rec.push(`The game is on the ${PHASE_NAME[phase] ?? "unknown"} phase, so map input is ignored by design. Nothing is stuck.`);
    rec.push(`Call fe7_wait — it polls the phase and presses A about once a second, which also clears death quotes and event text.`);
  } else if (cursorMoved) {
    verdict = `FREE CURSOR — input IS being accepted (${dir} moved it to (${curAfter.x},${curAfter.y}))`;
    rec.push(`The game is taking input normally, so whatever failed was not a dropped press.`);
    if (selected) rec.push(`Unit #${selected.slot} is still SELECTED mid-move. Press B to deselect it before doing anything else.`);
    else rec.push(`If a tool reported a refused destination, suspect an occupied tile — check all three arrays, green NPCs included — rather than lost input.`);
  } else if (staffHit.count === 1) {
    verdict = "STAFF TARGET SELECT is open";
    rec.push(`B backs out safely; A would commit the staff use.`);
  } else if (menuPair) {
    verdict = `MENU OPEN at 0x${menuPair.addr.toString(16).toUpperCase()} — ${menuPair.count} entries (the ${dir} press moved its index, not the cursor)`;
    rec.push(`Press B to close it. Do NOT press A to "see what happens": the last entry of a unit action menu is Wait, and in the field menu Suspend sits directly above End.`);
  } else if (fcLive && changes.length > 0) {
    // Reached only after the reliable checks have all missed, because a populated
    // forecast is not by itself proof of anything — the game never clears it.
    verdict = `POSSIBLY an attack target selection (cursor frozen, no menu index found, forecast populated — but that gate goes stale, so treat this as a guess)`;
    rec.push(`Confirm with the screenshot before acting. If it IS target select, B backs out and A would COMMIT the attack.`);
    rec.push(`If the screen shows a dialogue instead, press A to clear it.`);
  } else {
    verdict = `INPUT SWALLOWED — ${dir} moved neither the cursor nor any menu index (${changes.length} bytes changed)`;
    rec.push(`An event, dialogue box, level-up or animation is holding input. Press A repeatedly — that is exactly what dismisses it, and what fe7_wait does on a loop.`);
    rec.push(`A level-up also blocks a unit's spent flag, so an action can look like it never landed when it is only waiting to be acknowledged.`);
  }

  L.push("");
  L.push(`PROBE  pressed ${dir}: cursor ${cursorMoved ? `moved (${cur.x},${cur.y})->(${curAfter.x},${curAfter.y})` : "did not move"}, ${changes.length} bytes changed in the UI arena`);
  L.push(`VERDICT  ${verdict}`);
  L.push("");
  L.push("RECOMMENDATION");
  for (const r of rec) L.push(`  - ${r}`);
  L.push("");
  L.push(`The screenshot below is for reading WHAT is on screen — dialogue text, the objective, whose portrait is up.`);
  L.push(`Do not read game state off it; the memory verdict above is the checkable answer.`);

  let png: string | undefined;
  try {
    const path = await m.call<string>("screenshot", {});
    png = (await readFile(path)).toString("base64");
    await unlink(path).catch(() => {});
  } catch (e) {
    L.push(`(screenshot unavailable: ${e instanceof Error ? e.message : String(e)})`);
  }
  return { text: L.join("\n"), png };
}

/**
 * Wait for the player phase to return, pressing A periodically while it hasn't.
 *
 * Pressing A is safe here and is the whole trick: during the enemy phase the
 * game ignores map input, so a stray A does nothing — but if a dialogue box is
 * up (a death quote, reinforcement chatter, a battle result) A is exactly what
 * dismisses it. That means we never have to classify WHICH event is on screen,
 * which matters because there is currently no reliable memory signal that
 * separates "dialogue is displayed" from "stale text sitting in the buffer".
 * A passive wait hangs forever on a death quote; this does not.
 */
async function awaitPlayerPhase(m: MgbaClient, maxMs: number): Promise<{ returned: boolean; phase: number; turn: number }> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const b = await readRange(m, A.phase, 2);
    if (b[0] === 0x00) {
      // Stop pressing immediately. A press that races the phase flip could
      // open the field menu or select a unit, so unwind with one B.
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 14 }]);
      const c = await readRange(m, A.phase, 2);
      return { returned: true, phase: c[0], turn: c[1] };
    }
    if (Date.now() >= deadline) return { returned: false, phase: b[0], turn: b[1] };
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 12 }]);
    await sleep(1100);
  }
}

/** Who is left standing, and who fell. Dead units stay dead, so this needs no baseline. */
async function battlefieldSummary(m: MgbaClient): Promise<string> {
  const [players, enemies, greens] = await Promise.all([
    readArray(m, A.playerArray),
    readArray(m, A.enemyArray),
    readArray(m, A.greenArray),
  ]);
  const alive = players.filter((p) => p.deployed && !p.dead);
  const fallen = players.filter((p) => p.deployed && p.dead);
  const wounded = alive.filter((p) => p.hp < p.maxHp)
    .map((p) => `#${p.slot} ${p.hp}/${p.maxHp}`).join(", ");
  return (
    `players ${alive.length} alive` +
    (fallen.length ? `, FALLEN: ${fallen.map((p) => `#${p.slot} cls${hex2(p.classId)}`).join(", ")}` : "") +
    `; enemies ${enemies.filter((e) => !e.dead).length}; green ${greens.filter((g) => g.deployed && !g.dead).length}` +
    (wounded ? `\nwounded: ${wounded}` : "")
  );
}

async function fe7Wait(m: MgbaClient, timeoutMs: number): Promise<string> {
  const pre = await readRange(m, A.phase, 2);
  if (pre[0] === 0x00) return `Already the player phase (turn ${pre[1]}).\n${await battlefieldSummary(m)}`;

  const r = await awaitPlayerPhase(m, timeoutMs);
  const summary = await battlefieldSummary(m);
  return r.returned
    ? `Player phase resumed on turn ${r.turn}.\n${summary}`
    : `Still ${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`} phase after ${Math.round(timeoutMs / 1000)}s (turn ${r.turn}). ` +
      `A was pressed throughout, so a dialogue box is not what's holding it. Call fe7_wait again to keep waiting.\n${summary}`;
}

async function fe7EndTurn(m: MgbaClient, timeoutMs: number): Promise<string> {
  const phaseB = await readRange(m, A.phase, 2);
  if (phaseB[0] !== 0x00) return `Not the player phase (0x${hex2(phaseB[0])}) — nothing to end.`;
  const startTurn = phaseB[1];

  // The field menu only opens on an EMPTY tile; on a unit, A selects it instead.
  const players = await readArray(m, A.playerArray);
  const enemies = await readArray(m, A.enemyArray);
  const greens = await readArray(m, A.greenArray);
  const taken = new Set(
    occupancy(
      { units: players, mark: "U" },
      { units: enemies, mark: "E" },
      { units: greens, mark: "G" },
    ).keys(),
  );

  const geom = await readGridGeometry(m);
  const cur = await readCursor(m);
  let spot: { x: number; y: number } | null = null;
  for (let r = 0; r < 12 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= geom.width || y >= geom.height) continue;
        if (!taken.has(`${x},${y}`)) spot = { x, y };
      }
    }
  }
  if (!spot) return `Could not find an empty tile near the cursor to open the field menu.`;
  if (!(await moveCursorTo(m, spot.x, spot.y))) return `Could not move the cursor to empty tile (${spot.x},${spot.y}).`;

  // Field menu: 5 entries, End is LAST and indices wrap, so A/Up/A can only ever
  // reach Unit or End — never Suspend, which sits directly above End.
  //
  // That argument is sound INSIDE the menu and says nothing about whether the
  // menu is open. If the first A is dropped, or the cursor was not on empty
  // ground, the Up walks the map cursor and the second A lands on the board.
  // So verify it the same way commitWait does: a menu swallows the Up and the
  // cursor holds still; a bare map does not.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur0 = await readCursor(m);
    await press(m, [
      { buttons: ["A"], frames: 4, release_frames: 20 },
      { buttons: ["Up"], frames: 4, release_frames: 16 },
    ]);
    await sleep(120);
    const cur1 = await readCursor(m);

    if (cur1.x !== cur0.x || cur1.y !== cur0.y) {
      // No menu took focus. Restore the cursor and retry the whole sequence
      // rather than sending the second A at the board.
      await press(m, [
        { buttons: ["Down"], frames: 4, release_frames: 16 },
        { buttons: ["B"], frames: 4, release_frames: 20 },
      ]);
      if (attempt === 2) {
        return `Tried the end-turn sequence 3x but the field menu never took focus — each Up moved the map ` +
          `cursor instead, so the first A is being dropped or (${spot.x},${spot.y}) is not empty ground. ` +
          `Cursor restored; no A was sent at the board. Nothing was ended.`;
      }
      continue;
    }

    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 20 }]);
    const left = await waitUntil(async () => {
      const b = await readRange(m, A.phase, 1);
      return b[0] !== 0x00;
    }, 2500);
    if (left) break;
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    if (attempt === 2) return `Pressed the end-turn sequence 3x but the phase byte never left 0x00.`;
  }

  // Deliberately a SHORT wait. Any single tool call is force-backgrounded at
  // ~120s, and a full enemy phase with dozens of units and battle animations
  // routinely runs longer than that — which produced a two-minute stall that
  // returned nothing useful. End the turn, glance at the result, hand off.
  const r = await awaitPlayerPhase(m, timeoutMs);
  const summary = await battlefieldSummary(m);

  if (r.returned) {
    return `Turn ${startTurn} -> ${r.turn}, player phase already back.\n${summary}`;
  }
  return (
    `Turn ended (phase is now ${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`}); the enemy phase is still running after ` +
    `${Math.round(timeoutMs / 1000)}s. This is normal on a big map — call fe7_wait to continue waiting in ` +
    `resumable chunks (it keeps pressing A, so death quotes and event text won't stall it).\n${summary}`
  );
}

// ── Tool definitions ───────────────────────────────────────────────────────

export const FE7_TOOLS: Tool[] = [
  {
    name: "fe7_state",
    description:
      "PURPOSE: Read and DECODE the full Fire Emblem 7 battlefield in one call — turn, phase, cursor, and every player and enemy unit with position, HP, stats, items and has-acted status. " +
      "USAGE: Call this instead of dumping the unit arrays with mgba_read_range and decoding 72-byte structs by hand; it replaces ~5KB of hex per turn. Use `brief` for a positions-and-HP-only view when planning movement, and the full view when you need stats to predict combat. " +
      "BEHAVIOR: Pure read, no side effects and no input. Units are decoded from the player array at 0x0202BD50 and the enemy array at 0x0202CEC0, stopping at the first empty slot. Benched units (x=0xFF) and dead units (current HP 0) are excluded from the listings and summarised as counts. " +
      "RETURNS: A header line with turn/phase/cursor, then PLAYERS and ENEMIES sections, one line per unit. US release only (AGB-AE7E).",
    inputSchema: {
      type: "object",
      properties: {
        brief: {
          type: "boolean",
          description: "Omit stats and items, listing only slot/class/position/HP. Much cheaper; use when you only need to plan movement.",
        },
      },
    },
  },
  {
    name: "fe7_reachable",
    description:
      "PURPOSE: Show exactly where a unit can move, read from the game's own movement cost map, as an ASCII grid annotated with which tiles are actually legal destinations. " +
      "USAGE: Call this BEFORE fe7_act when you are unsure a destination is in range — it answers 'can this unit reach that tile' for every tile at once, already accounting for terrain cost, class and blocking units. " +
      "BEHAVIOR: Drives input — it moves the cursor onto the unit and presses A to select (which is what populates the grid), then presses B to deselect unless `keep_selected` is set. Every step is verified against memory. The grid's geometry is DERIVED PER CHAPTER from the game's own row-pointer table (row count and stride are sized to the map and differ per chapter — never hardcoded), and the decode is asserted by requiring the cost-0 tile to equal the selected unit's position, so a misread fails loudly instead of returning a plausible wrong map. " +
      "IMPORTANT: the underlying grid is a PATHFINDING COST map and includes tiles occupied by other units — you may route through allies but not stop on them. This tool marks those tiles 'U'/'E' so legal destinations are only the numeric ones. " +
      "RETURNS: A cost grid (digits = move cost and a legal stop, U = ally, E = enemy, . = unreachable), the unit's Move, and a count of legal destinations.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "Player array slot index (0-based), as reported by fe7_state." },
        keep_selected: {
          type: "boolean",
          description: "Leave the unit selected instead of pressing B afterwards. Use when you intend to follow up immediately; the grid holds stale data once deselected.",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "fe7_act",
    description:
      "PURPOSE: Perform one unit's entire turn — select it, walk it to a destination, and commit an action — verifying every step against memory. " +
      "USAGE: This is the main tool for playing. It replaces a fragile ~12-press blind sequence that silently loses inputs during walk animations and menu transitions. Prefer it over driving mgba_press_sequence yourself. " +
      "BEHAVIOR: Drives input. Refuses to act unless the phase byte is 0x00 (player phase) and the unit is deployed, alive and unspent. VALIDATES THE DESTINATION AGAINST THE GAME'S COST MAP BEFORE PRESSING ANYTHING, and refuses with a specific reason if the tile is unreachable (0xFF) or occupied — so a failure tells you WHICH condition failed instead of a silent no-op. Cursor movement, selection, the completed walk and the committed action are each confirmed by reading memory, with retries; a move that fails despite a legal destination is reported explicitly as a dropped input. Cancels cleanly with B on any pre-commit failure, leaving the unit unspent. " +
      "RETURNS: A one-line summary of the move and its outcome; for attacks, the before/after HP of every adjacent enemy plus the attacker's own HP.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "Player array slot index (0-based) from fe7_state." },
        x: { type: "number", description: "Destination tile x. May equal the unit's current x to act without moving." },
        y: { type: "number", description: "Destination tile y." },
        action: {
          type: "string",
          enum: ["wait", "attack", "staff", "item"],
          description:
            "'wait' ends the unit's turn on the destination tile, picked by wrapping the action menu UP to its last entry. That Up is MENU navigation, not a map input: it is verified by re-reading the cursor, because with no menu open it walks the map instead and the A behind it lands on the board. Commit is confirmed by the TURN CLOCK, not by the has-acted flag — if this is the last unspent unit its Wait ends the phase and the new turn clears that flag, which is success, not failure. " +
            "'attack' picks Attack and confirms against a target — pass target_slot to choose which enemy and have the choice VERIFIED before swinging. " +
            "'staff' heals with a staff: requires target_slot, and item_slot if the unit carries more than one staff. " +
            "'item' uses an item on the unit itself (a vulnerary); item_slot picks which, defaulting to the first. " +
            "Only 'wait' can end the turn without an effect — every other action confirms it landed and reports what changed.",
        },
        target_slot: {
          type: "number",
          description:
            "Who to act on: the enemy slot for 'attack', the ally slot for 'staff'. The highlighted target is READ BACK from memory and verified before anything is confirmed, so a wrong pick fails loudly instead of hitting the wrong unit. Omit on 'attack' to take the game's default target.",
        },
        target_faction: {
          type: "string",
          enum: ["player", "green"],
          description: "Which array target_slot indexes for action='staff'. Defaults to 'player'. Green NPCs are valid staff targets.",
        },
        item_slot: {
          type: "number",
          description: "Inventory slot (0-based, as listed by fe7_state) of the staff or item to use. Defaults to the first staff for 'staff' and slot 0 for 'item'.",
        },
        target_cycle: {
          type: "number",
          description: "DEPRECATED fallback for action='attack': blind Right presses to cycle targets, used only when target_slot is omitted. Prefer target_slot, which is verified.",
        },
      },
      required: ["slot", "x", "y", "action"],
    },
  },
  {
    name: "fe7_forecast",
    description:
      "PURPOSE: Read Fire Emblem 7's combat forecast — both sides' damage, number of blows, hit%, crit%, AS and avoid — for an attack you have NOT committed to yet. " +
      "USAGE: Call this before fe7_act(action='attack') whenever the trade matters: a wounded unit, a possible kill, or a choice between targets. Pass the destination tile you would attack from, so you can compare attacking from different tiles. " +
      "BEHAVIOR: Drives input, despite being a read. The forecast structs are stale garbage until target select is actually on screen, so this selects the unit, walks it to the destination, opens Attack, reads the game's own BattleUnit structs, then unwinds — leaving the unit back on its original tile, unselected and unspent. Nothing is committed. Every number comes from the game, so support, terrain and weapon-triangle bonuses are already included; never recompute these from base stats. " +
      "RETURNS: One block with each side's damage x blows, effective hit and crit, AS, avoid and dodge, plus the projected post-battle HP — which is a deterministic every-blow-lands projection, NOT a prediction of the real fight.",
    inputSchema: {
      type: "object",
      properties: {
        slot:        { type: "number", description: "Attacking player slot from fe7_state." },
        x:           { type: "number", description: "Tile x to attack from. Use the unit's current x to forecast without moving." },
        y:           { type: "number", description: "Tile y to attack from." },
        target_slot: { type: "number", description: "Enemy slot to forecast against. Omit to take the game's default target; the unit actually selected is always reported back." },
      },
      required: ["slot", "x", "y"],
    },
  },
  // fe7_trade is DELIBERATELY NOT REGISTERED. The implementation below is
  // complete but does not work yet: identifying the Trade entry fails, and live
  // testing suggests why — pressing A on Trade appears to open the trade SCREEN
  // directly rather than a partner selection (the ASCII buffer showed an item
  // name, and the map cursor never moved onto an ally). RAM.md's write-up assumes
  // a partner-select step with a readable highlight. Rather than ship a tool that
  // burns calls and returns nothing, this stays unregistered until the flow is
  // re-derived. Everything else here is tested and working.
  {
    name: "fe7_unstick",
    description:
      "PURPOSE: Work out why the game appears frozen and say exactly what to press. Use it the moment a tool reports that nothing happened, a unit will not move, presses seem ignored, or you cannot tell what is on screen. " +
      "USAGE: Call it first when confused, before trying more presses — guessing costs presses and a wrong A can commit an action. It is safe to call at any time and changes nothing. " +
      "BEHAVIOR: Reads phase, turn, cursor, whether any unit is selected, whether an attack or staff target selection is open, and the ASCII text buffer. Then runs the input-signature probe: it presses one direction away from the map edge and sees what moved — the live cursor (input is being accepted), a menu's index byte and mirror (a menu is open, and it reports the address and entry count), or nothing (input is being swallowed by an event, dialogue, level-up or animation). It presses the opposite direction afterwards, so the probe restores whatever it moved. " +
      "RETURNS: The state read, the probe result, a verdict naming which of those three cases holds, a concrete recommendation, AND a screenshot. Read the screenshot for WHAT is displayed — dialogue text, the objective, which portrait is up — not for game state; the memory verdict is the checkable answer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fe7_note",
    description:
      "PURPOSE: Record something the tool layer could not do, so it becomes a backlog item instead of being forgotten. " +
      "USAGE: Call it the moment you want an action that does not exist ('I needed to rescue this unit and there is no rescue action'), find a tool too coarse or too blind to use well, have to work around a limitation, or hit something confusing you had to guess at. " +
      "This is the ONLY way missing capabilities get recorded: a tool that does not exist never errors, so nothing else notices you wanted it. Tool FAILURES are logged automatically — do not re-report those; use this for gaps, workarounds, and confusion. " +
      "Err on the side of recording. It costs one cheap call, it never blocks, and an over-full list is far more useful than a run that ends with 'it went fine' and no detail. " +
      "BEHAVIOR: Appends one line to the run log and returns immediately. Changes nothing in the game. " +
      "RETURNS: Confirmation and the log path.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["missing_action", "too_coarse", "workaround", "confusing", "wrong_result", "other"],
          description: "'missing_action' — you wanted to do something with no tool for it. 'too_coarse' — a tool exists but cannot express what you needed. 'workaround' — you got there, but awkwardly. 'confusing' — you could not tell what was happening. 'wrong_result' — a tool reported something that turned out to be false.",
        },
        detail: { type: "string", description: "What happened, concretely — units, tiles, and what you were trying to achieve. Specific beats tidy." },
        wanted: { type: "string", description: "What the tool layer should have let you do instead. A rough sketch of the call you wish existed is ideal." },
      },
      required: ["kind", "detail"],
    },
  },
  {
    name: "fe7_end_turn",
    description:
      "PURPOSE: End the player phase and block until the player phase comes back, so the enemy phase runs without you polling for it. " +
      "USAGE: Call once every unit you care about has acted. Saves the repeated read-and-wait loop that ending a turn otherwise requires, and guarantees the next action you take is not silently swallowed by an in-progress enemy phase. " +
      "BEHAVIOR: Drives input. Finds an empty tile near the cursor (the field menu only opens on empty ground — on a unit, A selects it instead), then uses the A/Up/A sequence. Inside the menu that is safe by structure: it wraps and End is last, so a single Up from the top entry reaches Unit or End, never Suspend. That argument only holds once the menu HAS focus, so the Up is verified by re-reading the cursor — if the cursor moved, the first A was dropped, and the sequence is restored and retried rather than pressed at the board. Retries if the phase byte does not change, then waits for the enemy and green phases to finish. " +
      "RETURNS: The turn counter, whether the player phase is already back, and a battlefield summary listing any units that fell. If the enemy phase is still running it says so and tells you to call fe7_wait — that is the normal outcome on a large map, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description: "How long to wait for the player phase before handing off to fe7_wait (default 12000). Kept short deliberately: any single tool call is force-backgrounded around 120s, and a full enemy phase often runs longer, so waiting here just burns the budget for no information.",
        },
      },
    },
  },
  {
    name: "fe7_wait",
    description:
      "PURPOSE: Wait for the player phase to come back, in a resumable chunk, while pressing A to clear any dialogue that would otherwise stall it forever. " +
      "USAGE: Call after fe7_end_turn reports the enemy phase is still running, and call it again as many times as needed — each call is a checkpoint that reports what it found. Also safe to call any time you suspect the game is sitting on an event and swallowing input. " +
      "BEHAVIOR: Drives input. Polls the phase byte and presses A about once a second until the player phase returns or the timeout expires. Pressing A is safe during the enemy phase because the game ignores map input then, while a dialogue box (death quote, reinforcement text, battle result) is dismissed by exactly that press — so this clears events without needing to identify them. On the phase flip it stops pressing and taps B once, in case a press raced the transition and opened a menu. " +
      "RETURNS: Whether the player phase resumed and on which turn, plus a battlefield summary naming any fallen units and listing wounded survivors.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description: "Maximum wait for this chunk (default 90000). Keep it under ~110000 so the call returns normally instead of being force-backgrounded at the harness cap; just call again if the phase has not returned.",
        },
      },
    },
  },
];

export async function handleFe7(
  name: string,
  p: Record<string, unknown>,
  m: MgbaClient,
): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> } | null> {
  const wrap = (text: string) => ({ content: [{ type: "text" as const, text }] });

  if (name === "fe7_note") {
    return wrap(await fe7Note(String(p.kind), String(p.detail), String(p.wanted ?? "")));
  }

  const started = Date.now();
  let result: Awaited<ReturnType<typeof dispatchFe7>>;
  try {
    result = await dispatchFe7(name, p, m);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLine({ kind: "call", tool: name, params: p, ms: Date.now() - started, result: `THREW: ${msg}` });
    return wrap(`${name} failed: ${msg}`);
  }
  if (result) {
    // Log everything, judge nothing. Whether a result was a failure is a
    // question for triage afterwards, with the whole run visible.
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
      .join("\n");
    await logLine({ kind: "call", tool: name, params: p, ms: Date.now() - started, result: text.slice(0, 2000) });
  }
  return result;
}

async function dispatchFe7(
  name: string,
  p: Record<string, unknown>,
  m: MgbaClient,
): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> } | null> {
  const wrap = (text: string) => ({ content: [{ type: "text" as const, text }] });

  switch (name) {
    case "fe7_state":
      return wrap(await fe7State(m, p.brief === true));

    case "fe7_reachable":
      return wrap(await fe7Reachable(m, Number(p.slot), p.keep_selected === true));

    case "fe7_act":
      return wrap(
        (
          await fe7Act(
            m,
            Number(p.slot), Number(p.x), Number(p.y),
            String(p.action),
            Number(p.target_cycle ?? 0),
            p.target_slot === undefined ? null : Number(p.target_slot),
            p.item_slot === undefined ? null : Number(p.item_slot),
            p.target_faction === undefined ? "player" : String(p.target_faction),
          )
        ).text,
      );

    case "fe7_forecast":
      return wrap(
        await fe7Forecast(
          m, Number(p.slot), Number(p.x), Number(p.y),
          p.target_slot === undefined ? null : Number(p.target_slot),
        ),
      );

    case "fe7_trade":
      return wrap(await fe7Trade(m, Number(p.slot), Number(p.partner_slot), Number(p.item_slot)));

    case "fe7_unstick": {
      const r = await fe7Unstick(m);
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
        [{ type: "text", text: r.text }];
      if (r.png) content.push({ type: "image", data: r.png, mimeType: "image/png" });
      return { content };
    }

    case "fe7_end_turn":
      return wrap(await fe7EndTurn(m, Number(p.timeout_ms ?? 12000)));

    case "fe7_wait":
      return wrap(await fe7Wait(m, Number(p.timeout_ms ?? 90000)));

    default:
      return null;
  }
}
