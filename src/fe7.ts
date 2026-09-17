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
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

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
  mapSize:      0x0202e3d8, // u16 width, u16 height — gBmMapSize
  mapLayers:    0x0202e3dc, // 7 u32 slots; each holds &table[2] (the +2 row border, pre-baked)
} as const;

const UI_ARENA_LEN = 8192;

// ROM item table: entry = ITEM_TABLE + 0x24*id.
//   +0x07 weapon type (0 sword 1 lance 2 axe 3 bow 4 staff 5 anima 6 light 7 dark, 9 consumable)
//   +0x14 max uses, +0x15 Mt, +0x16 Hit, +0x17 Wt, +0x18 Crit, +0x19 range (hi nibble MIN, lo nibble MAX)
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
const GRID_Y_BOT   = 2;      // ...and two trailing border rows: height = rows - 4
const GRID_PROBE   = 2048;   // table + data in ONE read for any observed map
const CLASS_BASE   = 0x08be015c;
const CLASS_STRIDE = 0x54;

const UNREACHABLE = 0xff;

// ── Map layers ─────────────────────────────────────────────────────────────
//
// Seven statically-addressed layers, all the same shape, found 2026-08-29. The
// slot bases are ROM literals (one literal pool at 0x08018E44) so they do NOT
// vary per chapter — verified byte-identical on Lyn ch.7 and ch.22. Only the
// geometry is per-map, and gBmMapSize gives that directly.
//
// Each slot holds `&table[2]`, i.e. the +2 top-border offset is ALREADY baked in,
// so index by y directly with no adjustment.
//
// ⚠️ DOUBLE indirection. read32(slot) is the ROW-POINTER ARRAY, not the data:
//     tile(x,y) = read8( read32( read32(slot) + 4*y ) + x )
// Doing read32(slot + 4*y) walks the slot array itself and returns a grid that is
// shifted by several rows and looks entirely plausible.
const LAYER = { unit: 0, terrain: 1, movement: 2, range: 3, fog: 4, hidden: 5, other: 6 } as const;

// Read out of the game by writing each ID to a tile and reading the cursor
// readout; transcribed from RAM.md's table programmatically, not by hand.
const TERRAIN_NAME: Record<number, string> = { 0:"-", 1:"Plain", 2:"Road", 3:"Village", 4:"Village", 5:"House", 6:"Armory", 7:"Vendor", 8:"Arena", 9:"C.Room", 10:"Fort", 11:"Gate", 12:"Forest", 13:"Thicket", 14:"Sand", 15:"Desert", 16:"River", 17:"Mntn", 18:"Peak", 19:"Bridge", 20:"Bridge", 21:"Sea", 22:"Lake", 23:"Floor", 24:"Floor", 25:"Fence", 26:"Wall", 27:"Wall", 28:"Rubble", 29:"Pillar", 30:"Door", 31:"Throne", 32:"Chest", 33:"Chest", 34:"Roof", 35:"Gate", 36:"Church", 37:"Ruins", 38:"Cliff", 39:"Ballista", 40:"Long B", 41:"Killer B", 42:"Flat", 43:"Wreck", 44:"-", 45:"Stairs", 46:"-", 47:"Glacier", 48:"Arena", 49:"Valley", 50:"Fence", 51:"Snag", 52:"Bridge", 53:"Sky", 54:"Deeps", 55:"Ruins", 56:"Inn", 57:"Barrel", 58:"Bone", 59:"Dark", 60:"Water", 61:"Gunnel", 62:"Deck", 63:"Brace", 64:"Mast" };

const terrainName = (id: number) => TERRAIN_NAME[id] ?? `?${hex2(id)}`;

async function readMapSize(m: MgbaClient): Promise<{ width: number; height: number }> {
  const b = await readRange(m, A.mapSize, 4);
  const width = u16(b, 0), height = u16(b, 2);
  if (width < 1 || width > 64 || height < 1 || height > 64) {
    throw new Error(`gBmMapSize reads ${width}x${height}, which is not a plausible map — is a chapter loaded?`);
  }
  return { width, height };
}

/** One whole map layer as rows[y][x]. Three reads regardless of map size. */
async function readLayer(m: MgbaClient, slot: number, width: number, height: number): Promise<number[][]> {
  const base = u32(await readRange(m, A.mapLayers + 4 * slot, 4), 0);
  const ptrs = await readRange(m, base, height * 4);
  const rowAddrs: number[] = [];
  for (let y = 0; y < height; y++) rowAddrs.push(u32(ptrs, y * 4));
  const lo = Math.min(...rowAddrs), hi = Math.max(...rowAddrs) + width;
  if (hi - lo > 0x4000) throw new Error(`layer ${slot} rows span ${hi - lo} bytes — pointers look wrong.`);
  const span = await readRange(m, lo, hi - lo);
  return rowAddrs.map((a) => span.slice(a - lo, a - lo + width));
}

/**
 * Terrain id of ONE tile. Three small reads, for the failure paths that want to
 * name a tile without the cost of a whole-layer fetch.
 *
 * Same double indirection as readLayer: the slot holds the ROW-POINTER ARRAY,
 * with the +2 top border already baked in, so index by y directly.
 */
async function terrainAt(m: MgbaClient, x: number, y: number): Promise<number | null> {
  try {
    const base = u32(await readRange(m, A.mapLayers + 4 * LAYER.terrain, 4), 0);
    const row = u32(await readRange(m, base + 4 * y, 4), 0);
    return (await readRange(m, row + x, 1))[0];
  } catch {
    return null;
  }
}

async function fe7Terrain(m: MgbaClient, find: string): Promise<string> {
  const { width, height } = await readMapSize(m);
  const rows = await readLayer(m, LAYER.terrain, width, height);

  const L: string[] = [`map ${width}x${height} (gBmMapSize) — terrain IDs in hex`];
  L.push(`     ${Array.from({ length: width }, (_, x) => String(x % 10)).join(" ")}`);
  for (let y = 0; y < height; y++) {
    L.push(`  ${String(y).padStart(2, " ")} ` + rows[y].map((v) => hex2(v)).join("").replace(/(..)/g, "$1").match(/.{1,2}/g)!.join(" "));
  }

  const seen = new Map<number, number>();
  for (const row of rows) for (const v of row) seen.set(v, (seen.get(v) ?? 0) + 1);
  L.push("");
  L.push("legend (only IDs present on this map):");
  for (const [id, n] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    L.push(`  ${hex2(id)} ${terrainName(id).padEnd(10)} x${n}`);
  }

  if (find) {
    const re = new RegExp(find, "i");
    const hits: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) if (re.test(terrainName(rows[y][x]))) hits.push(`(${x},${y})=${terrainName(rows[y][x])}`);
    }
    L.push("");
    L.push(hits.length ? `find /${find}/i -> ${hits.join(", ")}` : `find /${find}/i -> no tile on this map matches.`);
  }
  return L.join("\n");
}

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

/** How often to send the skip press while waiting on the game. */
const SKIP_CADENCE_MS = 900;

/**
 * Wait for `done`, ALTERNATING Start and A to clear whatever is on screen.
 *
 * BOTH BUTTONS, because neither alone is known to cover every screen:
 *
 *   screen                              Start                      A
 *   event cutscene (reinforcements)     skips whole sequence       one box at a time
 *   death / battle quote (with the ▼)   skips it                   advances one box
 *   level-up                            nothing                    nothing
 *   free cursor, PLAYER phase           toggles the minimap        opens the FIELD MENU
 *   free cursor, ENEMY phase            does NOT open the minimap  (map input ignored)
 *
 * A version of this pressed Start ONLY. On 2026-09-08 it sat through a five and a
 * half minute enemy-phase freeze on Ch.22 turn 4 doing nothing, and a single A was
 * what moved the game on. **The cause of that freeze is UNDETERMINED** — see
 * llm_plays_fe7/runs/2026-09-08-stall/. Do not read it as "Start cannot clear a
 * death quote": Grant has since confirmed by hand that Start does skip one. What
 * it does establish is that Start-only was not sufficient in practice, and that a
 * committed attack is the most likely way in the game to raise a quote box — so
 * this alternates and covers both.
 *
 * A LEVEL-UP yields to no button and runs at its own pace, so callers pass a
 * generous timeout rather than this pressing faster.
 *
 * Always ends with one B. On the PLAYER phase a late Start can leave the minimap
 * up and a late A can open the field menu; B closes either, and on a free cursor
 * with nothing open it does nothing at all. (Start does not open the minimap on the
 * enemy phase, so that half of the risk is player-phase only.) The field menu is
 * only dangerous when NAVIGATED — Suspend and End need an Up press to reach, and
 * nothing here ever sends one.
 */
async function skipWhile(
  m: MgbaClient,
  done: () => Promise<boolean>,
  timeoutMs: number,
  cadenceMs = SKIP_CADENCE_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let ok = false;
  let i = 0;
  for (;;) {
    if (await done()) { ok = true; break; }
    if (Date.now() >= deadline) break;
    // Alternate. A first: after a committed action the likeliest blocker is a
    // battle or death quote, and only A moves those.
    await press(m, [{ buttons: [i++ % 2 === 0 ? "A" : "Start"], frames: 4, release_frames: 14 }]);
    await sleep(cadenceMs);
  }
  await press(m, [{ buttons: ["B"], frames: 4, release_frames: 16 }]);
  return ok;
}

/**
 * skipWhile for the moment after a COMMITTED ATTACK, with one extra stop: the
 * inventory-full prompt. A drop into a full inventory halts the game on an item
 * list where A sends the highlighted entry — the equipped weapon — straight to
 * the convoy, so the check runs before EVERY press and the loop halts and hands
 * the choice back the instant it is up. No trailing B in that case either.
 */
async function skipCombat(
  m: MgbaClient,
  done: () => Promise<boolean>,
  timeoutMs: number,
): Promise<{ ok: boolean; prompt: InvPrompt | null }> {
  const deadline = Date.now() + timeoutMs;
  let ok = false;
  let i = 0;
  for (;;) {
    if (await done()) { ok = true; break; }
    if (Date.now() >= deadline) break;
    const pr = await inventoryFullIfHinted(m, true);
    if (pr) return { ok: false, prompt: pr };
    await press(m, [{ buttons: [i++ % 2 === 0 ? "A" : "Start"], frames: 4, release_frames: 14 }]);
    await sleep(SKIP_CADENCE_MS);
  }
  // The prompt can surface a beat after the has-acted flag settles (the "got an
  // item" box comes first). One last look before the tidy-up B.
  await sleep(300);
  const late = await inventoryFullIfHinted(m, true);
  if (late) return { ok, prompt: late };
  await press(m, [{ buttons: ["B"], frames: 4, release_frames: 16 }]);
  return { ok, prompt: null };
}

// ── Unit decoding ──────────────────────────────────────────────────────────

export interface Unit {
  slot: number;
  addr: number;
  /** Character-struct pointer (+0x00). STABLE identity: array slots get recycled
   *  by reinforcements, so a slot number alone does not identify a unit over time. */
  charPtr: number;
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
    charPtr,
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
  rowCount: number;  // rows in the buffer, including BOTH border bands
  width: number;     // playable columns (stride - 2) — inferred
  height: number;    // playable rows (rowCount - 4) — inferred
  indexRows: number; // addressable rows for INDEXING (rowCount - GRID_Y_OFF)
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
  // width = stride - 2 and height = rowCount - 4 are INFERRED, not proven: on ch.7
  // the cursor hard-stops at (19,13) against stride 22 / 18 rows, and on ch.1 the
  // last two rows read 0xFF in every grid decoded. `rows` is the raw count, so
  // indexing never depends on the inference.
  return {
    stride, rowCount, rowPtrs,
    width: stride - 2,
    height: rowCount - GRID_Y_OFF - GRID_Y_BOT,
    indexRows: rowCount - GRID_Y_OFF,
  };
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
  for (let y = 0; y < g.indexRows; y++) {
    const off = g.rowPtrs[y + GRID_Y_OFF] - A.gridTable;
    rows.push(bytes.slice(off, off + g.stride));
  }
  return { ...g, rows };
}

// readGridGeometry() lived here: the grid's shape without its costs. Both its
// callers (fe7Inspect, fe7EndTurn) wanted MAP BOUNDS, and the grid is the wrong
// source for those — its playable size is inferred, and it is only populated
// while a unit is selected, which neither caller does. Both now read gBmMapSize.
// If you need bounds again, use readMapSize(); the grid answers "where can THIS
// unit go", never "how big is the map".

/** The tile the grid marks cost 0 — i.e. who the game thinks is selected. */
function gridOrigin(grid: Grid): { x: number; y: number } | null {
  for (let y = 0; y < grid.rows.length; y++) {
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
  // Bound by the RAW row/stride counts, never the inferred playable size — a bad
  // inference must not refuse a tile the game itself marks reachable.
  if (y < 0 || y >= grid.indexRows || x < 0 || x >= grid.stride) return UNREACHABLE;
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
  // HIGH nibble is MIN, LOW nibble is MAX. Reading them the other way round is
  // not a cosmetic slip: every 1-2 weapon — hand axe, javelin, every tome —
  // decodes to the empty interval 2-1, which no tile can satisfy, so the game
  // is told "no enemy is in range" for a perfectly legal attack. Symmetric
  // weapons (sword 0x11, bow 0x22) read the same both ways, which is how it
  // survived. Verified against the live ROM: hand axe 0x28 = 0x12 -> 1-2,
  // Lightning 0x3E = 0x12 -> 1-2, and the asymmetric ballista 0x34 = 0x3A ->
  // 3-10, which is the case that settles the direction.
  const min = (b[0] >> 4) & 0x0f, max = b[0] & 0x0f;
  // Cheap invariant. An inverted range fails as "nothing in range" rather than
  // as an error, which is exactly why the bug above went unnoticed for a week.
  if (min > max) {
    throw new Error(
      `item 0x${hex2(id)} decodes to the empty range ${min}-${max} from range byte ` +
      `0x${hex2(b[0])}. min > max can never match a tile — the nibbles are being read backwards.`);
  }
  return { min, max };
}

/** Inventory slot indices holding staves, in inventory order = the staff list's order. */
async function staffSlots(m: MgbaClient, u: Unit): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < u.items.length; i++) {
    if ((await itemType(m, u.items[i].id)) === WTYPE_STAFF) out.push(i);
  }
  return out;
}

// ── Inventory-full prompt ──────────────────────────────────────────────────
//
// When a unit with five items kills (or is attacked by, and kills on the
// counter) an enemy that drops one, the game halts on an item list: "Your
// inventory is full. Send an item to Merlinus." (or a discard variant with no
// convoy). The list is the unit's five items in inventory order plus the new one
// last, and A on an entry sends it AT ONCE, no confirmation. Every A/Start loop
// in this file used to walk straight into that and would have sent the
// highlighted entry 0 — the unit's equipped weapon — to the convoy. Seen live on
// Ch.20 turn 4 during the enemy phase; the phase byte just stayed 0x80.
//
// Detection is two-signal: the text buffer names the prompt, AND locateMenu
// finds a menu whose index moves (that probe is a Down/Up on the list, which
// only wiggles the highlight and puts it back). The receiver and the dropper
// come from the battle structs, which still hold both combatants: whichever
// side's character pointer matches a player unit received the item.

/** Unit state bit that makes an enemy drop its LAST item on death. Confirmed live on Ch.20: the longbow archer that drops read 0x1000, a non-dropping archer 0, and 0x400000 (first guess, from the FE8 decomp) marked units that had merely acted. */
const UNIT_STATE_DROP_ITEM = 0x00001000;

function dropTag(u: Unit): string {
  return (u.flags & UNIT_STATE_DROP_ITEM) !== 0 && u.items.length
    ? ` DROPS 0x${hex2(u.items[u.items.length - 1].id)}`
    : "";
}

type InvPrompt = {
  kind: "send" | "discard";
  text: string;
  menuAddr: number;
  count: number;
  index: number;
  receiver: Unit | null;
  dropper: Unit | null;
  newItem: number | null;
};

const INV_FULL_RE = /inventory is full|send an item|no room|discard/i;

async function inventoryFullHint(m: MgbaClient): Promise<string | null> {
  const t = await readText(m, 96);
  return INV_FULL_RE.test(t) ? t : null;
}

/**
 * Check for the prompt. `probe` = run the menu check even when the text buffer
 * does not hint. The text is NOT a reliable gate: on Ch.20 turn 2 the prompt
 * took Lucius's Lightning (entry 0) while the buffer never named it — it read
 * "Lucius" afterwards. So every place a stray A could land on the list probes
 * the menu directly; the text only helps classify send vs discard.
 */
async function inventoryFullIfHinted(m: MgbaClient, probe = false): Promise<InvPrompt | null> {
  const t = await inventoryFullHint(m);
  if (!t && !probe) return null;
  return inventoryFullPrompt(m, t ?? undefined);
}

/**
 * Could a drop into a full inventory happen at all right now? Only if some
 * deployed player holds 5 items AND some living enemy carries the drop bit.
 * When it cannot, the enemy-phase loop skips the per-beat menu probe.
 */
async function dropRisk(m: MgbaClient): Promise<boolean> {
  const [players, enemies] = await Promise.all([readArray(m, A.playerArray), readArray(m, A.enemyArray)]);
  return players.some((u) => u.deployed && !u.dead && u.items.length >= 5) &&
    enemies.some((e) => !e.dead && (e.flags & UNIT_STATE_DROP_ITEM) !== 0 && e.items.length > 0);
}

async function inventoryFullPrompt(m: MgbaClient, text?: string): Promise<InvPrompt | null> {
  const t = text ?? (await inventoryFullHint(m));
  const menu = await locateMenu(m);
  if (!menu) return null;
  const [players, enemies, ab, tb] = await Promise.all([
    readArray(m, A.playerArray), readArray(m, A.enemyArray),
    readRange(m, A.battleActor, UNIT_STRIDE), readRange(m, A.battleTarget, UNIT_STRIDE),
  ]);
  const actor = decodeUnit(ab, 0, 0, A.battleActor);
  const target = decodeUnit(tb, 0, 0, A.battleTarget);
  const byPtr = (us: Unit[], ptr: number) => us.find((u) => u.charPtr === ptr) ?? null;
  let receiver: Unit | null = null, dropper: Unit | null = null, dropCopy: Unit | null = null;
  if (actor && byPtr(players, actor.charPtr)) {
    receiver = byPtr(players, actor.charPtr);
    dropper = target ? byPtr(enemies, target.charPtr) : null;
    dropCopy = target;
  } else if (target && byPtr(players, target.charPtr)) {
    receiver = byPtr(players, target.charPtr);
    dropper = actor ? byPtr(enemies, actor.charPtr) : null;
    dropCopy = actor;
  }
  // The drop is the dropper's LAST item. Prefer the live enemy record; if the
  // game already stripped it, fall back to the battle copy (whose inventory is
  // reordered equipped-first, so this is a best effort, and is labelled so).
  // Who dropped it. On the enemy phase the battle structs are already stale by
  // the time the list is up: the item-get sequence reuses gBattleActor for the
  // RECEIVER (seen live — the "new item" resolved to Sain's own Silver Card while
  // the list showed a Steel Lance). So prefer the live enemy array: a dead enemy
  // carrying the drop bit whose record still lists its items. The struct copy is
  // only a fallback, and never when it is a copy of the receiver itself.
  const deadDroppers = enemies.filter((e) => e.dead && (e.flags & UNIT_STATE_DROP_ITEM) !== 0 && e.items.length > 0);
  if (deadDroppers.length === 1) dropper = deadDroppers[0];
  else if (deadDroppers.length > 1 && !(dropper && deadDroppers.includes(dropper))) dropper = null;
  let newItem: number | null = null;
  if (dropper && dropper.items.length) {
    newItem = dropper.items[dropper.items.length - 1].id;
  } else if (dropCopy && dropCopy.items.length && !(receiver && dropCopy.charPtr === receiver.charPtr)) {
    newItem = dropCopy.items[dropCopy.items.length - 1].id;
  }
  // Without the text, the open list must at least be the right shape: a full
  // receiver, and one entry more than it carries. With the text, trust it.
  if (!receiver) return null;
  if (!t && (receiver.items.length < 5 || menu.count !== receiver.items.length + 1)) return null;
  const merlinus = players.some((u) => u.deployed && !u.dead && u.classId === 0x44);
  const kind: "send" | "discard" = t
    ? (/discard/i.test(t) && !/send an item/i.test(t) ? "discard" : "send")
    : (merlinus ? "send" : "discard");
  return {
    kind,
    text: t ?? "(the text buffer did not name it — identified from the open list and the battle structs)",
    menuAddr: menu.addr, count: menu.count, index: menu.index, receiver, dropper, newItem,
  };
}

function formatInvPrompt(p: InvPrompt): string {
  const L: string[] = [];
  L.push(`INVENTORY FULL PROMPT is on screen (${p.kind === "send" ? "send one item to Merlinus" : "discard one item"}); text: ${JSON.stringify(p.text.trim())}.`);
  if (p.receiver) {
    L.push(`  receiver: player #${p.receiver.slot} cls${hex2(p.receiver.classId)} at (${p.receiver.x},${p.receiver.y}), inventory ${p.receiver.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",")}`);
  } else {
    L.push(`  receiver: could not be matched to a player unit from the battle structs`);
  }
  const entries = p.receiver ? p.receiver.items.map((i, k) => `${k}=0x${hex2(i.id)}x${i.uses}`) : [];
  entries.push(
    `${entries.length}=${p.newItem !== null ? `0x${hex2(p.newItem)}` : "? — not identifiable from memory; an mgba_screenshot shows its name"} ` +
    `(the NEW item${p.dropper ? `, dropped by enemy #${p.dropper.slot}` : ""})`,
  );
  L.push(`  list entries (menu count ${p.count}, highlight on ${p.index}): ${entries.join(", ")}`);
  L.push(
    `  NOTHING has been pressed: every A/Start loop stops here because A on an entry ${p.kind === "send" ? "sends" : "discards"} it at once. ` +
    `Decide which item is least needed and call fe7_inventory_full(index) — index ${entries.length - 1} ${p.kind === "send" ? "sends the new item away" : "discards the new item"} and leaves the unit's inventory exactly as it is.`,
  );
  return L.join("\n");
}

async function fe7InventoryFull(m: MgbaClient, index: number): Promise<string> {
  const p = await inventoryFullIfHinted(m, true);
  if (!p) {
    const t = await readText(m, 96);
    return `No inventory-full prompt is up (text buffer ${JSON.stringify(t.trim())}, and no live menu with it). Nothing was pressed.`;
  }
  if (!Number.isInteger(index) || index < 0 || index >= p.count) {
    return `index ${index} is out of range — the prompt lists ${p.count} entries (0-${p.count - 1}). Nothing was pressed.\n${formatInvPrompt(p)}`;
  }
  const before = p.receiver ? p.receiver.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",") : "?";
  if (!(await menuGoTo(m, p.menuAddr, index, p.count))) {
    return `Could not move the highlight to entry ${index} — the index byte would not settle. Nothing was confirmed.\n${formatInvPrompt(p)}`;
  }
  const idx = await readRange(m, p.menuAddr, 1);
  if (idx[0] !== index) return `Highlight reads ${idx[0]} after moving, not ${index}. Nothing was confirmed.`;
  await press(m, [{ buttons: ["A"], frames: 4, release_frames: 30 }]);
  await sleep(800);
  const still = await inventoryFullIfHinted(m, true);
  const now = p.receiver ? await readUnit(m, A.playerArray, p.receiver.slot) : null;
  const after = now ? now.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",") : "?";
  if (still) {
    return `Pressed A on entry ${index} but the prompt is STILL up (highlight now ${still.index}). Receiver inventory ${before} -> ${after}. Call fe7_unstick.`;
  }
  const chosen = p.receiver && index < p.receiver.items.length
    ? `entry ${index} (0x${hex2(p.receiver.items[index].id)})`
    : `entry ${index} (the new item${p.newItem !== null ? ` 0x${hex2(p.newItem)}` : ""})`;
  return (
    `Resolved: ${p.kind === "send" ? "sent" : "discarded"} ${chosen}. Receiver #${p.receiver?.slot ?? "?"} inventory ${before} -> ${after}. ` +
    `The game has resumed — if this was the enemy phase call fe7_wait, otherwise fe7_state.`
  );
}

// ── Weapon choice for an attack ─────────────────────────────────────────────
//
// fe7_act(attack) and fe7_forecast always swung the EQUIPPED weapon, because the
// step after choosing Attack was a blind A on whatever the weapon list had
// highlighted — entry 0, the equipped one. That silently hid Eliwood's Rapier
// behind his Iron Sword against a Knight on Ch.20 (4x2 instead of a one-round
// kill) and Marcus's Silver Lance behind a Hand Axe against the boss. The list's
// entries carry no readable item id, so the pick is confirmed BY EFFECT instead:
// once target select opens, the game's own BattleUnit for the actor names the
// weapon it will use (gBattleActor +0x4A, already decoded as BattleSide.weaponId).

/**
 * Inventory slot indices of weapons the unit can actually wield — has a rank in —
 * in inventory order, which is the Attack list's order (the game additionally
 * leaves out any weapon that has no target in range from the chosen tile).
 */
async function usableWeaponSlots(m: MgbaClient, u: Unit): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < u.items.length; i++) {
    const t = await itemType(m, u.items[i].id);
    if (t === WTYPE_STAFF || t > 7) continue;
    if (u.ranks[t] === 0) continue;
    out.push(i);
  }
  return out;
}

/**
 * weapon_slot pre-flight: everything about the request that is knowable from the
 * unit's own record, so a doomed pick is refused before the unit takes a step.
 */
async function weaponSlotPreflight(
  m: MgbaClient, u: Unit, wantSlot: number,
): Promise<{ ok: true; id: number; min: number; max: number; listIndex: number } | { ok: false; reason: string }> {
  const inv = u.items.map((i) => hex2(i.id)).join(",") || "empty";
  if (!Number.isInteger(wantSlot) || wantSlot < 0 || wantSlot >= u.items.length) {
    return { ok: false, reason: `weapon_slot ${wantSlot} is out of range — unit #${u.slot} carries ${u.items.length} item(s) (${inv})` };
  }
  const id = u.items[wantSlot].id;
  const t = await itemType(m, id);
  if (t === WTYPE_STAFF || t > 7) {
    return {
      ok: false,
      reason: `weapon_slot ${wantSlot} holds 0x${hex2(id)}, which is ${t === WTYPE_STAFF ? "a staff" : "not a weapon"} (item type ${t})`,
    };
  }
  if (u.ranks[t] === 0) {
    return {
      ok: false,
      reason:
        `weapon_slot ${wantSlot} holds 0x${hex2(id)} (weapon type ${t}) but unit #${u.slot}'s rank in that type is 0 — ` +
        `its class cannot wield it, so the Attack list will never offer it`,
    };
  }
  const usable = await usableWeaponSlots(m, u);
  const r = await itemRange(m, id);
  return { ok: true, id, min: r.min, max: r.max, listIndex: usable.indexOf(wantSlot) };
}

/**
 * Make the requested weapon the one the attack will use.
 *
 * Call this right after the A that chose Attack on the action menu. The game then
 * shows either the WEAPON LIST (more than one usable weapon) or, with exactly one,
 * goes straight to target select. Entries have no readable item id, so each pick
 * is confirmed by effect: A on an entry opens target select, the actor BattleUnit
 * then names the weapon, and a wrong one is backed out with a single B — which
 * returns to the list — before the next entry is tried. Nothing here commits: the
 * attack still needs one more A after target select, and the caller owns that.
 *
 * SIDE EFFECT: the game re-equips a weapon the moment it is picked from the list,
 * and backing out with B does not undo it. Every entry this walks past therefore
 * ends up equipped in turn, and the LAST pick stays equipped even if the whole
 * flow is unwound. Verified live: a Rapier forecast left the Rapier in slot 0.
 *
 * `expectIndex` is the weapon's position among the wieldable weapons in inventory
 * order — the list's order minus anything the game filtered out for range — so it
 * is tried first, then every other entry, so a filtered list still resolves.
 */
async function selectAttackWeapon(
  m: MgbaClient, wantId: number, expectIndex: number,
): Promise<{ ok: true; how: string } | { ok: false; reason: string }> {
  await sleep(200);
  if (await forecastLive(m)) {
    // No list at all: the game found one usable weapon and went straight to targets.
    const f = await readForecast(m);
    if (f.actor.weaponId === wantId) return { ok: true, how: "the only usable weapon here, no list shown" };
    return {
      ok: false,
      reason: `the game showed no weapon list — its only usable weapon from this tile is 0x${hex2(f.actor.weaponId)}, not 0x${hex2(wantId)}`,
    };
  }
  const menu = await locateMenu(m);
  if (!menu) {
    // A ONE-ENTRY weapon list. Seen live: Hector at range 2 with only the Hand
    // Axe reaching — the game still shows the list, but with a single entry, and
    // locateMenu cannot see it because its Down probe changes nothing on a
    // one-entry menu. The one A that selects that entry is the same second A the
    // weapon-less flow has always pressed here; it can only open target select,
    // never commit. Confirm by effect exactly as for a walked list.
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    await sleep(240);
    if (!(await forecastLive(m))) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(160);
      return { ok: false, reason: "Attack was chosen but neither a weapon list nor target select could be located, and one more A did not open target select either" };
    }
    const f = await readForecast(m);
    if (f.actor.weaponId === wantId) return { ok: true, how: "single-entry weapon list" };
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
    await sleep(160);
    return {
      ok: false,
      reason: `the weapon list had a single entry and it is 0x${hex2(f.actor.weaponId)}, not 0x${hex2(wantId)} — the only weapon with a target in range from this tile`,
    };
  }
  let menuAddr = menu.addr;
  const order = [expectIndex, ...Array.from({ length: menu.count }, (_, i) => i)]
    .filter((v, i, a) => v >= 0 && v < menu.count && a.indexOf(v) === i);
  const seen: string[] = [];
  for (const idx of order) {
    if (!(await menuGoTo(m, menuAddr, idx, menu.count))) { seen.push(`${idx}=unreachable`); continue; }
    await clearForecastGate(m);
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    await sleep(220);
    if (!(await forecastLive(m))) {
      // A on a weapon entry must open target select. If it did not, this is not
      // the weapon list, and pressing on would be blind — back out of whatever opened.
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(160);
      seen.push(`${idx}=no-forecast`);
      continue;
    }
    const f = await readForecast(m);
    seen.push(`${idx}=0x${hex2(f.actor.weaponId)}`);
    if (f.actor.weaponId === wantId) return { ok: true, how: `weapon list entry ${idx} of ${menu.count}` };
    // Wrong weapon: one B returns to the list. Confirm the same struct is live
    // again before the next pick, re-locating it if the count byte moved.
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
    await sleep(180);
    const b = await readRange(m, menuAddr - 1, 1);
    if (b[0] !== menu.count) {
      const again = await locateMenu(m);
      if (!again || again.count !== menu.count) {
        return { ok: false, reason: `lost the weapon list after backing out of entry ${idx} (entries so far: ${seen.join(", ")})` };
      }
      menuAddr = again.addr;
    }
  }
  return {
    ok: false,
    reason:
      `0x${hex2(wantId)} is not in the Attack list from this tile — its ${menu.count} entries resolved to ${seen.join(", ")}. ` +
      `The game leaves a weapon off the list when it has no target in range`,
  };
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

/**
 * Is this side's forecast block real, or last battle's leftovers?
 *
 * The game populates a BattleUnit only for a side that actually FIGHTS, and it
 * never clears the pair between battles. So when the defender cannot counter —
 * a bow at range 1, an axe at range 2, no weapon at all — its half of the pair
 * still holds whatever the previous fight left there, and it formats into a
 * perfectly plausible-looking block. Observed live, twice: `dmg 0 x44 hit 255%
 * crit 255%` and `dmg 2 x15 hit 255% crit 255%`, the second while the attacker
 * finished on full HP because nothing had countered at all.
 *
 * That is the most dangerous thing this layer can do. A fabricated 255% crit
 * reads as certain death and retreats a unit that was in no danger; a fabricated
 * 0 damage reads as safety. Returns the reason it is not real, or null.
 *
 * Two independent tests, cheapest first:
 *   1. Impossible values. Displayed hit and crit are percentages the game clamps
 *      to 0-100, so 255 (0xFF) means "never written". No weapon in FE7 lands
 *      more than 4 blows.
 *   2. Reach. A side that cannot cover the combat distance did not swing. This
 *      only became trustworthy once itemRange's nibbles were fixed — before that
 *      every 1-2 weapon decoded to the empty interval and this test would have
 *      called every hand-axe counter impossible.
 */
type SideVerdict =
  | { kind: "live" }
  /** Real numbers, but the all-hits projection kills it before it swings. */
  | { kind: "diesFirst" }
  | { kind: "absent"; reason: string };

async function sideVerdict(
  m: MgbaClient, s: BattleSide, distance: number | null,
): Promise<SideVerdict> {
  if (s.effHit > 100 || s.effCrit > 100) {
    return {
      kind: "absent",
      reason:
        `its hit/crit read ${s.effHit}%/${s.effCrit}% — 0xFF, never written. The game leaves a side's numbers ` +
        `unwritten when it has no weapon usable at this range (a sword at range 2, a bow at range 1, or no weapon at all)`,
    };
  }
  const n = blows(s);
  if (n > 4) return { kind: "absent", reason: `it claims ${n} blows, which no weapon in the game can do` };
  if (distance !== null && s.weaponId) {
    try {
      const r = await itemRange(m, s.weaponId);
      if (distance < r.min || distance > r.max) {
        return {
          kind: "absent",
          reason: `its weapon 0x${hex2(s.weaponId)} reaches ${r.min}-${r.max} and this fight is at range ${distance}`,
        };
      }
    } catch {
      // An undecodable weapon id is itself evidence the side is stale, but the
      // value tests above are the ones that own that verdict.
    }
  }
  if (n === 0) {
    // Zero blows with real numbers has two causes, and the projected HP tells
    // them apart: a side the simulation killed before its turn to swing sits
    // at 0, while leftovers from an earlier battle do not. Seen live on Ch.7x:
    // Kent vs a 1 HP brigand at range 1 read hit 70%, 0 blows, projected 0.
    if (s.projHp === 0) return { kind: "diesFirst" };
    return { kind: "absent", reason: `it lands no blows yet is not projected to die, so its block is leftovers` };
  }
  return { kind: "live" };
}

/**
 * Displayed hit% -> the probability the blow actually lands.
 *
 * FE7 does not roll one number against the displayed hit. It rolls TWO
 * integers in 0..99, averages them with integer division, and the blow lands
 * if that average is below the displayed hit. Averaging pulls the distribution
 * toward 50, so a displayed 70 lands 81.7% of the time and a displayed 30 only
 * 18.3%. Crit is a single roll, so its displayed value is already the truth.
 *
 * Exact count: the blow lands iff r1 + r2 < 2h, i.e. r1 + r2 <= 2h - 1. Pairs
 * with sum <= k number (k+1)(k+2)/2 for k <= 99 and 10000 - (199-k)(200-k)/2
 * above that, out of 10000 equally likely pairs. Matches the community 2-RN
 * tables (50 -> 50.5, 80 -> 91.8, 85 -> 95.4).
 *
 * This is arithmetic a player can do from the numbers on screen. It is NOT a
 * read of the RNG state and must never become one: the project rule is that
 * tools may only use what a human could see by looking at the game.
 */
export function trueHit(displayed: number): number {
  if (displayed <= 0) return 0;
  if (displayed >= 100) return 100;
  const k = 2 * displayed - 1;
  const pairs = k <= 99 ? ((k + 1) * (k + 2)) / 2 : 10000 - ((199 - k) * (200 - k)) / 2;
  return pairs / 100;
}

const pct = (v: number): string => (Number.isInteger(v) ? `${v}` : v.toFixed(1));

/**
 * One side of the forecast, as a line. `opp` is the other side: its DEF sets
 * this side's damage, and in the dies-first case its hit decides whether this
 * side ever gets to swing.
 */
function formatSide(label: string, s: BattleSide, opp: BattleSide, v: SideVerdict): string {
  if (v.kind === "absent") {
    return (
      `${label}: NO ATTACK — ${v.reason}. Numbers withheld: this side's struct is not populated for ` +
      `this fight, so what is in it belongs to an earlier battle. Treat it as absent, not as zero.`
    );
  }
  const dmg = Math.max(0, s.atk - opp.def);
  const stats =
    `dmg ${dmg}${v.kind === "live" ? ` x${blows(s)}` : ""} (ATK ${s.atk} - DEF ${opp.def})  ` +
    `hit ${s.effHit}% (true ${pct(trueHit(s.effHit))}%)  crit ${s.effCrit}%  AS ${s.as}  avo ${s.avo}  ddg ${s.dodge}`;
  if (v.kind === "live") return `${label}: ${stats}`;
  // Dies-first. The attacker always swings first in FE7, so this side counters
  // exactly when that first blow misses; if it does, this side lands its own
  // blow at its own true hit.
  const survive = 100 - trueHit(opp.effHit);
  return (
    `${label}: dies to the other side's FIRST blow in the all-hits projection, so it swings 0 times there. ` +
    `It DOES counter if that blow misses — ${pct(survive)}% chance — and then: ${stats}`
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

// ── Identifying a menu entry without pressing anything ─────────────────────
//
// The text buffer CANNOT do this: it only ever names a menu's LAST entry (it is a
// decode staging buffer, and painting a menu decodes top to bottom). Stepping the
// highlight never changes it. So identity comes from the menu structure instead.
//
// Around the index byte that locateMenu() returns:
//   -0x01  u8  entry count
//   -0x2D  u32[count]  pointers to per-entry structs, IN MENU ORDER
// and inside each entry struct:
//   +0x30  u32  ROM pointer identifying the COMMAND
//
// The ROM pointer is the stable identity. Verified across two chapters: Wait reads
// 0x08B956BC on both Lyn ch.1 and ch.7 — different arena slots, different menu
// sizes. The EWRAM addresses are NOT stable and must never be hardcoded: slot
// 0x0202547C held Attack on ch.7 and Wait on ch.1.
//
// THE WHOLE TABLE, all 27 of it. Base 0x08B95314, stride 0x24, terminated by an
// all-zero 28th entry, and each entry's +0x09 is a sequential command id 0x4D..0x67.
//
// The names are not guesses. Each entry's +0x00 points at a SHIFT-JIS Japanese
// developer name, left in the US ROM: 待機 (taiki, "standby") for Wait, 制圧
// (seiatsu, "subjugate") for Seize, 攻撃 (kougeki) for Attack. Decoding all 27
// reproduced every pointer this file already knew — seize, attack, item, trade,
// wait — plus the two the run log had only guessed at from context, 0x08B954A0
// ("Visit", found on a house tile) and 0x08B9559C ("Rescue", found beside an
// ally). Seven for seven against independently-derived data.
//
// Entries 1 and 2 share a name and a name pointer but have different handlers;
// the second is unidentified, and 'attack2' says so rather than inventing a
// reason for it.
const MENU_CMD = {
  seize:       0x08b95314, // 制圧
  attack:      0x08b95338, // 攻撃
  attack2:     0x08b9535c, // 攻撃 — same label, different handler; purpose unconfirmed
  staff:       0x08b95380, // 杖
  ride:        0x08b953a4, // 乗る    mount a ballista
  dismount:    0x08b953c8, // 降りる
  play:        0x08b953ec, // 奏でる  Nils
  dance:       0x08b95410, // 踊る    Ninian
  steal:       0x08b95434, // 盗む
  talk:        0x08b95458, // 話す
  support:     0x08b9547c, // 支援
  visit:       0x08b954a0, // 訪問
  chest:       0x08b954c4, // 宝箱
  door:        0x08b954e8, // 扉
  armory:      0x08b9550c, // 武器屋
  vendor:      0x08b95530, // 道具屋
  secretShop:  0x08b95554, // 秘密店
  arena:       0x08b95578, // 闘技場
  rescue:      0x08b9559c, // 救出
  drop:        0x08b955c0, // 降ろす
  take:        0x08b955e4, // 引受け
  give:        0x08b95608, // 引渡し
  item:        0x08b9562c, // 持ち物
  trade:       0x08b95650, // 交換
  supply:      0x08b95674, // 輸送隊  convoy access
  status:      0x08b95698, // 状況
  wait:        0x08b956bc, // 待機
} as const;

// Commands whose +0x08 byte is 0x04. Every one of them is an action FE7 lets a
// unit take without ending its turn, and Trade — the one case this codebase had
// already established behaves that way — is in the set. Treat it as a strong
// hypothesis rather than a proven flag: it has not been tested on the other five.
const MENU_CMD_FREE: ReadonlySet<number> = new Set([
  MENU_CMD.ride, MENU_CMD.dismount, MENU_CMD.take,
  MENU_CMD.give, MENU_CMD.trade, MENU_CMD.supply,
]);

// The "shallow tier": commands whose entire flow is a single A on the menu entry —
// no target selection and no sub-list to navigate. They are reachable purely by
// locating the entry, which is now possible for all 27, so they are the cheapest
// of the unimplemented commands to expose. What none of them has yet is a way to
// PROVE it worked; see the handler in fe7Act for how that is handled honestly.
const SHALLOW_CMD: Record<string, number> = {
  visit:    MENU_CMD.visit,
  door:     MENU_CMD.door,
  chest:    MENU_CMD.chest,
  ride:     MENU_CMD.ride,
  dismount: MENU_CMD.dismount,
  status:   MENU_CMD.status,
};

const MENU_PTRS_OFF = 0x2d;  // entry-pointer array, BELOW the index byte
const ENTRY_CMD_OFF = 0x30;  // ROM command pointer inside an entry struct

/** ROM command pointer of every entry of an open menu, in menu order. Pure read. */
async function menuEntryCmds(m: MgbaClient, menuAddr: number, count: number): Promise<number[]> {
  const ptrs = await readRange(m, menuAddr - MENU_PTRS_OFF, count * 4);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = u32(ptrs, i * 4);
    // Entry structs live in the UI arena; anything else means the offset is wrong
    // on this menu shape rather than that the entry is exotic.
    if (entry < A.uiArena || entry >= A.uiArena + 0x8000) { out.push(0); continue; }
    out.push(u32(await readRange(m, entry + ENTRY_CMD_OFF, 4), 0));
  }
  return out;
}

const cmdName = (v: number) => {
  const hit = Object.entries(MENU_CMD).find(([, p]) => p === v)?.[0];
  if (!hit) return `0x${v.toString(16)}`;
  return MENU_CMD_FREE.has(v) ? `${hit}*` : hit;
};

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
 * Wait for an action to commit, alternating A and Start to clear anything blocking it.
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

type Commit = { ok: boolean; via: "flag" | "phase"; turnBefore: number; turnAfter: number };

// This polls has-acted AND alternates A/Start to clear dialogue (battle result, item
// -use text, event chatter) that would otherwise stall forever. A level-up is
// NOT skippable by any button — it runs at its own pace — so the timeout, not
// the cadence, is what carries that case. Two hazards, both hit live:
//
//  1. If this unit was the last unspent one, its action ends the player phase and
//     the NEW TURN CLEARS has-acted. Polling the flag alone then reads "never
//     committed" for an action that committed perfectly — and the loop keeps
//     pressing. At the old 420ms cadence over a 12s item timeout that was ~28
//     blind presses into a live map. Latch the turn clock and stop the moment it
//     moves. (The press is now Start, whose stray-press failure mode is the
//     inert minimap rather than A's field menu, but stopping early still matters.)
//  2. (WITHDRAWN — see below.) There is no text-based guard here any more.
async function awaitCommit(m: MgbaClient, slot: number, timeoutMs = 25000): Promise<Commit> {
  const c0 = await phaseClock(m);
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  const run = async (): Promise<Commit> => {
    for (;;) {
      const [c, v] = await Promise.all([phaseClock(m), readUnit(m, A.playerArray, slot)]);
      if (c.phase !== c0.phase || c.turn !== c0.turn) {
        return { ok: true, via: "phase", turnBefore: c0.turn, turnAfter: c.turn };
      }
      if (v?.acted) return { ok: true, via: "flag", turnBefore: c0.turn, turnAfter: c.turn };
      if (Date.now() >= deadline) return { ok: false, via: "flag", turnBefore: c0.turn, turnAfter: c.turn };
      // START, not A — see skipWhile() for why the difference is safety, not speed.
      // Alternate A and Start — see skipWhile() for the measured table of which
    // screen yields to which button. A alone misses cutscenes; Start alone misses
    // battle and death quotes, which is the common case right after a commit.
    // NO "Discard." guard. It was added on a misreading and has been removed.
      // The text buffer holds the LAST entry a menu RENDERED, not the highlighted
      // one — confirmed on three menus: field menu -> "End.", action menu ->
      // "Wait", item sub-menu -> "Discard.", each the bottom entry, and stepping
      // the action menu's highlight six times never changed the string. So
      // "Discard." means only "the item sub-menu is open", which is exactly where
      // a legitimate item use also happens. Guarding on it would abort real uses
      // while proving nothing about where the highlight actually sits.
      //
      // Knowing where the highlight is needs the menu's own index byte, which
      // locateMenu()/menuGoTo() already read and verify. Any future guard belongs
      // there, not on this string.
      await press(m, [{ buttons: [tick++ % 2 === 0 ? "A" : "Start"], frames: 4, release_frames: 14 }]);
      await sleep(SKIP_CADENCE_MS);
    }
  };
  const out = await run();
  // Close a minimap a late Start may have opened. Inert if nothing is open.
  await press(m, [{ buttons: ["B"], frames: 4, release_frames: 16 }]);
  return out;
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

/**
 * Ask the game's own renderer what is on ONE tile, by parking the cursor there
 * and reading the on-screen text buffer.
 *
 * NOT the way to map a board — fe7Terrain is. That reads the terrain array
 * directly, returns every tile in three reads and moves no cursor, so it wins
 * outright on "where is the gate", "which tiles are forts", "what is impassable".
 * This tool walks the cursor to each tile and cannot beat the array at the
 * array's own job. It was the only option before the array was located
 * (2026-08-29); it is not any more.
 *
 * What it still answers is what the GAME says, as opposed to what the array
 * holds: the buffer carries objective and menu text the terrain array has no
 * field for, and it is the cross-check when a terrain ID looks wrong.
 *
 * Its blind spot runs the other way. A unit standing on a tile MASKS the terrain
 * in this readout, and the array does not suffer from that — so when the two
 * disagree, suspect occupancy before suspecting a decode error.
 *
 * The buffer is a rendering, not a field, so it is reported raw. Never claim a
 * tile "is" something the buffer did not say.
 */
async function fe7Inspect(m: MgbaClient, tiles: Array<{ x: number; y: number }>): Promise<string> {
  const ps = await readRange(m, A.phase, 2);
  if (ps[0] !== 0x00) return `Phase is 0x${hex2(ps[0])}, not the player phase — the cursor is not free. Try again on the player phase.`;

  // Bounds come from gBmMapSize, which states the map's real size outright.
  // The movement grid used to supply them, and that was wrong twice over: its
  // playable size is INFERRED from stride and row count, and it is only populated
  // while a unit is selected — this tool never selects one, so it was reading
  // whatever the last selection left behind. Same chapter that happens to agree;
  // nothing had populated it for this call.
  const { width, height } = await readMapSize(m);
  const L: string[] = [`map ${width}x${height} (gBmMapSize)`];

  for (const t of tiles) {
    // A real size means a real refusal: no "beyond the inferred edge, trying
    // anyway" hedge is needed now that the number is not a guess.
    if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) {
      L.push(`(${t.x},${t.y}) OFF-MAP — this map is ${width}x${height}.`);
      continue;
    }
    if (!(await moveCursorTo(m, t.x, t.y))) {
      const c = await readCursor(m);
      L.push(`(${t.x},${t.y}) could not reach — cursor stalled at (${c.x},${c.y}). Input may be blocked.`);
      continue;
    }
    // The readout follows the cursor a frame or two behind.
    await sleep(220);
    const c = await readCursor(m);
    const text = await readText(m);
    L.push(`(${c.x},${c.y}) text: ${JSON.stringify(text)}`);
  }

  L.push(`NOTE: this is the cursor readout, not the terrain array. It usually names the tile ` +
    `("Plain."), but it also carries objective and menu text — read the raw string, do not assume. ` +
    `A unit standing on a tile masks its terrain here; fe7_terrain reads the array and does not.`);
  return L.join("\n");
}

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
    // DROPS = the unit-state drop bit is set, so killing it hands its LAST item
    // to the killer. A killer already holding 5 items then halts the game on the
    // inventory-full prompt (see fe7_inventory_full), so this is worth knowing
    // before choosing who takes the kill.
    const drop = dropTag(u);
    if (brief) {
      L.push(`  #${u.slot} cls${hex2(u.classId)} (${u.x},${u.y}) ${u.hp}/${u.maxHp}${drop}`);
    } else {
      const items = u.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",");
      L.push(
        `  #${u.slot} cls${hex2(u.classId)} Lv${u.level} (${u.x},${u.y}) HP${u.hp}/${u.maxHp}` +
        ` S${u.str} K${u.skl} P${u.spd} D${u.def} R${u.res}` + (items ? ` [${items}]` : "") + drop,
      );
    }
  }

  // Green units block destinations exactly like allies do, and they fight the
  // enemy on their own during the green phase, so their positions and HP matter.
  if (npcs.length) {
    // #N is the ARRAY SLOT, the same number fe7_act's target_slot expects with
    // target_faction:'green', and the same one its refusal messages print. This
    // used to render the roster byte as "g41" while fe7_act called the identical
    // unit "#0", so healing the one NPC a chapter is about was a coin flip
    // between two numbers with no way to tell which the parameter wanted.
    L.push(`GREEN (allied NPCs — block tiles, act on the green phase; #N is the slot target_faction:'green' takes):`);
    for (const u of npcs) {
      // Same shape as players and enemies. Greens used to get a stats-free,
      // items-free line, which on a protect chapter withheld exactly the facts
      // the chapter turns on: the objective unit IS a green, so "how much damage
      // does it survive" and "is it carrying a vulnerary" were unanswerable.
      if (brief) {
        L.push(`  #${u.slot} r${hex2(u.roster)} cls${hex2(u.classId)} (${u.x},${u.y}) ${u.hp}/${u.maxHp}`);
      } else {
        const items = u.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",");
        L.push(
          `  #${u.slot} r${hex2(u.roster)} cls${hex2(u.classId)} Lv${u.level} (${u.x},${u.y}) HP${u.hp}/${u.maxHp}` +
          ` S${u.str} K${u.skl} P${u.spd} D${u.def} R${u.res} L${u.lck}` + (items ? ` [${items}]` : ""),
        );
      }
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
  // PRE-FLIGHT, the same guard fe7_act has. Without it this pressed A on a spent
  // unit, which is NOT a no-op: the game treats the tile as empty and opens the
  // FIELD MENU (Unit/Status/Options/Suspend/End). The old code then reported
  // "input swallowed" — a phrase that points at the emulator bridge and invites
  // retrying — for a plain, permanent refusal, and left the menu open for the
  // next call to trip over. This is the cheaper, scout-first tool, so it needs
  // the guard more than fe7_act does, not less.
  if (u.acted) {
    return `Unit #${slot} has already acted this phase (+0x0C bit 1 set), and the game will not select a spent ` +
      `unit — so there is no movement grid to read. Nothing was pressed. This is a permanent refusal until the ` +
      `next turn, not blocked input and not something to retry.`;
  }

  if (!u.selected) {
    if (!(await moveCursorTo(m, u.x, u.y))) return `Could not move cursor onto unit #${slot} at (${u.x},${u.y}) — input may be blocked.`;
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 20 }]);
    const okSel = await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && v.selected;
    }, 1500);
    if (!okSel) {
      // Always unwind. An A that did not select something opened SOMETHING, and
      // returning without a B is what left a field menu standing and produced a
      // second wrong diagnosis one call later.
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
      return `Pressed A on (${u.x},${u.y}) but unit #${slot} never became selected. Pressed B to unwind, in case ` +
        `the A opened the field menu rather than selecting. The unit reads unspent and alive, so if this repeats ` +
        `call fe7_unstick — do not keep pressing.`;
    }
  }

  const grid = await readGrid(m);
  const bad = gridMismatch(grid, u);
  if (bad) {
    // Always deselect on a FAILURE, even when keep_selected was asked for: there
    // is nothing worth keeping selected, and leaving a unit selected is exactly
    // what wedges the next call.
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return `${bad} Deselected with B (keep_selected does not apply to a failed read).`;
  }

  const occMap = occupancy(
    { units: players.filter((p) => p.slot !== slot), mark: "U" },
    { units: enemies, mark: "E" },
    { units: greens, mark: "G" },
  );
  const occupied = new Map<string, string>();
  for (const [k, v] of occMap) occupied.set(k, v.mark);

  // Bound the printed map to the interesting rows so output stays compact.
  let minY = grid.indexRows, maxY = -1, minX = grid.stride, maxX = -1;
  const tiles: Array<{ x: number; y: number; cost: number }> = [];
  for (let y = 0; y < grid.indexRows; y++) {
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
    L.push(`legend: digits = move cost and a LEGAL STOP | U = ally, G = green NPC — you may route THROUGH these ` +
      `but not stop on them | E = enemy — enemies BLOCK pathing outright, so an enemy tile and anything only ` +
      `reachable past it is unreachable, which is why those tiles read . rather than a cost | . = unreachable`);
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
  // Occupancy must cover ALL THREE factions. Green NPCs were the cause of a
  // whole class of "legal but refused" failures before they were included here:
  // they sit in the cost map as pass-through, exactly like allies.
  const occ = occupancy(
    { units: players.filter((o) => o.slot !== slot), mark: "ally" },
    { units: enemies, mark: "enemy" },
    { units: greens, mark: "green" },
  ).get(`${destX},${destY}`);

  const cost = gridCost(grid, destX, destY);
  if (cost === UNREACHABLE) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    // 0xFF has three quite different causes and the old message offered two
    // guesses, neither of which was the truth when an enemy stood on the tile.
    // Allies and greens are pass-through so their tiles carry a COST; only an
    // enemy makes a tile read 0xFF, because enemies block pathing outright. The
    // occupancy lookup was already computed one branch below — it just ran too
    // late to be used here.
    const t = await terrainAt(m, destX, destY);
    const reach = Math.max(0, ...grid.rows.flat().filter((v) => v !== UNREACHABLE));
    const why =
      occ && occ.mark === "enemy"
        ? `an ENEMY is standing there (slot #${occ.u.slot}, cls${hex2(occ.u.classId)}, HP ${occ.u.hp}/${occ.u.maxHp}). ` +
          `Enemies BLOCK pathing in FE7, so that tile — and anything only reachable past it — reads 0xFF.`
        : `nothing is standing on it. Terrain there is ${terrainName(t ?? -1)}` +
          (t === null ? `` : ` (0x${hex2(t)})`) +
          `, it is ${Math.abs(destX - startX) + Math.abs(destY - startY)} tiles away in a straight line, and this ` +
          `unit's grid reaches cost ${reach} at most — so it is out of Move, or impassable for its movement class.`;
    return {
      ok: false,
      text:
        `Destination (${destX},${destY}) is NOT reachable for unit #${slot} — ${why} ` +
        `Move cancelled; unit still at (${startX},${startY}) and unspent.`,
    };
  }
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
  weaponSlot: number | null = null,
): Promise<ActResult> {
  // PRE-FLIGHT. These refusals depend only on the unit's own record, so finding
  // them out AFTER prologue() has already selected the unit and walked it to the
  // destination costs a move and a planning cycle for nothing. One run spent a
  // unit's turn discovering that a Monk cannot swing the Heal staff it carries.
  // Nothing is pressed here — the unit does not move at all.
  if (action === "staff") {
    const pre = await readUnit(m, A.playerArray, slot);
    if (pre) {
      const where = `Nothing was moved or pressed; unit #${slot} is unspent at (${pre.x},${pre.y}).`;
      if (targetSlot === null) {
        return { text: `action="staff" needs target_slot — who to heal. ${where}` };
      }
      const preStaves = await staffSlots(m, pre);
      if (preStaves.length === 0) {
        return {
          text: `Unit #${slot} carries no staff (inventory: ${pre.items.map((i) => hex2(i.id)).join(",") || "empty"}). ${where}`,
        };
      }
      // Carrying a staff and being able to USE one are different facts, and only
      // the second one matters: rank 0 means the class cannot use that type at
      // all, so the game omits the Staff entry entirely.
      if (pre.ranks[WTYPE_STAFF] === 0) {
        return {
          text:
            `Unit #${slot} carries a staff (${preStaves.map((i) => hex2(pre.items[i].id)).join(",")}) but its STAFF RANK is 0 — ` +
            `its class cannot use staves, so the game offers no Staff entry and it is only hauling one. ${where}`,
        };
      }
    }
  }

  // Same argument for 'item' with no item_slot: whether the unit carries anything
  // it can use on itself is a property of its inventory alone, so it is knowable
  // before the unit takes a step. Only when no slot was named — an explicit slot
  // may legitimately point at a key or a stat booster, which are not type 9.
  if (action === "item" && itemSlot === null) {
    const pre = await readUnit(m, A.playerArray, slot);
    if (pre) {
      let any = false;
      for (const it of pre.items) if ((await itemType(m, it.id)) === 9) { any = true; break; }
      if (!any) {
        return {
          text:
            `Unit #${slot} carries no usable consumable — inventory is ` +
            `${pre.items.map((i) => hex2(i.id)).join(",") || "empty"}, all weapons or staves. There is nothing to ` +
            `'use' on itself. Nothing was moved or pressed; it is unspent at (${pre.x},${pre.y}).`,
        };
      }
    }
  }

  // weapon_slot is knowable in full before moving: the slot, its type, the unit's
  // rank in it, and — since the destination is given — whether it reaches anything.
  if (action === "attack" && weaponSlot !== null) {
    const pre = await readUnit(m, A.playerArray, slot);
    if (pre) {
      const where = `Nothing was moved or pressed; unit #${slot} is unspent at (${pre.x},${pre.y}).`;
      const w = await weaponSlotPreflight(m, pre, weaponSlot);
      if (!w.ok) return { text: `${w.reason}. ${where}` };
      const foes = await readArray(m, A.enemyArray);
      const reach = (e: Unit) => {
        const d = Math.abs(e.x - destX) + Math.abs(e.y - destY);
        return d >= w.min && d <= w.max;
      };
      if (targetSlot !== null) {
        const t = bySlot(foes, targetSlot);
        if (!t || t.dead) return { text: `No living enemy in slot ${targetSlot}. ${where}` };
        if (!reach(t)) {
          const d = Math.abs(t.x - destX) + Math.abs(t.y - destY);
          return {
            text:
              `weapon_slot ${weaponSlot} (0x${hex2(w.id)}) reaches ${w.min}-${w.max}, but enemy #${targetSlot} at (${t.x},${t.y}) ` +
              `is ${d} from (${destX},${destY}). ${where}`,
          };
        }
      } else if (!foes.some((e) => !e.dead && reach(e))) {
        return {
          text: `weapon_slot ${weaponSlot} (0x${hex2(w.id)}) reaches ${w.min}-${w.max} and no enemy is within that of (${destX},${destY}). ${where}`,
        };
      }
    }
  }

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

  if (action === "seize") {
    const menu = await locateMenu(m);
    if (!menu) {
      await unwind(m, slot, startX, startY);
      return { text: `Could not locate unit #${slot}'s action menu at (${destX},${destY}). Backed out; unit unspent.` };
    }
    const cmds = await menuEntryCmds(m, menu.addr, menu.count);
    const idx = cmds.indexOf(MENU_CMD.seize);
    const shape = cmds.map(cmdName).join(", ");
    if (idx < 0) {
      await unwind(m, slot, startX, startY);
      return {
        text:
          `No Seize entry on unit #${slot}'s action menu at (${destX},${destY}) — the menu holds [${shape}]. ` +
          `Either this tile is not the objective, or this unit is not a lord. Nothing was pressed; unit unspent at (${startX},${startY}).`,
      };
    }
    if (!(await menuGoTo(m, menu.addr, idx, menu.count))) {
      await unwind(m, slot, startX, startY);
      return { text: `Found Seize at index ${idx} of [${shape}] but could not move the highlight onto it. Backed out; unit unspent.` };
    }
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    const c = await awaitCommit(m, slot, 15000);
    const note = await readText(m);
    return {
      text: c.ok
        ? `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, SEIZED. ` +
          `Menu was [${shape}], Seize at index ${idx}. ` +
          (c.via === "phase" ? `Phase/turn moved (${c.turnBefore} -> ${c.turnAfter}). ` : `+0x0C set. `) +
          `Text buffer: ${JSON.stringify(note)}.`
        : `Unit #${slot} moved to (${destX},${destY}) and Seize (index ${idx} of [${shape}]) was chosen, but nothing ` +
          `confirmed within 15s. Text buffer: ${JSON.stringify(note)}. Something is still on screen.`,
    };
  }

  // ── Shallow-tier commands ────────────────────────────────────────────────
  //
  // Visit, Door, Chest, Ride, Dismount, Status: the six commands whose entire
  // flow is "press A on the entry" — no target selection, no sub-list. The entry
  // is located by its ROM pointer exactly as 'seize' is, so nothing is ever
  // pressed that could not be named first.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO IS CLAIM SUCCESS. No confirm-by-effect
  // signal is known for any of them — which field proves a village was visited or
  // a chest opened is simply not documented. So this reports the raw before/after
  // delta of everything cheap to read and lets the caller judge, instead of
  // inventing a verdict. Reporting "it worked" without a signal would be the same
  // defect as the forecast printing stale bytes as data.
  //
  // It is also how the signals get learned: the first successful Visit shows which
  // bytes move, and that goes in a note and then into RAM.md.
  if (SHALLOW_CMD[action] !== undefined) {
    const want = SHALLOW_CMD[action];
    const label = action[0].toUpperCase() + action.slice(1);

    const snap = async () => {
      const b = await readRange(m, A.playerArray + slot * UNIT_STRIDE, 0x30);
      const v = decodeUnit(b, 0, 0, A.playerArray);
      const c = await phaseClock(m);
      return {
        x: v?.x, y: v?.y, hp: v?.hp,
        flags: (v?.flags ?? 0) & 0xff,
        items: v?.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",") ?? "",
        turn: c.turn, phase: c.phase,
        terrain: await terrainAt(m, destX, destY),
      };
    };
    const before = await snap();

    const menu = await locateMenu(m);
    if (!menu) {
      await unwind(m, slot, startX, startY);
      return { text: `Unit #${slot} reached (${destX},${destY}) but the action menu could not be located. Backed out; unit unspent.` };
    }
    const cmds = await menuEntryCmds(m, menu.addr, menu.count);
    const shape = cmds.map(cmdName).join(", ");
    const idx = cmds.indexOf(want);
    if (idx < 0) {
      await unwind(m, slot, startX, startY);
      return {
        text:
          `No ${label} entry on unit #${slot}'s action menu at (${destX},${destY}) — the menu holds [${shape}]. ` +
          `The game is not offering it here. Nothing was pressed; unit unspent at (${startX},${startY}).`,
      };
    }
    if (!(await menuGoTo(m, menu.addr, idx, menu.count))) {
      await unwind(m, slot, startX, startY);
      return { text: `Found ${label} at index ${idx} of [${shape}] but could not move the highlight onto it. Nothing pressed; unit unspent.` };
    }

    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
    const isFree = MENU_CMD_FREE.has(want);
    if (isFree) {
      // Marked as not consuming the turn, so waiting on the spent flag would just
      // burn the timeout. Give the screen a moment and then look.
      await sleep(1000);
    } else {
      await skipWhile(m, async () => {
        const [c, v] = await Promise.all([phaseClock(m), readUnit(m, A.playerArray, slot)]);
        return c.turn !== before.turn || c.phase !== before.phase || !!v?.acted;
      }, 20000);
    }

    const note = await readText(m);

    // Return to a free cursor whatever happened. B closes a status screen, backs
    // out of anything that did not commit, and is inert on a free map cursor.
    let freed = await cursorResponds(m);
    for (let i = 0; i < 3 && !freed; i++) {
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 22 }]);
      await sleep(280);
      freed = await cursorResponds(m);
    }

    const after = await snap();
    const chg: string[] = [];
    if (after.x !== before.x || after.y !== before.y) chg.push(`position (${before.x},${before.y}) -> (${after.x},${after.y})`);
    if (after.hp !== before.hp) chg.push(`HP ${before.hp} -> ${after.hp}`);
    if (after.flags !== before.flags) chg.push(`+0x0C 0x${hex2(before.flags)} -> 0x${hex2(after.flags)}${(after.flags & 0x02) ? " (now SPENT)" : ""}`);
    if (after.items !== before.items) chg.push(`inventory ${before.items || "-"} -> ${after.items || "-"}`);
    if (after.turn !== before.turn) chg.push(`turn ${before.turn} -> ${after.turn}`);
    if (after.phase !== before.phase) chg.push(`phase 0x${hex2(before.phase)} -> 0x${hex2(after.phase)}`);
    if (after.terrain !== before.terrain) {
      chg.push(`terrain at (${destX},${destY}) ${terrainName(before.terrain ?? -1)} -> ${terrainName(after.terrain ?? -1)}`);
    }

    return {
      text:
        `Unit #${slot}: ${label} found at index ${idx} of [${shape}] at (${destX},${destY}), highlighted and A pressed` +
        (isFree ? ` (this command is flagged as NOT consuming the turn).` : `.`) + `\n` +
        `  changed: ${chg.length ? chg.join("; ") : "NOTHING detectable in the unit record, the turn clock, or that tile's terrain"}\n` +
        `  text buffer: ${JSON.stringify(note)}\n` +
        `  cursor free afterwards: ${freed ? "yes" : "NO — something is still on screen, call fe7_unstick"}\n` +
        `  NOTE: no confirm-by-effect signal is known for '${action}' yet, so this reports what changed and ` +
        `does NOT claim the action succeeded. If it did work, the delta above IS the signal — record it with ` +
        `fe7_note so it can go into RAM.md.`,
    };
  }

  if (action === "attack") {
    // Range comes from the WEAPONS THIS UNIT CAN ACTUALLY USE, not from an
    // assumption of melee. Hardcoding distance == 1 silently refused every hand
    // axe, bow and tome attack and made the unit Wait instead — wasting the turn
    // and reporting "no enemy is adjacent", which was true and irrelevant.
    let minR = 99, maxR = 0;
    let wantWeapon: { id: number; listIndex: number } | null = null;
    if (weaponSlot !== null) {
      // Re-derived from the post-move record (the pre-flight above used the
      // pre-move one); the range that matters is this weapon's alone.
      const w = await weaponSlotPreflight(m, u, weaponSlot);
      if (!w.ok) {
        const restored = await unwind(m, slot, startX, startY);
        return { text: `${w.reason}. Nothing was committed; unit #${slot} is ${restored ? `unwound to (${startX},${startY}) and unspent.` : "unspent, but could not be fully unwound — check fe7_state."}` };
      }
      minR = w.min; maxR = w.max; wantWeapon = { id: w.id, listIndex: w.listIndex };
    } else {
      for (const it of u.items) {
        const t = await itemType(m, it.id);
        if (t === WTYPE_STAFF || t === 9 || u.ranks[t] === 0) continue;
        const r = await itemRange(m, it.id);
        if (r.max > maxR) maxR = r.max;
        if (r.min < minR) minR = r.min;
      }
    }
    const adj = maxR === 0 ? [] : enemies.filter((e) => {
      if (e.dead) return false;
      const d = Math.abs(e.x - destX) + Math.abs(e.y - destY);
      return d >= minR && d <= maxR;
    });
    if (adj.length === 0) {
      // Back out; do NOT commit Wait. This used to fall through to commitWait and
      // report "Waited instead.", which spent the unit's whole turn on an action
      // the caller did not ask for and contradicted this tool's own documented
      // contract ("cancels cleanly with B on any pre-commit failure"). It cost two
      // units their turn in one chapter. Deciding to Wait is the caller's call.
      // (The old line also always claimed "Waited instead." regardless: it tested
      // commitWait's returned OBJECT for truthiness, which is never false.)
      const restored = await unwind(m, slot, startX, startY);
      const why = maxR === 0
        ? `unit #${slot} has no usable weapon (inventory ${u.items.map((i) => hex2(i.id)).join(",") || "empty"})`
        : `no enemy is within its weapon range ${minR}-${maxR} of (${destX},${destY})`;
      return {
        text:
          `Attack is unavailable — ${why}. Nothing was committed and NO Wait was issued: unit #${slot} is ` +
          (restored
            ? `UNSPENT and back at (${startX},${startY}), free to do something else this turn.`
            : `unspent, but could not be fully unwound — check fe7_state before acting.`),
      };
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
    let weaponHow = "";
    await clearForecastGate(m);
    for (let step = 0; step < 4; step++) {
      await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);

      // The first A chose Attack. With a weapon requested, resolve the weapon list
      // NOW, confirmed against the actor BattleUnit, before any target is picked.
      // A refused pick unwinds with the unit unspent — never a Wait, never a swing.
      if (step === 0 && wantWeapon && !picked) {
        const sel = await selectAttackWeapon(m, wantWeapon.id, wantWeapon.listIndex);
        if (!sel.ok) {
          const restored = await unwind(m, slot, startX, startY);
          return {
            text:
              `Attack with weapon_slot ${weaponSlot} (0x${hex2(wantWeapon.id)}) was refused: ${sel.reason}. ` +
              `Nothing was committed and NO Wait was issued; unit #${slot} is ` +
              (restored
                ? `UNSPENT and back at (${startX},${startY}), free to do something else this turn.`
                : `unspent, but could not be fully unwound — check fe7_state before acting.`),
          };
        }
        weaponHow = sel.how;
      }

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
        const tt = await battleTargetTile(m);
        const dist = tt ? Math.abs(tt.x - destX) + Math.abs(tt.y - destY) : null;
        const [aV, dV] = await Promise.all([
          sideVerdict(m, f.actor, dist),
          sideVerdict(m, f.target, dist),
        ]);
        forecast =
          `\n  forecast  ${formatSide("attacker", f.actor, f.target, aV)}` +
          `\n            ${formatSide("defender", f.target, f.actor, dV)}`;
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

    // Combat, its animation, and whatever the game puts on screen afterwards: a
    // boss pre-battle quote, a death quote, a weapon-broke box, a level-up.
    //
    // This used to press NOTHING for 45s and then report failure, which is how
    // three separate run-log notes came to describe a COMPLETED KILL as "nothing
    // happened" — the worst available shape of failure, because it invites
    // re-issuing an action that already landed. Committing an attack is the most
    // likely way in the whole game to trigger a dialogue box, so this is exactly
    // the wait that needed to press through them.
    //
    // The turn clock, not the flag, remains the truth: a unit that was the last
    // unspent one ends the phase, and the new turn clears has-acted.
    const clk0 = await phaseClock(m);
    let endedPhase = false;
    const sk = await skipCombat(m, async () => {
      const [c, v] = await Promise.all([phaseClock(m), readUnit(m, A.playerArray, slot)]);
      if (c.phase !== clk0.phase || c.turn !== clk0.turn) { endedPhase = true; return true; }
      return !!v && v.acted;
    }, 45000);
    const done = sk.ok;

    const after = await readArray(m, A.enemyArray);
    const self = await readUnit(m, A.playerArray, slot);
    const deltas = before
      .map((b) => {
        const now = bySlot(after, b.slot);
        return now ? `#${b.slot} ${b.hp}->${now.hp}${now.hp === 0 ? " KILLED" : ""}` : `#${b.slot} gone`;
      })
      .join(", ");
    // Read AFTER the wait, so this reflects the resolved fight rather than the
    // pre-combat values a mid-animation read returns.
    const landed = before.some((b) => {
      const now = bySlot(after, b.slot);
      return !now || now.hp !== b.hp;
    });
    if (sk.prompt) {
      return {
        text:
          `Unit #${slot} attacked from (${destX},${destY}). Enemy HP: ${deltas}. Self: HP ${self?.hp}/${self?.maxHp}. ` +
          `The fight resolved and the game is now HALTED on the inventory-full prompt; the unit's turn completes once it is answered.${forecast}\n` +
          formatInvPrompt(sk.prompt),
      };
    }
    return {
      text: done
        ? `Unit #${slot} attacked from (${destX},${destY}). Enemy HP: ${deltas}. Self: HP ${self?.hp}/${self?.maxHp},` +
          (wantWeapon
            ? ` weapon 0x${hex2(wantWeapon.id)} via ${weaponHow}; the game re-equipped it, inventory is now ` +
              `${self?.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",") ?? "?"} (slot numbers shifted).`
            : "") +
          ` ` +
          (endedPhase
            ? `and it was the last unspent unit, so the player phase ended.${forecast}`
            : `+0x0C=0x${hex2((self?.flags ?? 0) & 0xff)}.${forecast}`)
        : `Unit #${slot} moved to (${destX},${destY}) and Attack was chosen, but the has-acted flag never set within 45s. ` +
          (landed
            ? `The attack DID resolve — enemy HP changed: ${deltas}. This is a missing CONFIRMATION, not a missing action, so do NOT re-issue it: that would attack a second time. A level-up runs at its own pace and no button skips it. Call fe7_wait, then fe7_state to confirm.`
            : `No enemy HP moved (${deltas}), so there is no evidence the attack resolved at all. Call fe7_unstick before retrying.`),
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

    // The three staff checks below are now a BACKSTOP: fe7Act pre-flights them
    // before moving. They still run in case that pre-flight read came back null.
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

    // action='item' means "use this on yourself", and inventory slot 0 is almost
    // always a WEAPON — a unit that carries one carries it first. Defaulting to 0
    // meant the default tried to "use" an Iron Sword, and the resulting failure
    // pointed nowhere near the real cause. Default to the first CONSUMABLE
    // instead (weapon type 9), and name what the unit does carry when there is none.
    const consumables: number[] = [];
    if (action === "item") {
      for (let i = 0; i < u.items.length; i++) {
        if ((await itemType(m, u.items[i].id)) === 9) consumables.push(i);
      }
      if (itemSlot === null && consumables.length === 0) {
        await unwind(m, slot, startX, startY);
        return {
          text:
            `Unit #${slot} carries no usable consumable — inventory is ` +
            `${u.items.map((i) => hex2(i.id)).join(",") || "empty"}, all weapons or staves. There is nothing to ` +
            `'use' on itself. Left unspent at (${startX},${startY}).`,
        };
      }
    }

    // Which entry of the sub-list we want: for a staff, the staff list holds only
    // type-4 items in inventory order, so an inventory slot has to be mapped into
    // that shorter list. For an item, list index == inventory slot exactly.
    const wantInvSlot = itemSlot ?? (action === "staff" ? staves[0] : consumables[0]);
    const listIndex = action === "staff" ? Math.max(0, staves.indexOf(wantInvSlot)) : wantInvSlot;
    if (action === "item" && (wantInvSlot < 0 || wantInvSlot >= u.items.length)) {
      await unwind(m, slot, startX, startY);
      return { text: `item_slot ${wantInvSlot} is out of range — unit #${slot} carries ${u.items.length} item(s). Left unspent.` };
    }
    // An EXPLICIT item_slot pointing at a weapon or staff (types 0-7) is the same
    // mistake made deliberately. Refuse it by name rather than driving the menus
    // and failing somewhere less legible. Unknown types are allowed through —
    // keys and stat boosters are not worth guessing wrong about.
    if (action === "item" && itemSlot !== null) {
      const t = await itemType(m, u.items[wantInvSlot].id);
      if (t <= 7) {
        await unwind(m, slot, startX, startY);
        return {
          text:
            `item_slot ${wantInvSlot} holds 0x${hex2(u.items[wantInvSlot].id)}, a weapon or staff (type ${t}), not ` +
            `something a unit can use on itself. ` +
            (consumables.length
              ? `Unit #${slot} does carry a consumable in slot ${consumables.join(" and ")}.`
              : `Unit #${slot} carries no consumable at all.`) +
            ` Nothing was pressed; left unspent at (${startX},${startY}).`,
        };
      }
    }

    const menu = await locateMenu(m);
    if (!menu) {
      await unwind(m, slot, startX, startY);
      return { text: `Unit #${slot} moved to (${destX},${destY}) but the action menu could not be located by diff. Left unspent — retry, or use action="wait".` };
    }

    // READ the entry index; do not derive it. This used to compute the index
    // arithmetically from a model of the menu's fixed order — "Staff is 0, or 1
    // when Attack is present", "Item is counted from the bottom, Wait last, Trade
    // above it" — which meant reconstructing WHICH commands the game had decided to
    // offer, from range checks and adjacency tests done on this side. Get any of
    // those inputs wrong and the arithmetic lands on a different entry with total
    // confidence; a 2026-09-01 run derived index 0 for a Monk's Staff and hit
    // something else, spending a planning cycle to find out.
    //
    // None of that is necessary now that all 27 command pointers are known (see
    // MENU_CMD). The menu already states its own contents: each entry struct
    // carries the ROM pointer of its command, so the index is a lookup, not an
    // inference. This is exactly what action='seize' has always done.
    const cmds = await menuEntryCmds(m, menu.addr, menu.count);
    const wantCmd = action === "staff" ? MENU_CMD.staff : MENU_CMD.item;
    const wantIndex = cmds.indexOf(wantCmd);
    const shape = `menu holds [${cmds.map(cmdName).join(", ")}]`;
    if (wantIndex < 0) {
      await unwind(m, slot, startX, startY);
      return {
        text:
          `No ${label} entry on unit #${slot}'s action menu at (${destX},${destY}) — ${shape}. ` +
          `The game is not offering it here, so there is nothing to press. ` +
          (action === "staff"
            ? `A staff needs a healable target in range, and the unit's class must be able to use staves.`
            : `Item needs something usable in the inventory.`) +
          ` Nothing was pressed; unit unwound to (${startX},${startY}), unspent.`,
      };
    }
    if (!(await menuGoTo(m, menu.addr, wantIndex, menu.count))) {
      await unwind(m, slot, startX, startY);
      return { text: `Found ${label} at index ${wantIndex} of the ${shape} but could not move the highlight onto it. Nothing pressed; unit unwound and unspent.` };
    }

    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 24 }]);
    await sleep(200);

    // BACKSTOP. The index came from the menu's own command pointers, so landing on
    // Rescue or Trade should now be impossible — but both jump straight to a target
    // selection where the NEXT A commits, so the check stays: it costs one read and
    // it is the difference between a clean back-out and a wrong commit.
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
        return { text: `Index ${wantIndex} turned out to be Attack, not Item (${shape}) — the forecast went live, which should be unreachable now the index is read from the menu rather than derived. Backed out before committing; unit #${slot} unspent at (${startX},${startY}).` };
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

  return {
    text:
      `Unknown action "${action}". Verified actions: wait, attack, staff, item, seize. ` +
      `Shallow-tier (selection verified, outcome UNVERIFIED): visit, door, chest, ride, dismount, status.`,
  };
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
  weaponSlot: number | null = null,
): Promise<string> {
  const pro = await prologue(m, slot, destX, destY);
  if (!pro.ok) return pro.text;
  const { u, enemies, startX, startY } = pro;

  let want: { id: number; listIndex: number } | null = null;
  if (weaponSlot !== null) {
    const w = await weaponSlotPreflight(m, u, weaponSlot);
    if (!w.ok) {
      await unwind(m, slot, startX, startY);
      return `${w.reason}. Nothing changed; unit #${slot} is back at (${startX},${startY}) and unspent.`;
    }
    want = { id: w.id, listIndex: w.listIndex };
  }

  const menu = await locateMenu(m);
  if (!menu) {
    await unwind(m, slot, startX, startY);
    return `Unit #${slot} reached (${destX},${destY}) but the action menu could not be located. Nothing changed.`;
  }

  // With a weapon requested, find Attack by its ROM command pointer instead of
  // probing entries in order: the probe's blind second A inside the Item list
  // would otherwise land on an item sub-menu, and the weapon-list walk below
  // must only ever run inside the real weapon list.
  let cands: number[] = Array.from({ length: menu.count - 1 }, (_, i) => i);
  if (want) {
    const cmds = await menuEntryCmds(m, menu.addr, menu.count);
    const at = cmds.findIndex((c) => c === MENU_CMD.attack || c === MENU_CMD.attack2);
    if (at < 0) {
      await unwind(m, slot, startX, startY);
      return `No Attack entry on unit #${slot}'s action menu at (${destX},${destY}) — it holds [${cmds.map(cmdName).join(", ")}]. Nothing changed.`;
    }
    cands = [at];
  }
  let weaponNote = "";

  const tried: string[] = [];
  for (const cand of cands) {
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

    if (want) {
      const sel = await selectAttackWeapon(m, want.id, want.listIndex);
      if (!sel.ok) {
        await unwind(m, slot, startX, startY);
        return `Forecast with weapon_slot ${weaponSlot} (0x${hex2(want.id)}) was refused: ${sel.reason}. Nothing changed; unit #${slot} is back at (${startX},${startY}) and unspent.`;
      }
      weaponNote = ` with 0x${hex2(want.id)} (${sel.how})`;
    } else {
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
    const dist = t ? Math.abs(t.x - destX) + Math.abs(t.y - destY) : null;
    const [aV, dV] = await Promise.all([
      sideVerdict(m, f.actor, dist),
      sideVerdict(m, f.target, dist),
    ]);

    const restored = await unwind(m, slot, startX, startY);
    // Picking from the weapon list re-equips immediately, and unwinding does not
    // undo it (verified live). Say so, and print the order the caller will now see.
    const after = want ? await readUnit(m, A.playerArray, slot) : null;
    const lines = [
      `Forecast — unit #${slot} cls${hex2(u.classId)} attacking from (${destX},${destY})${weaponNote}` +
        (foe ? ` vs enemy #${foe.slot} cls${hex2(foe.classId)} at (${foe.x},${foe.y}) HP ${foe.hp}/${foe.maxHp}`
             : t ? ` vs the unit on (${t.x},${t.y}) (not matched to an enemy slot)` : ""),
      `  ${formatSide("attacker", f.actor, f.target, aV)}`,
      `  ${formatSide("defender", f.target, f.actor, dV)}`,
      `  projected HP after: attacker ${f.actor.projHp}, defender ${f.target.projHp}` +
        `  <- a deterministic every-blow-lands projection, NOT a prediction; real combat rolls hit and crit`,
      ...(after && want
        ? [`  NOTE: picking 0x${hex2(want.id)} from the list RE-EQUIPPED it even though nothing was committed — inventory is now ` +
           `${after.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(",")}; slot numbers have shifted, so re-read fe7_state.`]
        : []),
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
/** Strings that mean the CHAPTER itself has ended, win or lose. */
const CHAPTER_END_RE = /we'?ve won|victory|game over|the enemy'?s fled|has fallen|retreat/i;

/**
 * Is the ASCII buffer showing prose — an event or dialogue — rather than a tile
 * readout? Tile names are one short word ("Plain.", "Fort.", "Gate."); event text
 * is a sentence. The buffer renders non-ASCII as '.', so strip those before
 * counting. Deliberately a shape test, not a keyword list: it has to catch event
 * text nobody has seen yet.
 */
function readoutLooksLikeProse(text: string): boolean {
  const words = text.replace(/\./g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length >= 5 || words.join("").length >= 24;
}

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
  const textBuf = await readText(m);
  L.push(`       text buffer: ${JSON.stringify(textBuf)}`);

  // The one screen where the usual advice ("press A / Start") would DO something
  // irreversible: A on the inventory-full list sends that item. Name it first.
  const inv = await inventoryFullIfHinted(m, true);
  if (inv) {
    L.push("");
    L.push(`VERDICT  ${formatInvPrompt(inv)}`);
    return { text: L.join("\n") };
  }

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
    rec.push(`Call fe7_wait — it polls the phase and alternates A and Start about once a second: A advances a death quote, Start skips a cutscene whole, and neither is dangerous while the enemy phase owns input.`);
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
  } else if (CHAPTER_END_RE.test(textBuf)) {
    // The text buffer OUTRANKS the forecast gate. A run once got the confident
    // verdict "POSSIBLY an attack target selection" while this same buffer read
    // "....The enemy's fled......We've won!!!." — the chapter was over and the
    // advice was to press B to back out of a cutscene. The decisive field was
    // printed in the same output and simply never consulted.
    verdict = `CHAPTER EVENT — the text buffer names an outcome, not a tile: ${JSON.stringify(textBuf)}`;
    rec.push(`The chapter has ended or is ending. Press Start to advance the event; it is not stuck and there is nothing to back out of.`);
    rec.push(`Confirm with fe7_state afterwards — a win moves to the next chapter, a loss leaves the phase byte stuck forever, which is why fe7_wait can never terminate on its own here.`);
  } else if (readoutLooksLikeProse(textBuf)) {
    // Same demotion, for ordinary event text. Verified live: cursor frozen on the
    // player phase with the buffer reading "We'll serve as your reinforcements",
    // which the old chain called a possible attack target selection. One Start
    // press cleared it and freed the cursor.
    // Prose covers two different screens and they take different buttons, so name
    // both rather than guess. Dialogue ("We'll serve as your reinforcements")
    // clears with Start; a unit INFO screen, whose buffer holds a class blurb like
    // "Rogues and fortune-hunters. Possess..weak attack", closes with B. Both look
    // identical from memory: cursor frozen, no menu index, prose in the buffer.
    verdict = `EVENT, DIALOGUE OR INFO SCREEN — the cursor is frozen and the text buffer holds prose rather than a tile name: ${JSON.stringify(textBuf)}`;
    rec.push(`If that string reads as SPEECH or narration, it is an event: press Start, which clears a whole sequence and cannot open the field menu if it lands late.`);
    rec.push(`If it reads as a CLASS or ITEM description, it is an info/status screen instead: press B to close it. Start will not.`);
    rec.push(`Either way this is why a tool can report "player phase" while input is still blocked — the phase byte flips before the event finishes.`);
  } else if (fcLive && changes.length > 0) {
    // Reached only after every more reliable check has missed — including the two
    // text-buffer branches above — because a populated forecast proves nothing on
    // its own: the game never clears the pair.
    verdict = `POSSIBLY an attack target selection (cursor frozen, no menu index found, no event text, forecast populated — but that gate goes stale, so treat this as a guess)`;
    rec.push(`Confirm with the screenshot before acting. If it IS target select, B backs out and A would COMMIT the attack.`);
  } else {
    verdict = `INPUT SWALLOWED — ${dir} moved neither the cursor nor any menu index (${changes.length} bytes changed), and the text buffer holds no event text`;
    rec.push(`An event, animation or level-up is holding input. Press Start — it clears a whole dialogue sequence per press, and is what fe7_wait now does on a loop.`);
    rec.push(`A LEVEL-UP is the exception: no button skips it, it runs at its own pace, and it blocks the unit's spent flag while it does — so an action can look like it never landed when it is only waiting to finish.`);
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
    // Generate the temp path HERE instead of letting the bridge default it.
    // bridge.lua falls back to Lua's os.tmpname(), which on Windows returns a
    // name relative to the CURRENT DRIVE ROOT ("\s9a4.") and so yields an
    // unwritable "C:\s9a4..png"; the write fails silently and only surfaces as
    // an ENOENT here. os.tmpdir() resolves %TEMP% on Windows and $TMPDIR on
    // macOS, so this is correct on both without branching.
    const path = join(tmpdir(), `mgba-unstick-${process.pid}-${Date.now()}.png`);
    await m.call<string>("screenshot", { path });
    const buf = await readFile(path);
    png = buf.toString("base64");
    // A mid-fade or blank frame compresses to almost nothing. Telling the caller
    // to "confirm with the screenshot" when the screenshot is a black rectangle
    // sends them to a dead end, so size it and say so.
    L.push(
      buf.length < 2000
        ? `(screenshot is only ${buf.length} bytes — that is far too small for a real 240x160 frame, so it is ` +
          `probably blank or mid-fade. Do NOT rely on it; the memory verdict above is the answer.)`
        : `(screenshot ${buf.length} bytes)`,
    );
    await unlink(path).catch(() => {});
  } catch (e) {
    L.push(`(screenshot unavailable: ${e instanceof Error ? e.message : String(e)})`);
  }
  return { text: L.join("\n"), png };
}

/**
 * Wait for the player phase to return, alternating A and Start while it hasn't.
 *
 * ALTERNATES A and Start. Start clears an event cutscene (a reinforcement arrival)
 * in a single press; A advances a dialogue box but only crawls through a cutscene
 * one box at a time. Alternating covers both without having to classify which is on
 * screen, which matters because there is no reliable memory signal separating
 * "dialogue is displayed" from "stale text sitting in the buffer".
 *
 * A Start-only version of this sat through a five and a half minute enemy-phase
 * freeze on 2026-09-08 and A was what moved the game on. **That freeze's cause is
 * UNDETERMINED** and is open work — see llm_plays_fe7/runs/2026-09-08-stall/.
 *
 * Both are safe HERE specifically: during the enemy phase the game ignores map
 * input, so neither press can select a unit or open the field menu. A passive wait
 * hangs forever on a death quote; this does not.
 *
 * This deliberately does NOT try to make the enemy phase itself run faster. The
 * only way to do that is to hold A down, and a held button during an unknown
 * number of enemy actions is exactly the kind of blind input this layer exists
 * to avoid. Slow and correct beats fast and occasionally catastrophic.
 */
/**
 * Does the map cursor actually respond to input right now?
 *
 * The one checkable test for "is anything holding input". Presses a direction
 * chosen AWAY from the map edge — a blocked edge is not a blocked game — and
 * puts the cursor straight back, so it is side-effect free on a live map.
 */
async function cursorResponds(m: MgbaClient): Promise<boolean> {
  const c0 = await readCursor(m);
  const dir = c0.y > 0 ? "Up" : "Down";
  const back = dir === "Up" ? "Down" : "Up";
  await press(m, [{ buttons: [dir], frames: 4, release_frames: 16 }]);
  await sleep(220);
  const c1 = await readCursor(m);
  const moved = c1.x !== c0.x || c1.y !== c0.y;
  if (moved) await press(m, [{ buttons: [back], frames: 4, release_frames: 16 }]);
  return moved;
}

async function awaitPlayerPhase(
  m: MgbaClient, maxMs: number,
): Promise<{ returned: boolean; phase: number; turn: number; inputFree: boolean; cleared: number; prompt?: InvPrompt }> {
  const deadline = Date.now() + maxMs;
  let beat = 0;
  const risky = await dropRisk(m);
  for (;;) {
    const b = await readRange(m, A.phase, 2);
    if (b[0] === 0x00) {
      // THE PHASE BYTE FLIPS BEFORE THE TURN IS ACTUALLY YOURS. Observed live on
      // Ch.22 turn 2: phase read 0x00 while a reinforcement cutscene ("We'll serve
      // as your reinforcements") was still on screen swallowing every input. The
      // old code tapped one B here and reported "player phase resumed", so the
      // NEXT tool call walked into blocked input and produced a confusing failure
      // of its own — the exact second-wrong-diagnosis shape the run log complains
      // about elsewhere.
      //
      // B does not clear dialogue; Start does, a whole sequence per press (one
      // press cleared that cutscene). So keep skipping until the cursor actually
      // moves, which is the only checkable definition of "the turn is yours".
      // SETTLE FIRST. The flip lands while the "Player Phase" banner is still
      // animating, and during the banner the cursor probe fails even though
      // nothing is wrong. Probing immediately turned that false negative into
      // Start/A/Up presses aimed at a map that goes live mid-sequence: A opened
      // the field menu on an empty tile, the probe's Up walked the highlight
      // End -> Suspend, and the next A suspended the game to the title screen.
      // Seen twice on Ch.20 (2026-09-12). Two and a half seconds outlasts the
      // banner; a real cutscene is still caught by the probe loop below.
      await sleep(2500);
      let cleared = 0;
      let free = await cursorResponds(m);
      while (!free && cleared < 8 && Date.now() < deadline) {
        // An inventory-full prompt is one thing that holds the turn open, and A
        // on it sends an item. Hand it back instead of pressing through it.
        const pr = await inventoryFullIfHinted(m, risky);
        if (pr) return { returned: true, phase: 0x00, turn: b[1], inputFree: false, cleared, prompt: pr };
        // Alternate here too: what is holding the turn open may be a cutscene
        // (Start) or a lingering quote box (A). Every press is followed by the
        // cursor test, so this stops the moment the map is actually yours.
        await press(m, [{ buttons: [cleared % 2 === 0 ? "Start" : "A"], frames: 4, release_frames: 16 }]);
        cleared++;
        await sleep(700);
        free = await cursorResponds(m);
      }
      // Trailing B as everywhere else: closes a minimap a late Start may have
      // opened, and is inert on a free cursor.
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 14 }]);
      const c = await readRange(m, A.phase, 2);
      return { returned: true, phase: c[0], turn: c[1], inputFree: free, cleared };
    }
    if (Date.now() >= deadline) {
      // Same trailing B as everywhere else: closes a minimap a late Start opened.
      await press(m, [{ buttons: ["B"], frames: 4, release_frames: 14 }]);
      return { returned: false, phase: b[0], turn: b[1], inputFree: false, cleared: 0 };
    }
    // A drop into a full inventory halts the enemy phase on an item list where A
    // sends the highlighted item to the convoy. Never press through it.
    const pr = await inventoryFullIfHinted(m, risky);
    if (pr) return { returned: false, phase: b[0], turn: b[1], inputFree: false, cleared: 0, prompt: pr };
    await press(m, [{ buttons: [beat++ % 2 === 0 ? "A" : "Start"], frames: 4, release_frames: 12 }]);
    await sleep(1100);
  }
}

// ── Enemy-phase attribution ────────────────────────────────────────────────
//
// The player phase is the only part of a turn you observe. Everything between
// ending your turn and getting it back is invisible, and the summary that came
// back afterwards was a bare head-count — so a unit could take 6 damage from
// something you never identified, and the only way to guess was to diff classes
// and positions by hand.
//
// Two signals make attribution possible without any new RAM research:
//   • HP deltas say WHO was hurt.
//   • WEAPON USES say who swung. An enemy that attacked has one fewer use on the
//     weapon it used, which also names the weapon — that is how a staff-carrying
//     enemy was eventually identified as the source of ranged damage.
// Neither proves a pairing, so this reports the two lists side by side and says
// so, rather than inventing an attacker for each wound.

type Snap = {
  turn: number;
  units: Map<string, { id: number; x: number; y: number; hp: number; maxHp: number; cls: number; items: string }>;
};

let lastSnap: Snap | null = null;

async function takeSnap(m: MgbaClient): Promise<Snap> {
  const [c, players, enemies, greens] = await Promise.all([
    phaseClock(m),
    readArray(m, A.playerArray),
    readArray(m, A.enemyArray),
    readArray(m, A.greenArray),
  ]);
  const units = new Map<string, { id: number; x: number; y: number; hp: number; maxHp: number; cls: number; items: string }>();
  const add = (tag: string, us: Unit[]) => {
    for (const u of us) {
      if (!u.deployed || u.dead) continue;
      units.set(`${tag}${u.slot}`, {
        id: u.charPtr,
        x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, cls: u.classId,
        items: u.items.map((i) => `${hex2(i.id)}x${i.uses}`).join(","),
      });
    }
  };
  add("P", players); add("E", enemies); add("G", greens);
  return { turn: c.turn, units };
}

/** What changed between two snapshots, as facts rather than a story. */
function diffSnap(before: Snap, after: Snap): string {
  const hurt: string[] = [], gone: string[] = [], swung: string[] = [], reused: string[] = [];
  for (const [k, b] of before.units) {
    const a = after.units.get(k);
    const side = k[0] === "P" ? "player" : k[0] === "E" ? "enemy" : "green";
    const id = `${side} #${k.slice(1)} cls${hex2(b.cls)}`;
    if (!a) { gone.push(`${id} DIED`); continue; }
    // SLOT REUSE. Array slots are recycled: a unit dies, a reinforcement takes its
    // index, and comparing the two by slot number produces fiction — an enemy that
    // "healed 22 HP", or an inventory that "changed" into something unrelated.
    // The character pointer is the identity that survives, so anything whose id
    // moved is reported as a substitution, never as a delta.
    if (a.id !== b.id) {
      reused.push(`${side} #${k.slice(1)} is now a DIFFERENT unit (was cls${hex2(b.cls)}, now cls${hex2(a.cls)}) — the slot was recycled`);
      continue;
    }
    if (a.hp !== b.hp) hurt.push(`${id} ${b.hp}->${a.hp} (${a.hp > b.hp ? "+" : ""}${a.hp - b.hp})`);
    if (a.items !== b.items) swung.push(`${id} inventory ${b.items || "-"} -> ${a.items || "-"}`);
  }
  // Slots present now that were not before: reinforcements.
  const arrived: string[] = [];
  for (const [k, a] of after.units) {
    if (!before.units.has(k)) {
      const side = k[0] === "P" ? "player" : k[0] === "E" ? "enemy" : "green";
      arrived.push(`${side} #${k.slice(1)} cls${hex2(a.cls)} at (${a.x},${a.y}) HP ${a.hp}/${a.maxHp}`);
    }
  }
  const L: string[] = [];
  if (gone.length) L.push(`  died:     ${gone.join("; ")}`);
  if (hurt.length) L.push(`  HP:       ${hurt.join("; ")}`);
  if (swung.length) L.push(`  used:     ${swung.join("; ")}`);
  if (arrived.length) L.push(`  ARRIVED:  ${arrived.join("; ")}`);
  if (reused.length) L.push(`  RECYCLED: ${reused.join("; ")}`);
  if (!L.length) return `  nothing changed on the board.`;
  L.push(`  (A dropped weapon use means that unit ACTED and names the weapon it used. HP changes and uses are ` +
    `listed separately on purpose — neither proves which attacker caused which wound.)`);
  return L.join("\n");
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

/**
 * A cheap fingerprint of everything a running enemy phase ought to be changing.
 * If this is byte-identical across a whole wait window, the phase is not slow —
 * it is not running.
 */
async function boardFingerprint(m: MgbaClient): Promise<string> {
  const [c, players, enemies, greens] = await Promise.all([
    phaseClock(m),
    readArray(m, A.playerArray),
    readArray(m, A.enemyArray),
    readArray(m, A.greenArray),
  ]);
  const f = (us: Unit[]) =>
    us.filter((u) => u.deployed && !u.dead).map((u) => `${u.slot}@${u.x},${u.y}:${u.hp}`).join("|");
  return `${c.phase}/${c.turn}//${f(players)}//${f(enemies)}//${f(greens)}`;
}

/**
 * Losing states this layer can PROVE from data it already reads.
 *
 * A run once spent 4.5 minutes calling fe7_wait three times over a chapter that
 * had already ended, with the tool cheerfully advising another wait each time —
 * while its own output said "FALLEN: #9" and then "green 0". The phase byte
 * stays 0x80 forever once the game is over, so phase polling alone can NEVER
 * terminate; something has to notice.
 *
 * DELIBERATELY NOT GUESSED: the game's own GAME OVER flag. Its address is not in
 * RAM.md, and inventing one would be exactly the kind of plausible-looking wrong
 * answer this layer exists to avoid. These are inferred signals, and they say so.
 */
async function lossSignal(m: MgbaClient, greensBefore: number): Promise<string | null> {
  const [players, greens] = await Promise.all([
    readArray(m, A.playerArray),
    readArray(m, A.greenArray),
  ]);
  const deployed = players.filter((p) => p.deployed);
  const alive = deployed.filter((p) => !p.dead);
  if (deployed.length > 0 && alive.length === 0) {
    return `every deployed player unit is dead (${deployed.length} deployed, 0 alive)`;
  }
  const greensNow = greens.filter((g) => g.deployed && !g.dead).length;
  if (greensBefore > 0 && greensNow === 0) {
    return `the green NPCs went from ${greensBefore} to 0 during this wait — and on a chapter whose objective ` +
      `is to protect one, that IS the loss condition`;
  }
  return null;
}

async function fe7Wait(m: MgbaClient, timeoutMs: number): Promise<string> {
  const pre = await readRange(m, A.phase, 2);
  if (pre[0] === 0x00) {
    // The phase flipped between fe7_end_turn's short window and this call.
    // fe7_end_turn left its pre-phase baseline in lastSnap; if that baseline
    // is from an older turn, the whole enemy phase happened unobserved and
    // this is the only call that can still report it. Seen on Ch.7x turn 4:
    // this branch used to return without the diff and the phase went missing.
    const summary = await battlefieldSummary(m);
    if (lastSnap && lastSnap.turn < pre[1]) {
      const now = await takeSnap(m);
      const changes = `\nWHAT HAPPENED WHILE YOU WERE NOT LOOKING (turn ${lastSnap.turn} -> ${now.turn}):\n${diffSnap(lastSnap, now)}`;
      lastSnap = now;
      return `Already the player phase (turn ${pre[1]}) — it came back between calls.\n${summary}${changes}`;
    }
    return `Already the player phase (turn ${pre[1]}).\n${summary}`;
  }

  const greensBefore = (await readArray(m, A.greenArray)).filter((g) => g.deployed && !g.dead).length;
  const fpBefore = await boardFingerprint(m);
  // Baseline for attribution. fe7_end_turn normally sets this from the last
  // player phase; if fe7_wait was called cold, this call's start is the best
  // baseline available and is still better than none.
  const base = lastSnap ?? (await takeSnap(m));

  const r = await awaitPlayerPhase(m, timeoutMs);
  const summary = await battlefieldSummary(m);
  if (r.prompt) {
    return `WAITING HALTED on turn ${r.turn} (${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`} phase) — the game is stuck on a prompt that needs a decision, not a button:\n${formatInvPrompt(r.prompt)}\n${summary}`;
  }
  if (r.returned) {
    const how = r.cleared ? ` (cleared ${r.cleared} event sequence${r.cleared === 1 ? "" : "s"} with Start)` : "";
    const now = await takeSnap(m);
    const changes = `\nWHAT HAPPENED WHILE YOU WERE NOT LOOKING (turn ${base.turn} -> ${now.turn}):\n${diffSnap(base, now)}`;
    lastSnap = now;
    return r.inputFree
      ? `Player phase resumed on turn ${r.turn}${how}; the cursor responds, so the turn is genuinely yours.\n${summary}${changes}`
      : `Player phase resumed on turn ${r.turn}${how}, BUT THE CURSOR STILL DOES NOT RESPOND — something is on ` +
        `screen that Start did not clear in ${r.cleared} presses. Do not issue unit actions yet: they would be ` +
        `swallowed and reported as failures. Call fe7_unstick to see what is up.\n${summary}${changes}`;
  }

  const secs = Math.round(timeoutMs / 1000);
  const loss = await lossSignal(m, greensBefore);
  if (loss) {
    return (
      `CHAPTER PROBABLY LOST — ${loss}.\n` +
      `STOP WAITING. The phase byte stays 0x${hex2(r.phase)} once the game is over, so calling fe7_wait again ` +
      `will poll forever. Call fe7_unstick and read its screenshot to confirm a GAME OVER screen.\n` +
      `(This is INFERRED from the unit arrays — the game's own game-over flag is not located in RAM.md yet, ` +
      `so treat it as a strong signal, not proof.)\n${summary}`
    );
  }

  const frozen = (await boardFingerprint(m)) === fpBefore;
  return (
    `Still ${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`} phase after ${secs}s (turn ${r.turn}). ` +
    (frozen
      ? `NOTHING ON THE BOARD CHANGED in that time — not one unit moved and no HP changed. A running enemy phase ` +
        `always moves something, so this is not slowness. Call fe7_unstick before waiting again: the likely causes ` +
        `are a finished chapter, or an event this tool's Start presses cannot clear.`
      : `Units did move, so the enemy phase IS running and just needs longer — call fe7_wait again.`) +
    `\n${summary}`
  );
}

async function fe7EndTurn(m: MgbaClient, timeoutMs: number): Promise<string> {
  const phaseB = await readRange(m, A.phase, 2);
  if (phaseB[0] !== 0x00) return `Not the player phase (0x${hex2(phaseB[0])}) — nothing to end.`;
  const startTurn = phaseB[1];
  // The baseline for "what happened during the phase you could not watch".
  // Taken here, while the board is still yours and nothing has moved.
  lastSnap = await takeSnap(m);
  const baseSnap = lastSnap;

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

  // gBmMapSize, not the movement grid. This runs with NO unit selected — that is
  // the whole point, the field menu only opens on empty ground — so the grid holds
  // whatever the previous selection left in IWRAM. End the turn without moving
  // anyone on a fresh chapter and that is the PREVIOUS chapter's geometry, which
  // would bound this search to the wrong rectangle and hunt for a tile off the map.
  const { width, height } = await readMapSize(m);
  const cur = await readCursor(m);
  let spot: { x: number; y: number } | null = null;
  for (let r = 0; r < 12 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
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
  if (r.prompt) {
    return `WAITING HALTED on turn ${r.turn} (${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`} phase) — the game is stuck on a prompt that needs a decision, not a button:\n${formatInvPrompt(r.prompt)}\n${summary}`;
  }

  if (r.returned) {
    const now = await takeSnap(m);
    const changes = `\nWHAT HAPPENED WHILE YOU WERE NOT LOOKING:\n${diffSnap(baseSnap, now)}`;
    lastSnap = now;
    return `Turn ${startTurn} -> ${r.turn}, player phase already back.\n${summary}${changes}`;
  }
  return (
    `Turn ended (phase is now ${PHASE_NAME[r.phase] ?? `0x${hex2(r.phase)}`}); the enemy phase is still running after ` +
    `${Math.round(timeoutMs / 1000)}s. This is normal on a big map — call fe7_wait to continue waiting in ` +
    `resumable chunks (it alternates A and Start, so death quotes and event cutscenes both clear).\n${summary}`
  );
}

// ── Enemy threat map ───────────────────────────────────────────────────────
//
// Every enemy's reach, computed rather than selected. The game's own grid for
// an enemy costs a cursor walk plus A/B (measured 1.5-5.1 s each, 35 s for 14
// enemies on Ch.8); this costs nothing and reproduced that grid tile-for-tile
// on 13 of 14 enemies. The one disagreement is written up in RAM.md ("Enemy
// movement range"): the fill can OVER-claim a tile at exact budget, which is
// the safe direction for a danger map. `verify` exists to check any single
// enemy against the game when a decision hangs on one tile.
//
// Move and the terrain-cost table come from the class struct in ROM. That is
// static data, the same truth a hand-typed table would hold, minus the
// transcription — and it never has to be maintained when a class is added.

interface ClassMove { move: number; cost: number[] }
const classMoveCache = new Map<number, ClassMove>();

/** Move (class+0x12) and the terrain-cost table (class+0x38, indexed by terrain id, 0xFF impassable). */
async function classMove(m: MgbaClient, classId: number): Promise<ClassMove> {
  const hit = classMoveCache.get(classId);
  if (hit) return hit;
  const ptr = CLASS_BASE + classId * CLASS_STRIDE;
  const c = await readRange(m, ptr, CLASS_STRIDE);
  const move = c[0x12];
  const tablePtr = u32(c, 0x38);
  // Cheap invariants: a real class has a small Move and a ROM cost table.
  if (move < 1 || move > 15 || tablePtr < 0x08000000 || tablePtr >= 0x0a000000) {
    throw new Error(
      `class 0x${hex2(classId)} at 0x${ptr.toString(16)} decodes to Move ${move} and cost table ` +
      `0x${tablePtr.toString(16)} — that is not a class struct; the class id or CLASS_BASE is wrong.`);
  }
  const cost = await readRange(m, tablePtr, 0x41);
  const info = { move, cost };
  classMoveCache.set(classId, info);
  return info;
}

/** Dijkstra over the terrain layer. Returns cost per tile, UNREACHABLE where the unit cannot go. */
function floodMove(
  ox: number, oy: number, cm: ClassMove, terrain: number[][], width: number, height: number, blocked: Set<string>,
): number[][] {
  const best: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(UNREACHABLE));
  best[oy][ox] = 0;
  const queue: Array<[number, number]> = [[ox, oy]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    const d = best[y][x];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (blocked.has(`${nx},${ny}`)) continue;
      const c = cm.cost[terrain[ny][nx]];
      if (c === undefined || c === UNREACHABLE) continue;
      const nd = d + c;
      if (nd > cm.move || nd >= best[ny][nx]) continue;
      best[ny][nx] = nd;
      queue.push([nx, ny]);
    }
  }
  return best;
}

/** Ranges of every weapon the unit carries and has a rank for. Staves and consumables excluded. */
async function weaponReaches(m: MgbaClient, u: Unit): Promise<Array<{ id: number; min: number; max: number }>> {
  const out: Array<{ id: number; min: number; max: number }> = [];
  for (const it of u.items) {
    const t = await itemType(m, it.id);
    if (t > 7 || t === WTYPE_STAFF) continue;
    if ((u.ranks[t] ?? 0) === 0) continue;
    out.push({ id: it.id, ...(await itemRange(m, it.id)) });
  }
  return out;
}

async function fe7Threat(m: MgbaClient, verifySlot: number | null): Promise<string> {
  const { width, height } = await readMapSize(m);
  const terrain = await readLayer(m, LAYER.terrain, width, height);
  const [players, enemies, greens] = await Promise.all([
    readArray(m, A.playerArray), readArray(m, A.enemyArray), readArray(m, A.greenArray),
  ]);
  const live = (us: Unit[]) => us.filter((u) => u.deployed && !u.dead);
  // Player and green units block an enemy's path; other enemies are pass-through.
  const blocked = new Set([...live(players), ...live(greens)].map((u) => `${u.x},${u.y}`));

  const count: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  const attackers: Map<string, number[]> = new Map();
  const perEnemy: string[] = [];
  const fills = new Map<number, number[][]>();

  for (const e of live(enemies)) {
    const cm = await classMove(m, e.classId);
    const reach = floodMove(e.x, e.y, cm, terrain, width, height, blocked);
    fills.set(e.slot, reach);
    const weapons = await weaponReaches(m, e);
    const hit = new Set<string>();
    let reachN = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (reach[y][x] === UNREACHABLE) continue;
      reachN++;
      for (const w of weapons) {
        for (let dy = -w.max; dy <= w.max; dy++) for (let dx = -w.max; dx <= w.max; dx++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist < w.min || dist > w.max) continue;
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
          hit.add(`${tx},${ty}`);
        }
      }
    }
    for (const k of hit) {
      const [tx, ty] = k.split(",").map(Number);
      count[ty][tx]++;
      (attackers.get(k) ?? attackers.set(k, []).get(k)!).push(e.slot);
    }
    perEnemy.push(
      `  E#${e.slot} cls${hex2(e.classId)} (${e.x},${e.y}) HP ${e.hp}/${e.maxHp} Move ${cm.move}: reaches ${reachN} tiles, ` +
      (weapons.length
        ? `weapons ${weapons.map((w) => `${hex2(w.id)}:${w.min}-${w.max}`).join(",")}, can attack ${hit.size} tiles`
        : `NO USABLE WEAPON — threatens nothing`),
    );
  }

  const L: string[] = [
    `THREAT — how many enemies can ATTACK each tile this enemy phase (move + weapon range), ` +
    `map ${width}x${height}, ${live(enemies).length} enemies. Computed from ROM Move/cost tables + terrain; ` +
    `see RAM.md "Enemy movement range" for the one known over-claim.`,
    `     ${Array.from({ length: width }, (_, x) => String(x % 10)).join(" ")}`,
  ];
  for (let y = 0; y < height; y++) {
    L.push(`  ${String(y).padStart(2, " ")} ` + count[y].map((n) => (n === 0 ? "." : n < 10 ? String(n) : "+")).join(" "));
  }
  L.push(`  . = no enemy can attack it   digit = number of enemies that can   + = 10 or more`);
  L.push(`  (tiles are counted whether or not something stands on them; an enemy's own tile is included)`);

  L.push("");
  L.push("YOUR UNITS:");
  for (const p of live(players)) {
    const who = attackers.get(`${p.x},${p.y}`) ?? [];
    L.push(
      `  #${p.slot} cls${hex2(p.classId)} (${p.x},${p.y}) HP ${p.hp}/${p.maxHp}: ` +
      (who.length ? `threatened by ${who.length} — ${who.map((s) => `E#${s}`).join(", ")}` : `safe`),
    );
  }
  L.push("");
  L.push("ENEMIES:");
  L.push(...perEnemy);

  if (verifySlot !== null) {
    L.push("");
    L.push(await verifyThreat(m, verifySlot, enemies, fills, width, height));
  }
  return L.join("\n");
}

/** Select one enemy with A, read the game's grid, back out with B, and diff it against the fill. */
async function verifyThreat(
  m: MgbaClient, slot: number, enemies: Unit[], fills: Map<number, number[][]>, width: number, height: number,
): Promise<string> {
  const e = bySlot(enemies, slot);
  const mine = fills.get(slot);
  if (!e || !mine || !e.deployed || e.dead) return `VERIFY E#${slot}: no live enemy in that slot — nothing selected.`;
  const phase = (await readRange(m, A.phase, 1))[0];
  if (phase !== 0x00) return `VERIFY E#${slot}: skipped — selecting a unit needs the player phase (phase is 0x${hex2(phase)}).`;

  if (!(await moveCursorTo(m, e.x, e.y))) return `VERIFY E#${slot}: the cursor would not reach (${e.x},${e.y}); nothing pressed.`;
  await press(m, [{ buttons: ["A"], frames: 4, release_frames: 8 }]);
  let grid: Grid | null = null;
  await waitUntil(async () => {
    const g = await readGrid(m);
    const o = gridOrigin(g);
    if (o && o.x === e.x && o.y === e.y) { grid = g; return true; }
    return false;
  }, 3000, 50);
  await press(m, [{ buttons: ["B"], frames: 4, release_frames: 8 }]);
  if (!grid) return `VERIFY E#${slot}: pressed A on (${e.x},${e.y}) but the movement grid never showed cost 0 there — the selection did not open. Pressed B.`;
  const g = grid as Grid;
  const diffs: string[] = [];
  let gameReach = 0, mineReach = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gv = g.rows[y]?.[x] ?? UNREACHABLE, mv = mine[y][x];
    if (gv !== UNREACHABLE) gameReach++;
    if (mv !== UNREACHABLE) mineReach++;
    if (gv !== mv) diffs.push(`(${x},${y}) game=${gv === UNREACHABLE ? "X" : gv} fill=${mv === UNREACHABLE ? "X" : mv}`);
  }
  const shown = diffs.slice(0, 12).join("; ") + (diffs.length > 12 ? `; …${diffs.length - 12} more` : "");
  return diffs.length
    ? `VERIFY E#${slot}: game grid reaches ${gameReach} tiles, fill ${mineReach}; ${diffs.length} tile(s) differ -> ${shown}. ` +
      `Trust the game's values for this enemy. (Selected with A, backed out with B; cursor left on (${e.x},${e.y}).)`
    : `VERIFY E#${slot}: game grid and fill agree on every tile (${gameReach} reachable). (Selected with A, backed out with B; cursor left on (${e.x},${e.y}).)`;
}

// ── Tool definitions ───────────────────────────────────────────────────────

export const FE7_TOOLS: Tool[] = [
  {
    name: "fe7_state",
    description:
      "PURPOSE: Read and DECODE the full Fire Emblem 7 battlefield in one call — turn, phase, cursor, and every player and enemy unit with position, HP, stats, items and has-acted status. " +
      "USAGE: Call this instead of dumping the unit arrays with mgba_read_range and decoding 72-byte structs by hand; it replaces ~5KB of hex per turn. Use `brief` for a positions-and-HP-only view when planning movement, and the full view when you need stats to predict combat. " +
      "BEHAVIOR: Pure read, no side effects and no input. Units are decoded from the player array at 0x0202BD50 and the enemy array at 0x0202CEC0, stopping at the first empty slot. Benched units (x=0xFF) and dead units (current HP 0) are excluded from the listings and summarised as counts. " +
      "RETURNS: A header line with turn/phase/cursor, then PLAYERS, ENEMIES and GREEN sections, one line per unit. Every line starts with #N, the ARRAY SLOT — the same number fe7_act's slot and target_slot take, greens included. Green lines also carry rN, the roster byte, which is NOT what any parameter wants. US release only (AGB-AE7E).",
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
    name: "fe7_threat",
    description:
      "PURPOSE: The enemy DANGER MAP in one call — for every tile, how many enemies could attack it on the coming enemy phase (movement plus weapon range), plus which enemies threaten each of your units. " +
      "USAGE: Call it every turn before deciding where to stand, and before ending the turn. A digit under a destination means that many enemies can hit it; '.' means none. The YOUR UNITS section names the attackers per unit so a lethal combination can be seen without pathing by hand. " +
      "BEHAVIOR: Pure read by default — no input, no cursor movement. Each enemy's reach is a flood fill over the game's terrain layer using its class's Move and terrain-cost table read from ROM (static per class, one cached read each), with your units and green NPCs as blockers and other enemies as pass-through; attack tiles come from the weapon ranges in the ROM item table for weapons the unit has a rank in. Checked against the game's own movement grid on Ch.8: 13 of 14 enemies matched tile-for-tile, and the one known disagreement OVER-claims a tile at exact Move, i.e. the map errs toward danger. " +
      "Pass `verify` with an enemy slot to have the tool select that enemy with A, read the game's real grid, back out with B, and print every tile where the two disagree — use it when a plan hangs on one tile. That path drives input and needs the player phase. " +
      "RETURNS: a count grid with the map's coordinates, a per-player line (safe / threatened by N — E#a, E#b), and a per-enemy line with Move, reachable-tile count, weapons with ranges, and attackable-tile count. Unit-level Move bonuses (Boots) are not read; enemies never have them.",
    inputSchema: {
      type: "object",
      properties: {
        verify: {
          type: "number",
          description: "Enemy array slot (as printed by fe7_state) to cross-check against the game's own movement grid. Drives input: cursor walk, A, B. Omit for the pure-read map.",
        },
      },
    },
  },
  {
    name: "fe7_terrain",
    description:
      "PURPOSE: Read the WHOLE board's terrain in one call — every tile's type, as an ID grid plus a named legend — from the game's own terrain array. " +
      "USAGE: This is how you answer 'where is the gate', 'where are the villages', 'which tiles are defensive' and 'what is impassable', without walking the cursor anywhere. Pass `find` with a name pattern (e.g. 'gate', 'village|house', 'fort') to get the matching tiles' coordinates listed. Call it once at the start of a chapter and again if you suspect the map changed — terrain IS mutable at runtime (a door opening, a wall breaking), so do not cache it across turns indefinitely. " +
      "BEHAVIOR: Pure read, no input, no side effects. Three reads regardless of map size. Dimensions come from gBmMapSize and the layer bases are ROM literals, so nothing is hardcoded per chapter. " +
      "RETURNS: The map's real dimensions, a grid of terrain IDs in hex, a legend naming only the IDs actually present with tile counts, and the `find` hits if a pattern was given. " +
      "NOTE: this is terrain ONLY — it says nothing about who is standing where. Cross-check occupancy against fe7_state, and remember the cost map is what decides whether a unit may STOP on a tile.",
    inputSchema: {
      type: "object",
      properties: {
        find: {
          type: "string",
          description: "Case-insensitive regex matched against terrain NAMES; matching tiles are listed with coordinates. E.g. 'gate' to locate a seize objective, 'village|house' for visitable tiles, 'fort' for healing tiles.",
        },
      },
    },
  },
  {
    name: "fe7_inspect",
    description:
      "PURPOSE: Ask the game's own renderer what is on ONE tile, by moving the cursor there and reading its on-screen readout out of memory. " +
      "USAGE: Reach for fe7_terrain FIRST. That reads the terrain array directly, returns the WHOLE board in three reads and moves no cursor, so it is how you find the gate, the villages, the forts and the impassable tiles — this tool cannot beat it at that and costs a cursor walk per tile. Use this one only for what the array cannot answer: cross-checking a terrain ID you do not trust, or reading the objective and menu text the array has no field for. Pass `tiles` to ask about several candidates in one call; never sweep a map with it. " +
      "BEHAVIOR: Drives input, but only the D-pad — it moves the cursor and reads, never presses A or B, so it cannot select, commit or change anything. Refuses unless the player phase is active, since the cursor is not free otherwise. Bounds come from gBmMapSize, the game's own stated map size, so a tile outside the map is reported OFF-MAP rather than walked to. " +
      "RETURNS: The map's real dimensions, then one line per tile with the tile the cursor ACTUALLY reached and the readout string verbatim. " +
      "IMPORTANT: the buffer is a rendering, not the terrain array — it usually holds the tile name (\"Plain.\") but also carries objective and menu text. Report the raw string; never assert a tile 'is' something the readout did not say. A unit standing on a tile MASKS its terrain in this readout; fe7_terrain reads the array and does not, so when the two disagree suspect occupancy before a decode error.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Tile x to inspect. Ignored if `tiles` is given." },
        y: { type: "number", description: "Tile y to inspect. Ignored if `tiles` is given." },
        tiles: {
          type: "array",
          description: "Several tiles to inspect in one call, in order. Each costs a cursor walk.",
          items: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
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
      "RETURNS: A cost grid (digits = move cost and a legal stop, U = ally, G = green NPC, E = enemy, . = unreachable), the unit's Move, and a count of legal destinations. " +
      "Allies and greens are pass-through — you may route through them but not stop on them. ENEMIES ARE NOT: they block pathing outright, so an enemy tile, and anything only reachable past it, is genuinely unreachable. " +
      "Refuses up front if the unit has already acted, since the game will not select a spent unit and there would be no grid to read — that is a permanent refusal until next turn, not blocked input.",
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
      "BEHAVIOR: Drives input. Refuses to act unless the phase byte is 0x00 (player phase) and the unit is deployed, alive and unspent. VALIDATES THE DESTINATION AGAINST THE GAME'S COST MAP BEFORE PRESSING ANYTHING, and refuses with a specific reason if the tile is unreachable (0xFF) or occupied — naming the enemy standing on it, or the terrain plus how far this unit's Move actually reaches, instead of guessing between causes. Capability refusals that depend only on the unit's own record (no staff, staff rank 0, no consumable) are made BEFORE it moves, so a doomed action costs no ground. Cursor movement, selection, the completed walk and the committed action are each confirmed by reading memory, with retries; a move that fails despite a legal destination is reported explicitly as a dropped input. Cancels cleanly with B on any pre-commit failure, leaving the unit UNSPENT — in particular a refused attack backs out and never substitutes a Wait, so the unit is still free to do something else. While waiting for a committed action to resolve it alternates A and Start: a boss or death quote advances only on A, an event cutscene skips whole on Start, and a level-up yields to neither and is carried by a generous timeout instead. " +
      "RETURNS: A one-line summary of the move and its outcome; for attacks, the before/after HP of every adjacent enemy plus the attacker's own HP.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "number", description: "Player array slot index (0-based) from fe7_state." },
        x: { type: "number", description: "Destination tile x. May equal the unit's current x to act without moving." },
        y: { type: "number", description: "Destination tile y." },
        action: {
          type: "string",
          enum: ["wait", "attack", "staff", "item", "seize", "visit", "door", "chest", "ride", "dismount", "status"],
          description:
            "'wait' ends the unit's turn on the destination tile, picked by wrapping the action menu UP to its last entry. That Up is MENU navigation, not a map input: it is verified by re-reading the cursor, because with no menu open it walks the map instead and the A behind it lands on the board. Commit is confirmed by the TURN CLOCK, not by the has-acted flag — if this is the last unspent unit its Wait ends the phase and the new turn clears that flag, which is success, not failure. " +
            "'attack' picks Attack and confirms against a target — pass target_slot to choose which enemy and have the choice VERIFIED before swinging. Pass weapon_slot to swing a specific inventory weapon (the Rapier instead of the equipped Iron Sword); without it the EQUIPPED weapon — inventory slot 0 — is always the one used. " +
            "'staff' heals with a staff: requires target_slot, and item_slot if the unit carries more than one staff. " +
            "'item' uses an item on the unit itself (a vulnerary); item_slot picks which, defaulting to the first. " +
            "'seize' takes a gate or throne with a lord, completing a Seize chapter. The Seize entry is located by READING the menu — each entry's struct carries a ROM pointer identifying its command — so it never presses A on an entry it cannot name. If no Seize entry exists it reports the whole menu's contents and backs out having pressed nothing. " +
            "SHALLOW TIER — 'visit', 'door', 'chest', 'ride', 'dismount', 'status'. These six are located the same way Seize is, by reading the menu for their ROM command pointer, so nothing is pressed that could not be named first. They are NEW and their outcome is UNVERIFIED: no confirm-by-effect signal is known for any of them yet, so the tool presses A and then REPORTS the before/after delta of the unit record, the turn clock and the tile's terrain rather than claiming success. Read the delta and judge; if the action worked, that delta is the missing signal and is worth a fe7_note. Each backs out to a free cursor with B whatever happens. " +
            "Only 'wait' can end the turn without an effect — the five verified actions confirm they landed and report what changed.",
        },
        target_slot: {
          type: "number",
          description:
            "Who to act on: the enemy slot for 'attack', the ally slot for 'staff'. The highlighted target is READ BACK from memory and verified before anything is confirmed, so a wrong pick fails loudly instead of hitting the wrong unit. Omit on 'attack' to take the game's default target.",
        },
        target_faction: {
          type: "string",
          enum: ["player", "green"],
          description: "Which array target_slot indexes for action='staff'. Defaults to 'player'. Green NPCs are valid staff targets — pass the slot fe7_state prints for them, the #N at the start of each GREEN line (NOT the rN roster byte on the same line).",
        },
        item_slot: {
          type: "number",
          description: "Inventory slot (0-based, as listed by fe7_state) of the staff or item to use. Defaults to the first staff for 'staff', and for 'item' to the first CONSUMABLE the unit carries — not slot 0, which is almost always a weapon. A slot holding a weapon or staff is refused by name rather than attempted.",
        },
        target_cycle: {
          type: "number",
          description: "DEPRECATED fallback for action='attack': blind Right presses to cycle targets, used only when target_slot is omitted. Prefer target_slot, which is verified.",
        },
        weapon_slot: {
          type: "number",
          description:
            "For action='attack': inventory slot (0-based, as listed by fe7_state) of the weapon to attack with. Omit to use the equipped weapon (slot 0). " +
            "Refused BEFORE the unit moves if the slot is not a weapon, the class has rank 0 in its type, or its range cannot reach the target from (x,y). " +
            "The pick is CONFIRMED BY EFFECT: the game's weapon list is walked entry by entry and the actor BattleUnit is read at target select to prove which weapon is loaded; a wrong entry is backed out with B and the next tried, and if the weapon is not offered (no target in its range) the whole attack is unwound with the unit unspent. " +
            "NOTE: choosing a weapon this way makes the game RE-EQUIP it, so the unit's inventory order changes — the result names the new order, and later slot numbers must come from a fresh fe7_state.",
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
      "RETURNS: One block with each side's damage x blows, effective hit and crit, AS, avoid and dodge, plus the projected post-battle HP — which is a deterministic every-blow-lands projection, NOT a prediction of the real fight. " +
      "Hit is printed twice: the game's displayed value and the TRUE chance in parentheses. FE7 averages two rolls per blow, so displayed 70 lands 81.7% and displayed 30 only 18.3% — plan on the true number. Crit is a single roll and is already true. " +
      "A defender the projection kills before it swings is reported as 'dies to the FIRST blow' together with the chance the attacker's first blow misses — that is the chance the counter happens at all — and the counter's own damage and true hit, so a lethal counter can be weighed rather than hidden. " +
      "A side that cannot fight — a defender with no weapon usable at this range — is reported as NO ATTACK with its numbers WITHHELD, never as zeros. The game leaves that side's hit/crit at 0xFF and never clears the pair between battles, so its block would otherwise be the previous battle's values formatted as if they were this one's (seen live: 255% hit, 255% crit, 15 blows).",
    inputSchema: {
      type: "object",
      properties: {
        slot:        { type: "number", description: "Attacking player slot from fe7_state." },
        x:           { type: "number", description: "Tile x to attack from. Use the unit's current x to forecast without moving." },
        y:           { type: "number", description: "Tile y to attack from." },
        target_slot: { type: "number", description: "Enemy slot to forecast against. Omit to take the game's default target; the unit actually selected is always reported back." },
        weapon_slot: { type: "number", description: "Inventory slot (0-based, from fe7_state) of the weapon to forecast with. Omit for the equipped weapon (slot 0). Same rules and confirm-by-effect as fe7_act's weapon_slot; the forecast header names the weapon actually loaded. Nothing is committed and the unit is unwound, BUT the game re-equips a weapon the moment it is picked from the list, so a forecast with weapon_slot DOES change the inventory order — the chosen weapon becomes slot 0 (verified: Eliwood 01,03,09 became 09,01,03 after a Rapier forecast). The result prints the new order; re-read fe7_state before trusting slot numbers again. This also means a forecast is a cheap way to EQUIP a weapon without spending the turn." },
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
    name: "fe7_inventory_full",
    description:
      "PURPOSE: Answer the 'Your inventory is full — send an item to Merlinus' (or discard) prompt that HALTS the game when a unit already holding 5 items picks up a dropped one. " +
      "USAGE: Only after fe7_act, fe7_wait, fe7_end_turn or fe7_unstick printed INVENTORY FULL PROMPT with the list of entries. Decide which item is least needed and pass its list index. The last entry is the new item; choosing it leaves the unit's inventory exactly as it was. Enemies whose kill will trigger this are marked DROPS in fe7_state. " +
      "BEHAVIOR: Drives input. Refuses, pressing nothing, unless the prompt is verified live: the text buffer names it AND a menu whose index moves is open. Moves the highlight by reading the menu's index byte, presses A once (A on an entry sends it at once, with no confirmation), then confirms by effect from the receiver's live inventory. " +
      "RETURNS: What was sent or discarded and the receiver's inventory before -> after, or why nothing was pressed.",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "0-based entry in the prompt's list as printed: entries 0-4 are the unit's current items in inventory order, the last entry is the dropped item.",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "fe7_unstick",
    description:
      "PURPOSE: Work out why the game appears frozen and say exactly what to press. Use it the moment a tool reports that nothing happened, a unit will not move, presses seem ignored, or you cannot tell what is on screen. " +
      "USAGE: Call it first when confused, before trying more presses — guessing costs presses and a wrong A can commit an action. It is safe to call at any time and changes nothing. " +
      "BEHAVIOR: Reads phase, turn, cursor, whether any unit is selected, whether an attack or staff target selection is open, and the ASCII text buffer. Then runs the input-signature probe: it presses one direction away from the map edge and sees what moved — the live cursor (input is being accepted), a menu's index byte and mirror (a menu is open, and it reports the address and entry count), or nothing (input is being swallowed by an event, dialogue, level-up or animation). It presses the opposite direction afterwards, so the probe restores whatever it moved. " +
      "The TEXT BUFFER outranks the forecast gate in the verdict: a buffer naming a chapter outcome, or holding prose rather than a tile name, decides the verdict before the stale-prone 'forecast populated' signal is consulted at all. That signal previously produced a confident 'possibly attack target selection' while the same output's buffer read \"We've won!!!\". " +
      "RETURNS: The state read, the probe result, a verdict, a concrete recommendation naming the exact button, AND a screenshot whose byte size is reported — a frame too small to be real is flagged as probably blank or mid-fade, so you are not sent to confirm against a black rectangle. Read the screenshot for WHAT is displayed — dialogue text, the objective, which portrait is up — not for game state; the memory verdict is the checkable answer.",
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
          enum: ["missing_action", "too_coarse", "workaround", "confusing", "wrong_result", "screenshot", "other"],
          description: "'missing_action' — you wanted to do something with no tool for it. 'too_coarse' — a tool exists but cannot express what you needed. 'workaround' — you got there, but awkwardly. 'confusing' — you could not tell what was happening. 'wrong_result' — a tool reported something that turned out to be false. 'screenshot' — you took an mgba_screenshot; give the saved path, the turn, why you took it and what it showed, so the PNG can be matched to the moment afterwards.",
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
      "PURPOSE: Wait for the player phase to come back, in a resumable chunk, while alternating A and Start to clear any dialogue or cutscene that would otherwise stall it forever. " +
      "USAGE: Call after fe7_end_turn reports the enemy phase is still running, and call it again as many times as needed — each call is a checkpoint that reports what it found. Also safe to call any time you suspect the game is sitting on an event and swallowing input. " +
      "BEHAVIOR: Drives input. Polls the phase byte and alternates A and Start about once a second until the player phase returns or the timeout expires. BOTH are needed and they clear different screens: Start skips an event cutscene whole, while a battle or death quote ignores Start entirely and advances only on A. Both are safe during the enemy phase because the game ignores map input then. It does not try to speed the enemy phase itself up; the only way to do that is holding A down, which is blind input this layer exists to avoid. The phase byte flips BEFORE an arrival cutscene finishes and before the Player Phase banner ends, so on the flip it first waits 2.5s for the banner to settle (probing during it once walked the field menu onto Suspend), then keeps clearing until the cursor actually responds, then taps B — which closes a minimap a late Start opened or a field menu a late A opened, and does nothing at all otherwise. " +
      "RETURNS: Whether the player phase resumed and on which turn, plus a battlefield summary naming any fallen units and listing wounded survivors. " +
      "If it times out it says WHY it is worth waiting again: it fingerprints every unit's position and HP across the window, so 'units did move, call again' and 'nothing on the board changed at all, stop and call fe7_unstick' are different answers. " +
      "It also checks two loss conditions it can prove from the unit arrays — every deployed player dead, or the greens going to zero on a protect chapter — because the phase byte never leaves 0x80 once the chapter is over, so polling alone would wait forever. The game's own game-over flag is not located yet, so that check is reported as a strong inference, not proof.",
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

    case "fe7_threat":
      return wrap(await fe7Threat(m, p.verify === undefined ? null : Number(p.verify)));

    case "fe7_terrain":
      return wrap(await fe7Terrain(m, p.find === undefined ? "" : String(p.find)));

    case "fe7_inspect": {
      const raw = Array.isArray(p.tiles) ? (p.tiles as Array<Record<string, unknown>>) : null;
      const tiles = raw
        ? raw.map((t) => ({ x: Number(t.x), y: Number(t.y) }))
        : [{ x: Number(p.x), y: Number(p.y) }];
      if (tiles.some((t) => !Number.isFinite(t.x) || !Number.isFinite(t.y))) {
        return wrap(`fe7_inspect needs x and y, or a tiles array of {x,y}.`);
      }
      return wrap(await fe7Inspect(m, tiles));
    }

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
            p.weapon_slot === undefined ? null : Number(p.weapon_slot),
          )
        ).text,
      );

    case "fe7_forecast":
      return wrap(
        await fe7Forecast(
          m, Number(p.slot), Number(p.x), Number(p.y),
          p.target_slot === undefined ? null : Number(p.target_slot),
          p.weapon_slot === undefined ? null : Number(p.weapon_slot),
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

    case "fe7_inventory_full":
      return wrap(await fe7InventoryFull(m, Number(p.index)));

    default:
      return null;
  }
}
