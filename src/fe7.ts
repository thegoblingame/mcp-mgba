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
  gridData:     0x030004ac, // movement grid row data (IWRAM)
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
const GRID_W       = 24;     // bytes per movement-grid row
const GRID_ROWS    = 27;     // rows in the buffer, including 2 top border rows
const GRID_Y_OFF   = 2;      // row index = y + 2
const MAP_H        = GRID_ROWS - GRID_Y_OFF;
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
// Row-pointer table at 0x03000440 with base 0x03000448 for y=0; data is
// contiguous at 0x030004AC, 27 rows of 24 bytes. row index = y + 2.
// Value = movement cost spent to reach the tile; 0xFF = not reachable.
//
// IMPORTANT: this is the PATHFINDING COST map. It includes tiles occupied by
// other units (you may route through allies but not stop on them), so
// `cost != 0xFF` alone is NOT a legal-destination test.

async function readGrid(m: MgbaClient): Promise<number[][]> {
  const bytes = await readRange(m, A.gridData, GRID_ROWS * GRID_W);
  const rows: number[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    const off = (y + GRID_Y_OFF) * GRID_W;
    rows.push(bytes.slice(off, off + GRID_W));
  }
  return rows;
}

function gridCost(grid: number[][], x: number, y: number): number {
  if (y < 0 || y >= grid.length || x < 0 || x >= GRID_W) return UNREACHABLE;
  return grid[y][x];
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

async function commitWait(m: MgbaClient, arrayAddr: number, slot: number, attempts = 4): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await press(m, [
      { buttons: ["Up"], frames: 4, release_frames: 14 },
      { buttons: ["A"], frames: 4, release_frames: 14 },
    ]);
    const done = await waitUntil(async () => {
      const u = await readUnit(m, arrayAddr, slot);
      return !!u && u.acted;
    }, 900);
    if (done) return true;
    // Something else opened (item list / attack targeting). Unwind and retry.
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    await sleep(120);
  }
  return false;
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

  const occMap = occupancy(
    { units: players.filter((p) => p.slot !== slot), mark: "U" },
    { units: enemies, mark: "E" },
    { units: greens, mark: "G" },
  );
  const occupied = new Map<string, string>();
  for (const [k, v] of occMap) occupied.set(k, v.mark);

  // Bound the printed map to the interesting rows so output stays compact.
  let minY = MAP_H, maxY = -1, minX = GRID_W, maxX = -1;
  const tiles: Array<{ x: number; y: number; cost: number }> = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x] !== UNREACHABLE) {
        tiles.push({ x, y, cost: grid[y][x] });
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
    const pad = (s: string) => s.padStart(2, " ");
    L.push(`     ${Array.from({ length: maxX - minX + 1 }, (_, i) => pad(String(minX + i))).join("")}`);
    for (let y = minY; y <= maxY; y++) {
      let row = "";
      for (let x = minX; x <= maxX; x++) {
        const c = grid[y][x];
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

async function fe7Act(
  m: MgbaClient,
  slot: number,
  destX: number,
  destY: number,
  action: string,
  targetCycle: number,
): Promise<ActResult> {
  const phaseB = await readRange(m, A.phase, 1);
  if (phaseB[0] !== 0x00) {
    return { text: `Refusing to act: phase byte is 0x${hex2(phaseB[0])} (${PHASE_NAME[phaseB[0]] ?? "?"}), not the player phase. Input would be swallowed.` };
  }

  const players = await readArray(m, A.playerArray);
  const enemies = await readArray(m, A.enemyArray);
  const greens = await readArray(m, A.greenArray);
  const u = bySlot(players, slot);
  if (!u) return { text: `No player unit in slot ${slot}.` };
  if (!u.deployed) return { text: `Unit #${slot} is benched.` };
  if (u.dead) return { text: `Unit #${slot} is dead.` };
  if (u.acted) return { text: `Unit #${slot} has already acted this phase (+0x0C = 0x42).` };

  const startX = u.x, startY = u.y;

  // 1. Cursor onto the unit, then select.
  if (!u.selected) {
    if (!(await moveCursorTo(m, startX, startY))) {
      return { text: `Could not drive the cursor onto unit #${slot} at (${startX},${startY}). Input appears blocked (event/animation).` };
    }
    await press(m, [{ buttons: ["A"], frames: 4, release_frames: 20 }]);
    const okSel = await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
      return !!v && v.selected;
    }, 1500);
    if (!okSel) return { text: `Selection failed: pressed A on (${startX},${startY}) but +0x0C bit 0 never set.` };
  }

  // 2. Validate the destination against the game's own cost map BEFORE pressing.
  //    This is what makes a later failure diagnosable.
  const grid = await readGrid(m);
  const cost = gridCost(grid, destX, destY);
  if (cost === UNREACHABLE) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { text: `Destination (${destX},${destY}) is NOT reachable for unit #${slot} (grid = 0xFF: out of range, or blocked terrain). Move cancelled; unit still at (${startX},${startY}) and unspent.` };
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
    return { text: `Destination (${destX},${destY}) has cost ${cost} but is OCCUPIED by a ${occ.mark} unit (slot #${occ.u.slot}, cls${hex2(occ.u.classId)}, HP ${occ.u.hp}/${occ.u.maxHp}). The cost map allows routing through units but not stopping on them. Move cancelled.` };
  }

  // 3. Drive to the destination and confirm.
  if (!(await moveCursorTo(m, destX, destY))) {
    await press(m, [{ buttons: ["B"], frames: 4, release_frames: 20 }]);
    return { text: `Could not drive the cursor to (${destX},${destY}) while unit #${slot} was selected. Move cancelled.` };
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

  if (action === "wait") {
    const committed = await commitWait(m, A.playerArray, slot);
    const v = await readUnit(m, A.playerArray, slot);
    return {
      text: committed
        ? `Unit #${slot}: (${startX},${startY}) -> (${destX},${destY}) cost ${cost}, Wait committed (+0x0C = 0x42).`
        : `Unit #${slot} MOVED to (${destX},${destY}) but Wait did not commit after retries (+0x0C = 0x${hex2((v?.flags ?? 0) & 0xff)}). The action menu is probably still open.`,
    };
  }

  if (action === "attack") {
    const adj = enemies.filter((e) => !e.dead && Math.abs(e.x - destX) + Math.abs(e.y - destY) === 1);
    if (adj.length === 0) {
      const committed = await commitWait(m, A.playerArray, slot);
      return { text: `Unit #${slot} moved to (${destX},${destY}) but no enemy is adjacent, so Attack is unavailable. ${committed ? "Waited instead." : "Wait also failed to commit."}` };
    }
    const before = adj.map((e) => ({ slot: e.slot, hp: e.hp }));

    // The attack flow has a VARIABLE number of steps:
    //   Attack -> [weapon list, only if the unit carries >1 usable weapon]
    //          -> target select -> confirm
    // Hardcoding two A presses stalled on a 3-step flow; hardcoding three
    // would overshoot on a 2-step flow and the surplus A opens the field menu
    // (observed — it left Suspend one keypress away). So advance one step at a
    // time and stop the moment the unit reports spent.
    for (let step = 0; step < 4; step++) {
      await press(m, [{ buttons: ["A"], frames: 4, release_frames: 26 }]);
      // Cycle targets once, after Attack and any weapon list are past.
      if (step === 1 && targetCycle > 0) {
        await press(m, Array.from({ length: targetCycle }, () => ({ buttons: ["Right"], frames: 4, release_frames: 12 })));
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

    // Combat + animation can run long; wait on the unit becoming spent.
    const done = await waitUntil(async () => {
      const v = await readUnit(m, A.playerArray, slot);
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
        ? `Unit #${slot} attacked from (${destX},${destY}). Enemy HP: ${deltas}. Self: HP ${self?.hp}/${self?.maxHp}, +0x0C=0x${hex2((self?.flags ?? 0) & 0xff)}.`
        : `Unit #${slot} moved to (${destX},${destY}) and Attack was chosen, but the unit never became spent within 20s. Enemy HP: ${deltas}. Something is still on screen.`,
    };
  }

  return { text: `Unknown action "${action}". Use "wait" or "attack".` };
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

  const cur = await readCursor(m);
  let spot: { x: number; y: number } | null = null;
  for (let r = 0; r < 12 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= MAP_H) continue;
        if (!taken.has(`${x},${y}`)) spot = { x, y };
      }
    }
  }
  if (!spot) return `Could not find an empty tile near the cursor to open the field menu.`;
  if (!(await moveCursorTo(m, spot.x, spot.y))) return `Could not move the cursor to empty tile (${spot.x},${spot.y}).`;

  // Field menu: 5 entries, End is LAST and indices wrap, so A/Up/A can only
  // ever reach Unit or End — never Suspend, which sits directly above End.
  for (let attempt = 0; attempt < 3; attempt++) {
    await press(m, [
      { buttons: ["A"], frames: 4, release_frames: 20 },
      { buttons: ["Up"], frames: 4, release_frames: 16 },
      { buttons: ["A"], frames: 4, release_frames: 20 },
    ]);
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
      "BEHAVIOR: Drives input — it moves the cursor onto the unit and presses A to select (which is what populates the grid), then presses B to deselect unless `keep_selected` is set. Every step is verified against memory. " +
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
          enum: ["wait", "attack"],
          description: "'wait' ends the unit's turn on the destination tile (selected via the wrap-to-last-entry trick, which is structurally safe). 'attack' picks the Attack entry and confirms against an adjacent enemy; it falls back to Wait if no enemy is adjacent.",
        },
        target_cycle: {
          type: "number",
          description: "For action='attack' with several adjacent enemies: how many times to press Right to cycle off the default target. Defaults to 0. The chosen target cannot currently be read back, so verify from the returned HP deltas.",
        },
      },
      required: ["slot", "x", "y", "action"],
    },
  },
  {
    name: "fe7_end_turn",
    description:
      "PURPOSE: End the player phase and block until the player phase comes back, so the enemy phase runs without you polling for it. " +
      "USAGE: Call once every unit you care about has acted. Saves the repeated read-and-wait loop that ending a turn otherwise requires, and guarantees the next action you take is not silently swallowed by an in-progress enemy phase. " +
      "BEHAVIOR: Drives input. Finds an empty tile near the cursor (the field menu only opens on empty ground — on a unit, A selects it instead), then uses the A/Up/A sequence, which is safe by structure: the field menu wraps and End is last, so a single Up from the top entry can only reach Unit or End, never Suspend. Retries if the phase byte does not change, then waits for the enemy and green phases to finish. " +
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
): Promise<{ content: Array<{ type: "text"; text: string }> } | null> {
  const wrap = (text: string) => ({ content: [{ type: "text" as const, text }] });

  switch (name) {
    case "fe7_state":
      return wrap(await fe7State(m, p.brief === true));

    case "fe7_reachable":
      return wrap(await fe7Reachable(m, Number(p.slot), p.keep_selected === true));

    case "fe7_act":
      return wrap(
        (await fe7Act(m, Number(p.slot), Number(p.x), Number(p.y), String(p.action), Number(p.target_cycle ?? 0))).text,
      );

    case "fe7_end_turn":
      return wrap(await fe7EndTurn(m, Number(p.timeout_ms ?? 12000)));

    case "fe7_wait":
      return wrap(await fe7Wait(m, Number(p.timeout_ms ?? 90000)));

    default:
      return null;
  }
}
