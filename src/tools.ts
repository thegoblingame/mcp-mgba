import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { MgbaClient } from "./mgba.js";

// Address-space cheat sheets (used in tool descriptions). The bridge works on
// any platform mGBA supports; users running GB/GBC ROMs need a different map.
const GBA_REGIONS = `
GBA address space:
  0x02000000  EWRAM  (256 KiB, general-purpose)
  0x03000000  IWRAM  (32 KiB, fast stack/variables)
  0x04000000  IO registers
  0x05000000  Palette RAM (1 KiB)
  0x06000000  VRAM (96 KiB)
  0x07000000  OAM (1 KiB)
  0x08000000  ROM (up to 32 MiB, read-only)

Game Boy / GBC address space (when running a GB/GBC ROM):
  0x0000      ROM bank 0 (16 KiB, read-only on bus; writes here trigger MBC commands but mgba_write* bypasses the bus)
  0x4000      ROM banked (switchable)
  0x8000      VRAM (8 KiB)
  0xA000      Cartridge SRAM (8 KiB) — disabled by default on MBC1/3/5 carts
  0xC000      WRAM (8 KiB; CGB has banked extension to 0xD000)
  0xFE00      OAM (160 B)
  0xFF00      I/O registers
  0xFF80      HRAM (127 B)`.trim();

// MBC caveat — important enough to repeat on every write tool
const MBC_CAVEAT =
  "NOTE: writes use mGBA's debug-direct memory access, which bypasses the cartridge bus model. " +
  "On Game Boy with an MBC cartridge, this means writes to ROM region (0x0000-0x7FFF) won't trigger " +
  "MBC bank-switch / RAM-enable commands, and writes to SRAM (0xA000-0xBFFF) hit the underlying buffer " +
  "regardless of MBC enable state. To seed cartridge SRAM cleanly, use mgba_save_state / mgba_load_state " +
  "with a pre-prepared state file.";

const VALID_KEYS = ["A", "B", "Select", "Start", "Right", "Left", "Up", "Down", "R", "L"];

// ──────────────────────────────────────────────────────────────────────────────
// Tool descriptions are written to the TDQS rubric (Glama's Tool Definition
// Quality Score). Each description covers, in order:
//
//   • PURPOSE — one clear action sentence.
//   • USAGE — when to use this vs sibling tools (read8 vs read16 vs read_range,
//     write* vs save/load_state, advance_frames vs unpause, slot vs path on
//     savestate I/O, etc.).
//   • BEHAVIOR — side effects, error conditions, destructive notes. Reads say
//     "no side effects — pure read." Writes say "DESTRUCTIVE: overwrites".
//     Every tool documents the failure mode it can return (unknown address,
//     oversize range, missing capability, invalid button name, slot vs path
//     conflict, etc.). MBC bypass is called out explicitly on every write.
//   • RETURNS — exact shape of the success output.
//
// Each parameter has a `description` that adds context the schema can't
// (interactions, examples, units, alignment requirements, what's lost on
// failure, capability dependencies).
//
// Address-space layout for GBA + GB/GBC is included in the read-tool
// descriptions so agents can size their addresses correctly without an
// extra round-trip to documentation.
// ──────────────────────────────────────────────────────────────────────────────

const ADDRESS_PARAM_DESC = (widthBytes: number) => {
  const align =
    widthBytes === 1
      ? ""
      : ` Should be ${widthBytes}-byte aligned (multiple of ${widthBytes}); misaligned reads on ARM-class regions can return zero or stale bus values without raising an error.`;
  const plural = widthBytes === 1 ? "" : "s";
  return (
    `System bus address. On GBA pass full 32-bit addresses (e.g. 0x02000000 for EWRAM start, ` +
    `0x03000000 for IWRAM, 0x08000000 for ROM); on GB/GBC pass 16-bit addresses (e.g. 0xC000 for WRAM, ` +
    `0xA000 for cartridge SRAM). Reads ${widthBytes} consecutive byte${plural} starting here.${align} ` +
    `Returns an error if the address is outside the platform's mapped regions or if the named bridge ` +
    `method is missing on this mGBA build (check mgba_get_info → capabilities).`
  );
};

const WRITE_ADDRESS_PARAM_DESC = (widthBytes: number) => {
  const align =
    widthBytes === 1
      ? ""
      : ` Should be ${widthBytes}-byte aligned (multiple of ${widthBytes}); misaligned writes on ARM-class regions may corrupt adjacent bytes or be silently dropped.`;
  return (
    `System bus address to overwrite. Same address-space conventions as the read tools — full 32-bit for ` +
    `GBA (EWRAM 0x02000000, IWRAM 0x03000000, ROM 0x08000000), 16-bit for GB/GBC (WRAM 0xC000, SRAM 0xA000).${align} ` +
    `Writes go through mGBA's debug-direct memory access, so they ignore MBC enable state and bus protections — ` +
    `to seed cartridge SRAM with proper hardware semantics, use mgba_save_state / mgba_load_state instead.`
  );
};

const TOOLS: Tool[] = [
  // ── Connectivity & introspection ────────────────────────────────────────

  {
    name: "mgba_ping",
    description:
      "PURPOSE: Verify that the mGBA Lua bridge is connected and responding to RPC over the TCP socket. " +
      "USAGE: Call this once at start-of-session before issuing other tool calls; if it succeeds, every other tool will at least be reachable (individual tools may still fail if the loaded mGBA build doesn't expose a particular emu method — see mgba_get_info → capabilities for that). " +
      "BEHAVIOR: No side effects — pure liveness probe. Times out after a few seconds with a clear error if mGBA isn't running, isn't pointed at the right host:port, or hasn't loaded the bridge Lua script (Tools → Scripting in mGBA). " +
      "RETURNS: The literal string 'pong' on success.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mgba_get_info",
    description:
      "PURPOSE: Get the loaded ROM's title, internal game code (e.g. 'AGBE' for GBA Pokemon Emerald US, 'BPRE' for FireRed), platform identifier (GBA vs GB/GBC), current frame count, and a `capabilities` map listing which optional emu methods this mGBA build exposes (pause, unpause, frameAdvance, saveStateSlot, saveStateFile, screenshot, etc.). " +
      "USAGE: Call after mgba_ping at the start of a session to identify the loaded ROM and feature-detect optional capabilities BEFORE invoking tools that depend on them — pause/unpause/reset/save_state/load_state/advance_frames are all build-dependent on mGBA. The platform field tells you whether to address memory using the GBA layout (32-bit, EWRAM 0x02000000) or the GB/GBC layout (16-bit, WRAM 0xC000). " +
      "BEHAVIOR: No side effects — pure read of emulator metadata. Returns '(unavailable)' for fields the loaded core can't expose (title when no ROM is loaded, code on systems without a header, etc.). Never throws on a partial read. " +
      "RETURNS: Multi-line text with Title, Code, Platform, Frame, then the lists of present and missing capabilities for this build.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "mgba_read8",
    description:
      "PURPOSE: Read an unsigned 8-bit byte from emulated memory at the given system bus address. " +
      "USAGE: Use for single-byte status flags, counters, and 8-bit fields. For 16- or 32-bit values use mgba_read16/read32 (one call instead of multi-byte assembly); for spans of more than ~4 bytes use mgba_read_range (one round-trip instead of N frame-latency hops). Reads work the same way whether emulation is paused or running, so pause is optional but recommended when you need a coherent snapshot across multiple reads. " +
      "BEHAVIOR: No side effects — pure read. Returns an error if the address is outside the platform's mapped regions or the bridge method is missing on this mGBA build. " +
      `RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x2000000: 99 (0x63)'.\n\n${GBA_REGIONS}`,
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", description: ADDRESS_PARAM_DESC(1) },
      },
    },
  },
  {
    name: "mgba_read16",
    description:
      "PURPOSE: Read an unsigned 16-bit little-endian value from emulated memory at the given system bus address. " +
      "USAGE: Use for 16-bit fields (most game-state values: HP, score, coordinates on 16-bit-flavoured layouts). For single bytes use mgba_read8; for 32-bit values use mgba_read32; for non-aligned spans, big-endian fields, or arbitrary structures use mgba_read_range and decode the bytes yourself (this tool always interprets bytes as little-endian, which matches both GBA and GB/GBC native endianness). " +
      "BEHAVIOR: No side effects — pure read. Reads two consecutive bytes (low byte at `address`, high byte at `address+1`) and combines them as little-endian. Returns an error if the address is unmapped, the read straddles a region boundary, or the bridge method is missing on this build. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", description: ADDRESS_PARAM_DESC(2) },
      },
    },
  },
  {
    name: "mgba_read32",
    description:
      "PURPOSE: Read an unsigned 32-bit little-endian value from emulated memory at the given system bus address. " +
      "USAGE: Use for 32-bit fields (timestamps, large counters, pointers on GBA, RGBA colours). For 8/16-bit reads use mgba_read8/read16; for big-endian or unaligned multi-word reads use mgba_read_range and decode yourself. " +
      "BEHAVIOR: No side effects — pure read. mGBA's native emu.read32 is intermittently flaky when called via pcall on certain builds, so the bridge transparently routes 32-bit reads through readRange(addr, 4) and reassembles them little-endian — you get a stable answer either way. Returns an error only if the address is unmapped or the underlying readRange itself fails. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", description: ADDRESS_PARAM_DESC(4) },
      },
    },
  },
  {
    name: "mgba_read_range",
    description:
      "PURPOSE: Read a contiguous range of bytes from emulated memory and return them as a hex-formatted dump. " +
      "USAGE: Use whenever you need more than ~4 bytes — one round-trip vs N frame-latency hops compared to looping mgba_read8. Maximum 4096 bytes per call (bridge serialization limit); for larger reads, batch in 4 KiB chunks. The classic two-snapshot RAM-hunt workflow uses this: snapshot before a known change, snapshot after, diff for matching deltas. Also useful for inspecting unknown structures and for 'capture, modify, restore' write_range workflows. This is the same primitive that mgba_read32 routes through internally. " +
      "BEHAVIOR: No side effects — pure read. Reads `length` consecutive bytes starting at `address`. Returns an error if length > 4096, length < 1, the start address is unmapped, or the read crosses an unmapped region. " +
      "RETURNS: Header line 'ADDR_HEX [N bytes]:' followed by space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: {
          type: "integer",
          description:
            "Starting system bus address. Same address-space conventions as the single-width read tools: full 32-bit for GBA (EWRAM 0x02000000, IWRAM 0x03000000, ROM 0x08000000), 16-bit for GB/GBC (WRAM 0xC000, SRAM 0xA000). The N bytes [address, address+length) are read.",
        },
        length: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          description:
            "Number of consecutive bytes to read (1-4096). Hard cap is the bridge's per-call serialization limit; chunk larger reads yourself. A length that pushes the read across an unmapped region boundary will fail rather than silently zero-fill.",
        },
      },
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "mgba_write8",
    description:
      "PURPOSE: Write a single unsigned byte (0-255) to emulated memory at the given system bus address. " +
      "USAGE: Use for single-byte cheats, debug pokes, and game-state mutations (give a player N lives, unlock a flag, set a counter). For 16/32-bit values prefer mgba_write16/write32 (single call instead of byte-at-a-time); for spans use mgba_write_range. To seed cart save RAM realistically (with proper MBC bank/enable behavior on Game Boy, or to install a known-good progression state on GBA), prefer mgba_save_state / mgba_load_state with a pre-prepared state file rather than poking SRAM bytes here. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites whatever was at `address` with no undo (snapshot via mgba_save_state first if you need rollback). The write is debug-direct memory access — bypasses MBC bank switches, cartridge mapper side-effects, RAM-enable gates, and bus protections — so it cannot be used to emulate cartridge hardware. Writes to ROM region addresses succeed at the memory level but produce no MBC effect on GB/GBC. Returns an error if the address is unmapped, value < 0 or > 255, or the bridge method is missing. Works whether emulation is paused or running. " +
      `RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.\n\n${MBC_CAVEAT}`,
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: WRITE_ADDRESS_PARAM_DESC(1) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description:
            "Byte value to write. Must be 0-255 (0x00-0xFF). Values outside this range return an error before the write is attempted.",
        },
      },
    },
  },
  {
    name: "mgba_write16",
    description:
      "PURPOSE: Write an unsigned 16-bit little-endian value to emulated memory at the given system bus address. " +
      "USAGE: Use for 16-bit cheats and pokes (HP, score, coordinates). For single bytes use mgba_write8; for 32-bit use mgba_write32; for big-endian fields, byteswap and use mgba_write_range; for cart save RAM seeding with proper MBC semantics, use mgba_save_state / mgba_load_state. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites two bytes (low byte at `address`, high byte at `address+1`) with no undo. Debug-direct memory write — no MBC/mapper/DMA mediation, see mgba_write8 notes for the cartridge-bus bypass details. Returns an error if the address is unmapped, address+2 crosses an unmapped boundary, value < 0 or > 65535, or the bridge method is missing. " +
      `RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.\n\n${MBC_CAVEAT}`,
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: WRITE_ADDRESS_PARAM_DESC(2) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description:
            "16-bit value to write. Must be 0-65535 (0x0000-0xFFFF). LSB is written to `address`, MSB to `address+1`. Values outside this range return an error before the write is attempted.",
        },
      },
    },
  },
  {
    name: "mgba_write32",
    description:
      "PURPOSE: Write an unsigned 32-bit little-endian value to emulated memory at the given system bus address. " +
      "USAGE: Use for 32-bit cheats and pokes (timestamps, large counters, pointers on GBA). For 8/16-bit values use mgba_write8/write16; for big-endian layouts byteswap and use mgba_write_range. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites four bytes starting at `address` with no undo (snapshot via mgba_save_state first if you need rollback). Debug-direct memory write — bypasses MBC/mapper/DMA, see mgba_write8 notes. Returns an error if the address is unmapped, address+4 crosses an unmapped boundary, value < 0, or the bridge method is missing. " +
      `RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.\n\n${MBC_CAVEAT}`,
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", description: WRITE_ADDRESS_PARAM_DESC(4) },
        value: {
          type: "integer",
          minimum: 0,
          description:
            "32-bit value to write. Must fit in unsigned 32 bits (0-4294967295, 0x00000000-0xFFFFFFFF). LSB lands at `address`, MSB at `address+3`. Negative values return an error.",
        },
      },
    },
  },
  {
    name: "mgba_write_range",
    description:
      "PURPOSE: Write a contiguous byte sequence to emulated memory starting at the given system bus address. " +
      "USAGE: Use whenever you're seeding more than ~4 bytes — one round-trip vs N frame-latency hops compared to looping mgba_write8. Maximum 4096 bytes per call (bridge serialization limit); for larger writes, batch in 4 KiB chunks. Useful for installing cheat tables, patching code blocks, restoring a captured byte window after experiments, and writing big-endian multi-byte values (byteswap them yourself first). For cart save RAM seeding with proper MBC semantics on Game Boy, use mgba_save_state / mgba_load_state instead — those go through the cartridge bus model. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites N bytes starting at `address` with no undo. Debug-direct memory write — bypasses MBC/mapper/DMA, see mgba_write8 notes for the cartridge-bus bypass details. Bytes are written sequentially address, address+1, ..., address+N-1. Returns an error if the address is unmapped, address+N crosses an unmapped boundary, the array contains a value outside 0-255, the array length is < 1 or > 4096, or the bridge method is missing. " +
      `RETURNS: Single line 'Wrote N bytes → ADDR_HEX'.\n\n${MBC_CAVEAT}`,
    inputSchema: {
      type: "object",
      required: ["address", "bytes"],
      properties: {
        address: {
          type: "integer",
          description:
            "Starting system bus address. Same address-space conventions as the single-width write tools: full 32-bit for GBA (EWRAM 0x02000000, IWRAM 0x03000000), 16-bit for GB/GBC (WRAM 0xC000, SRAM 0xA000). The N bytes [address, address+len) are written. Writes use debug-direct memory access — bypasses MBC; for cart save RAM seeding use mgba_save_state / mgba_load_state instead.",
        },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 4096,
          description:
            "Byte values to write, one per element (each 0-255). Length 1-4096 (hard cap from the bridge's serialization limit). Written sequentially from `address` in declaration order.",
        },
      },
    },
  },

  // ── Memory search & diff ────────────────────────────────────────────────

  {
    name: "mgba_search_memory",
    description:
      "PURPOSE: Scan a memory region inside the emulator for a value, raw byte pattern, or ASCII string, and return the matching addresses. " +
      "USAGE: This is the tool for LOCATING an unknown address — reach for it instead of looping mgba_read_range and eyeballing hex (a full EWRAM sweep is 64 round-trips that way, and 1 this way; the scan itself runs in Lua inside mGBA). Supply EXACTLY ONE of `value` (with `width`), `bytes`, or `text`. " +
      "For the classic narrowing workflow, pass `store_as` to keep the full result set inside the emulator, then call again with `candidates` naming that set to re-test only those addresses after the value changes on screen — repeat until the count is small enough to read: " +
      "search(value=200, region='EWRAM', width=2, store_as='gold') → 4213 hits; <spend gold in game>; search(value=150, candidates='gold', store_as='gold') → 3 hits. " +
      "When you don't know the value at all and only know that SOMETHING changed, use mgba_snapshot_memory + mgba_diff_memory instead. " +
      "BEHAVIOR: No side effects on game state — pure read (it does store a named candidate set inside the bridge when `store_as` is given, overwriting any set of the same name). The scan runs synchronously inside one mGBA frame callback, so a full 256 KiB EWRAM sweep briefly stalls emulation for roughly one frame. Chunked reads are concatenated before searching, so patterns spanning chunk boundaries are still found, and overlapping matches are reported. At most 100000 hits are retained per set (`collect_capped` flags this). Returns an error if no search term is given, more than one region form is invalid, `candidates` names an unknown set, or the region is unmapped. " +
      `RETURNS: A count, the region searched, and up to \`max_results\` matching addresses in hex; notes when the list was truncated or the retained set was capped.\n\n${GBA_REGIONS}`,
    inputSchema: {
      type: "object",
      properties: {
        value: {
          type: "integer",
          description:
            "Numeric value to find, encoded little-endian at `width` bytes (matching GBA/GB native endianness). Mutually exclusive with `bytes` and `text`. Pair with `width` — searching an 8-bit stat as the default 4-byte width will find nothing.",
        },
        width: {
          type: "integer",
          enum: [1, 2, 4],
          default: 4,
          description:
            "Byte width for `value` (1, 2, or 4; default 4). Also sets the default `align`. Use 1 for stats/counters/flags, 2 for most 16-bit game-state fields, 4 for pointers and large counters. Ignored for `bytes`/`text` searches.",
        },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          description:
            "Raw byte sequence to find, each element 0-255, matched literally in order. Mutually exclusive with `value` and `text`. Use for struct signatures and multi-field patterns (e.g. a known pair of ROM pointers).",
        },
        text: {
          type: "string",
          description:
            "ASCII string to find, matched literally. Mutually exclusive with `value` and `bytes`. Useful for player/character names and other in-RAM text, which often sit at a fixed offset inside a larger struct you're trying to locate.",
        },
        region: {
          type: "string",
          enum: ["EWRAM", "IWRAM", "PALETTE", "VRAM", "OAM", "WRAM", "SRAM", "HRAM"],
          description:
            "Named region to search, as a shorthand for address+length. GBA: EWRAM (0x02000000, 256 KiB — where most game state lives), IWRAM (0x03000000, 32 KiB), PALETTE, VRAM, OAM. GB/GBC: WRAM (0xC000), SRAM (0xA000), HRAM (0xFF80). Mutually exclusive with address+length; ignored when `candidates` is given, since a stored set carries its own region.",
        },
        address: {
          type: "integer",
          description:
            "Start address, when searching a custom span rather than a named `region`. Must be paired with `length`. Same address conventions as the read tools.",
        },
        length: {
          type: "integer",
          minimum: 1,
          description:
            "Number of bytes to search from `address` (max 16777216). Unlike mgba_read_range there is no 4096 cap here — the scan happens inside the emulator, so only the matching addresses cross the wire.",
        },
        align: {
          type: "integer",
          minimum: 1,
          description:
            "Only report matches whose ABSOLUTE address is a multiple of this. Defaults to `width` for value searches (game structs are aligned, so this typically removes ~75% of false positives on a 4-byte search) and 1 for bytes/text. Set to 1 to find unaligned matches.",
        },
        candidates: {
          type: "string",
          description:
            "Name of a previously stored candidate set to narrow instead of scanning fresh. Only the addresses in that set are re-tested against the new search term, and the set's own region is reused. This is the iterative-narrowing step — the fast way to pin down a value you can watch change on screen.",
        },
        store_as: {
          type: "string",
          description:
            "Store the FULL result set inside the bridge under this name (overwriting any existing set with the same name) so it can be narrowed later via `candidates`. The stored set is not size-limited by `max_results` — that only caps what is returned to you. Sets live until overwritten or until bridge.lua is reloaded.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          default: 64,
          description:
            "How many matching addresses to return inline (default 64). The total match count is always reported, and `store_as` retains everything — this only bounds the response size.",
        },
      },
    },
  },
  {
    name: "mgba_snapshot_memory",
    description:
      "PURPOSE: Capture a region of emulated memory into a named buffer held inside the bridge, for later comparison with mgba_diff_memory. " +
      "USAGE: Step one of the 'I don't know the value, I only know something changed' workflow — snapshot, perform the in-game action (end a turn, take damage, spend money), then mgba_diff_memory to see exactly which addresses moved. This is how you find a counter whose encoding you can't guess. Prefer this over pulling two mgba_read_range dumps and comparing them yourself: the comparison happens in-emulator, so only the changed addresses cross the wire. When you DO know the value to look for, use mgba_search_memory instead. " +
      "BEHAVIOR: No side effects on game state — pure read, plus it stores the captured bytes inside the bridge under `name` (overwriting any snapshot of the same name). Memory is held until overwritten or bridge.lua is reloaded; a full EWRAM snapshot costs 256 KiB inside mGBA. Since this build may lack pause, the capture is taken from a running emulator across several chunked reads — fine for turn-based or paused-on-a-menu states, less so mid-animation. Returns an error if the region is unmapped or exceeds 16 MiB. " +
      "RETURNS: Single line confirming the snapshot name, address and byte count.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description:
            "Identifier for this snapshot, referenced later by mgba_diff_memory (e.g. 'playstate', 'ewram'). Re-using a name overwrites the previous capture.",
        },
        region: {
          type: "string",
          enum: ["EWRAM", "IWRAM", "PALETTE", "VRAM", "OAM", "WRAM", "SRAM", "HRAM"],
          description:
            "Named region to capture, as a shorthand for address+length. EWRAM is the usual choice for a broad hunt; a narrow address+length is better when you already know the struct and want a fast, low-noise diff.",
        },
        address: {
          type: "integer",
          description: "Start address, when capturing a custom span rather than a named `region`. Must be paired with `length`.",
        },
        length: {
          type: "integer",
          minimum: 1,
          description: "Number of bytes to capture from `address` (max 16777216).",
        },
      },
    },
  },
  {
    name: "mgba_diff_memory",
    description:
      "PURPOSE: Compare a named snapshot against the current contents of the same region and report which addresses changed, with their before and after values. " +
      "USAGE: Step two of the snapshot/act/diff workflow — the fastest way to locate a value you can trigger but can't guess (turn counters, gold, HP, chapter ID, RNG state). Use `predicate` to express what you know: 'changed' when you only know it moved, 'increased'/'decreased' when you know the direction, 'equals' when you now know the exact value, 'unchanged' to narrow by exclusion. Set `width` to the field size you expect (1 for most stats and counters, 2 for gold/experience-scale values, 4 for pointers). " +
      "Pass `store_as` to save the matching addresses as a candidate set that mgba_search_memory can narrow further, and `refresh` to re-baseline the snapshot so you can immediately act again and diff again — that loop is how a broad first pass collapses to a handful of addresses. " +
      "BEHAVIOR: No side effects on game state — pure read (it does re-read the region, and optionally re-baseline the snapshot when `refresh` is set, and store a candidate set when `store_as` is set). Comparison runs in-emulator: whole 4 KiB blocks are compared first and only differing blocks are walked byte-by-byte, so a narrow diff over a large region stays cheap. At most 100000 matches are retained (`collect_capped` flags this). Returns an error if `name` is an unknown snapshot, `predicate` is unrecognised, `width` isn't 1/2/4, or 'equals' is used without `value`. " +
      "RETURNS: The region and predicate used, the total match count, and up to `max_results` entries as 'ADDR: BEFORE → AFTER' in decimal and hex.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Name of the snapshot to compare against, as passed to mgba_snapshot_memory. Unknown names return an error rather than silently comparing nothing.",
        },
        predicate: {
          type: "string",
          enum: ["changed", "unchanged", "increased", "decreased", "equals"],
          default: "changed",
          description:
            "Which addresses to report. 'changed' (default) for any difference; 'increased'/'decreased' when you know which way the on-screen value moved — far more selective than 'changed' and usually the right first filter; 'equals' to keep only addresses now holding `value`; 'unchanged' to narrow by exclusion when the value should have stayed put.",
        },
        value: {
          type: "integer",
          description: "Target value for predicate 'equals', interpreted little-endian at `width` bytes. Required for that predicate, ignored otherwise.",
        },
        width: {
          type: "integer",
          enum: [1, 2, 4],
          default: 1,
          description:
            "Byte width used to interpret both snapshots (1, 2, or 4; default 1). Also sets the default `align`. A counter stored as u8 will still be found with width 1 even if the surrounding field is wider, so start at 1 for an unknown field and widen if the deltas look like noise.",
        },
        align: {
          type: "integer",
          minimum: 1,
          description: "Only test addresses that are a multiple of this (defaults to `width`). Set to 1 to catch unaligned fields at the cost of more false positives.",
        },
        store_as: {
          type: "string",
          description:
            "Store the matching addresses inside the bridge under this name, so mgba_search_memory can narrow them later with `candidates`. Retains all matches, not just the returned ones.",
        },
        refresh: {
          type: "boolean",
          default: false,
          description:
            "Re-baseline the snapshot to the current contents after diffing, so the next diff measures from now. Set this when running the act/diff/act/diff narrowing loop; leave false to keep comparing against the original capture.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          default: 64,
          description: "How many changed addresses to return inline (default 64). The total count is always reported and `store_as` retains everything.",
        },
      },
    },
  },

  // ── Input ───────────────────────────────────────────────────────────────

  {
    name: "mgba_press_buttons",
    description:
      "PURPOSE: Append a button-press to mGBA's input FIFO — hold the given buttons for `frames` frames, then release for `release_frames` frames before the next queued press starts. " +
      "USAGE: Use to drive games with input. Each call APPENDS to the queue rather than overwriting, so consecutive calls produce distinct edge events that ROMs see as separate presses (rather than one continuous hold). To press the same button twice in a row reliably, send two presses — `release_frames` between them gives the ROM time to detect a key-up, which most input handlers require to register the second press. To advance emulation manually (without queueing inputs), use mgba_advance_frames. To inspect input-state side effects, pause first with mgba_pause and read RAM between presses. " +
      "BEHAVIOR: Modifies the bridge's input queue; the press fires asynchronously on mGBA's frame callback. The call returns immediately with the new queue size — it does NOT block until the press completes. Returns an error if `buttons` contains a name not in the valid-key set, or if the bridge's input handling isn't installed on this build. " +
      `RETURNS: Single line 'Queued press: KEYS (hold Nf, release Mf). Queue size: K'.\n\nValid button names: ${VALID_KEYS.join(", ")}.`,
    inputSchema: {
      type: "object",
      required: ["buttons"],
      properties: {
        buttons: {
          type: "array",
          items: { type: "string", enum: VALID_KEYS },
          description:
            "List of button names to hold simultaneously for this press (e.g. [\"A\"], [\"Down\", \"B\"] for a Konami-code-style combo). Names are case-sensitive. An unknown name returns an error rather than being silently ignored.",
        },
        frames: {
          type: "integer",
          minimum: 1,
          default: 1,
          description:
            "Number of frames to hold the buttons down (at 60 fps; default 1). For a normal menu-confirm tap, 2-4 is usually plenty; for held-direction movement on slower games, increase as needed.",
        },
        release_frames: {
          type: "integer",
          minimum: 1,
          default: 1,
          description:
            "Number of frames to release ALL keys after the hold, before the next queued press fires (default 1). Increase to 2-4 if a ROM debounces input and misses back-to-back presses; this gap is what lets the ROM see two distinct edge events instead of one long hold.",
        },
      },
    },
  },

  {
    name: "mgba_press_sequence",
    description:
      "PURPOSE: Queue an entire ordered sequence of button presses in a single call, and by default wait until the whole sequence has finished executing before returning. " +
      "USAGE: Prefer this over repeated mgba_press_buttons calls for ANY multi-press action — menu navigation, dialogue advancement, movement paths, combos. Each press via mgba_press_buttons costs a full round-trip, so an 8-press menu sequence takes seconds of real time and the emulator sits idle between presses; here the whole sequence costs one round-trip and executes back-to-back at frame cadence. " +
      "Entries are either a bare button name for the common single-button case ([\"A\",\"Right\",\"Up\",\"Up\",\"A\"]) or an object for combos and per-step timing ({\"buttons\":[\"Down\",\"B\"],\"frames\":4}); the two forms can be mixed in one sequence. Set `frames`/`release_frames` at the top level to change the default timing for every entry. " +
      "Because it waits for completion by default, a following mgba_screenshot or memory read is guaranteed to observe the post-sequence state rather than catching the ROM mid-sequence — set `wait` false only for fire-and-forget input. " +
      "BEHAVIOR: Modifies the bridge's input queue; presses fire on mGBA's frame callback in the order given. The ENTIRE sequence is validated before anything is queued, so an invalid button name at step 7 leaves the emulator untouched rather than half-executing steps 1-6. With `wait` true (default) the call polls the bridge until the queue drains, then returns; if the timeout expires first it returns normally and reports how many presses are still pending (the usual cause is paused emulation — the frame callback isn't running, so the queue can't drain). Note that presses already queued by earlier calls execute first, and their frames count toward the drain. Returns an error for an unknown button name, an empty sequence, more than 256 entries, or frames/release_frames below 1. " +
      `RETURNS: Single line reporting the number of presses executed (or queued) and the total emulator frames consumed.\n\nValid button names: ${VALID_KEYS.join(", ")}.`,
    inputSchema: {
      type: "object",
      required: ["presses"],
      properties: {
        presses: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: {
            oneOf: [
              { type: "string", enum: VALID_KEYS, description: "A single button pressed on its own, using the sequence-level default timing." },
              {
                type: "object",
                required: ["buttons"],
                properties: {
                  buttons: {
                    type: "array",
                    items: { type: "string", enum: VALID_KEYS },
                    minItems: 1,
                    description: "Buttons held SIMULTANEOUSLY for this one press (e.g. [\"Down\",\"B\"]). Case-sensitive; an unknown name aborts the whole sequence before anything is queued.",
                  },
                  frames: {
                    type: "integer",
                    minimum: 1,
                    description: "Frames to hold this press, overriding the sequence default. Raise for a ROM that misses short taps during menu animations or text scroll.",
                  },
                  release_frames: {
                    type: "integer",
                    minimum: 1,
                    description: "Frames to release all keys after this press, overriding the sequence default.",
                  },
                },
              },
            ],
          },
          description:
            "Ordered list of presses, executed front to back. Mix bare button names (single-button presses) with objects (combos or custom timing) freely — e.g. [\"A\",\"Right\",{\"buttons\":[\"Down\",\"B\"],\"frames\":4},\"A\"]. Repeating the same name produces distinct presses, not one long hold, because release frames separate them.",
        },
        frames: {
          type: "integer",
          minimum: 1,
          default: 1,
          description:
            "Default frames to hold each press, for entries that don't set their own (default 1). 2-4 is a safe menu-confirm tap; a 1-frame press can be missed by a ROM that skips input polling during animations or transitions.",
        },
        release_frames: {
          type: "integer",
          minimum: 1,
          default: 1,
          description:
            "Default frames to release all keys between presses, for entries that don't set their own (default 1). This gap is what makes consecutive presses of the SAME button register as separate events; raise it to 2-4 for a ROM that debounces input.",
        },
        wait: {
          type: "boolean",
          default: true,
          description:
            "Wait for the queue to fully drain before returning (default true), so subsequent screenshots and memory reads see the finished state. Set false to return as soon as the sequence is queued — useful only when you intend to do other work while input plays out.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum milliseconds to wait when `wait` is true. Defaults to a generous allowance derived from the sequence length (roughly 50ms per frame plus 2s). On timeout the call still succeeds and reports the number of presses left pending rather than throwing.",
        },
      },
    },
  },

  // ── Emulator control ───────────────────────────────────────────────────

  {
    name: "mgba_advance_frames",
    description:
      "PURPOSE: Step emulation by exactly N frames synchronously and return the new frame count. " +
      "USAGE: Use for frame-precise input automation (combine with mgba_press_buttons to time inputs against in-game animation), letting the system initialize after a hard reset (RAM is mostly zero in the first ~30 frames after mgba_reset), or settling state between memory reads. For long jumps (thousands of frames) prefer mgba_save_state / mgba_load_state of a pre-prepared state — advance_frames scales linearly. To resume real-time playback indefinitely instead of stepping, use mgba_unpause. Works whether emulation is currently paused or running and does NOT change the pause state. " +
      "BEHAVIOR: Advances mGBA's frame clock by N frames inside the bridge's frame callback. Each step costs roughly one real frame (~16ms at 60Hz GBA / ~16.7ms at 60Hz GB) plus one bridge round-trip — so advancing 600 frames takes ~10 seconds wall-clock. This method is build-dependent on mGBA; check `capabilities.frameAdvance` in mgba_get_info first. Returns an error if the capability is missing on this build. " +
      "RETURNS: Single line 'Advanced N frame(s). Current frame: NEW_COUNT'.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 1,
          default: 1,
          description:
            "Number of frames to advance (≥1, default 1). Latency scales linearly: ~16ms per frame at 60Hz. New frame count = previous frame count + count.",
        },
      },
    },
  },
  {
    name: "mgba_pause",
    description:
      "PURPOSE: Pause emulation — freeze the game-logic clock and hold the current frame on screen. " +
      "USAGE: Use before a sequence of memory-inspect / write / screenshot calls when you need a stable game state across calls (so the game doesn't advance between your reads). Use mgba_unpause to resume; use mgba_advance_frames to step single frames without leaving pause. Memory reads and writes work the same way whether paused or not, so pause is only required when you specifically need a coherent snapshot — for one-shot reads it's optional. " +
      "BEHAVIOR: Modifies emulator run state. The Lua bridge keeps polling the socket while paused, so all other tool calls (memory r/w, screenshot, save_state, etc.) still work. This method is build-dependent on mGBA; check `capabilities.pause` in mgba_get_info first to handle missing capability gracefully. Returns an error if the capability is missing on this build. Calling pause when already paused is a no-op. " +
      "RETURNS: Single line 'Emulation paused'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mgba_unpause",
    description:
      "PURPOSE: Resume emulation after a pause, returning to normal real-time playback. " +
      "USAGE: Counterpart to mgba_pause. Use after a paused inspection sequence is complete. To advance only a few frames without resuming full speed, use mgba_advance_frames instead. " +
      "BEHAVIOR: Modifies emulator run state. This method is build-dependent on mGBA; check `capabilities.unpause` in mgba_get_info first. Returns an error if the capability is missing on this build. Calling unpause when not paused is a no-op. " +
      "RETURNS: Single line 'Emulation resumed'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mgba_reset",
    description:
      "PURPOSE: Reset the loaded ROM — equivalent to pressing the reset button on the GBA / Game Boy. " +
      "USAGE: Use to start fresh from boot. To return to a specific known-good point instead of boot, use mgba_load_state with a previously saved slot or .ss0/.ss1/etc state file. " +
      "BEHAVIOR: DESTRUCTIVE: RAM contents become indeterminate (typically the BIOS-zeroed state), CPU returns to the reset vector, frame count resets to 0, input queue clears, and any in-progress audio/video state is discarded. The loaded ROM stays loaded — only volatile state is cleared. UNSAVED IN-GAME PROGRESS IS LOST (anything not committed to cartridge SRAM via the game's save menu, and anything not snapshotted via mgba_save_state). This method is build-dependent on mGBA; check `capabilities.reset` in mgba_get_info first. Returns an error if the capability is missing on this build. " +
      "RETURNS: Single line 'ROM reset'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mgba_screenshot",
    description:
      "PURPOSE: Save a PNG screenshot of the current emulator display. " +
      "USAGE: For visual inspection or sequence documentation. To capture a specific frame, pause / advance / load_state first. For full machine state (RAM, registers, mapper) use mgba_save_state instead — screenshots are pixels only, not state. " +
      "BEHAVIOR: DESTRUCTIVE to `path` if supplied (overwrites without prompt). Errors if `path`'s parent doesn't exist or isn't writable, or if the build doesn't expose screenshot. " +
      "RETURNS: 'Screenshot saved: PATH' — the path you passed, or mGBA's default-directory filename if `path` was omitted.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional absolute PNG path (e.g. C:/temp/snap.png, /tmp/snap.png). Parent must exist; file is overwritten without prompt. Omit to let mGBA choose a filename in its default screenshot directory and return that path.",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "mgba_save_state",
    description:
      "PURPOSE: Save the entire emulator state (RAM, CPU/PPU/APU registers, mapper state, sound chip state, timing, in-flight DMA) to either an mGBA-managed numbered slot OR an arbitrary file path. " +
      "USAGE: Use as a rollback point before risky writes, to bookmark interesting game states, to share repro states, or — on Game Boy — to seed cartridge SRAM cleanly without fighting MBC bus semantics that mgba_write* would bypass. EXACTLY ONE of `slot` or `path` must be supplied (passing both, or neither, returns an error). Slots 0-9 are managed by mGBA in its data directory and are ideal for ad-hoc rollback during a session; explicit paths are better for long-term storage and sharing across sessions/machines. The companion mgba_load_state restores from either form. " +
      "BEHAVIOR: When `path` is supplied, DESTRUCTIVE TO TARGET FILE: overwrites the file at `path` if it exists, with no prompt or backup. When `slot` is supplied, DESTRUCTIVE TO THE NAMED SLOT: overwrites whatever was previously stored in that slot. The state is bound to the EXACT ROM and a compatible mGBA version that produced it — loading it on a different ROM or an incompatible mGBA version typically produces a corrupt run or a hard error. Returns an error if neither `slot` nor `path` is supplied, the path's parent directory doesn't exist, the path isn't writable, the slot is out of range, or the relevant bridge save-state method (saveStateSlot vs saveStateFile) is missing on this build (check `capabilities` in mgba_get_info). " +
      "RETURNS: Single line 'Saved state to PATH' or 'Saved state to slot N' depending on which form you used.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "integer",
          minimum: 0,
          maximum: 9,
          description:
            "Save state slot number (0-9). Slot files are managed by mGBA in its data directory. Mutually exclusive with `path` — supply exactly one. Out-of-range slot numbers return an error.",
        },
        path: {
          type: "string",
          description:
            "Absolute filesystem path to write the state to (e.g. C:/temp/checkpoint.ss0 on Windows, /tmp/checkpoint.ss0 on Linux/macOS). Mutually exclusive with `slot` — supply exactly one. Parent directory must exist; file is overwritten without prompt if present. Only works on mGBA builds that expose the saveStateFile capability.",
        },
      },
    },
  },
  {
    name: "mgba_load_state",
    description:
      "PURPOSE: Restore the emulator from a previously saved slot or .ss state file. " +
      "USAGE: Counterpart to mgba_save_state. Use to undo a sequence of writes/inputs (the snapshot/experiment/restore workflow), to jump to a bookmarked game state, or to start each tool-call sequence from a known baseline. EXACTLY ONE of `slot` or `path` must be supplied (passing both, or neither, returns an error). To start fresh from console boot instead of a snapshot, use mgba_reset. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state (RAM, registers, mapper, audio, frame count, in-flight DMA) with the snapshot's contents. Anything not previously snapshotted is lost (unsaved in-game progress, queued button presses, paused state). The state file/slot MUST come from the same ROM and a compatible mGBA version that produced it — loading mismatched data typically produces a corrupt run or a hard error. Returns an error if neither `slot` nor `path` is supplied, the file doesn't exist or isn't a valid mGBA state, the slot is empty or out of range, or the relevant bridge load-state method (loadStateSlot vs loadStateFile) is missing on this build (check `capabilities` in mgba_get_info). " +
      "RETURNS: Single line 'Loaded state from PATH' or 'Loaded state from slot N' depending on which form you used.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "integer",
          minimum: 0,
          maximum: 9,
          description:
            "Save state slot number (0-9) to load. Mutually exclusive with `path` — supply exactly one. Loading an empty slot returns an error. Out-of-range slot numbers return an error.",
        },
        path: {
          type: "string",
          description:
            "Absolute filesystem path to an existing .ss state file produced by mgba_save_state (or mGBA's UI) on this same ROM and a compatible mGBA version. Mutually exclusive with `slot` — supply exactly one. Loading mismatched files typically produces a corrupt run or a hard error. Only works on mGBA builds that expose the loadStateFile capability.",
        },
      },
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatHex(n: unknown): string {
  if (typeof n !== "number") return String(n);
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}

function hexAddr(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

// Poll the bridge until every queued press has fired. The bridge answers once
// per frame callback, so a ~16ms poll interval matches its natural cadence.
// Returns the number of presses still pending (0 on a clean drain) rather than
// throwing on timeout — a stalled queue almost always means paused emulation,
// which is worth reporting plainly instead of as an error.
async function waitForInputDrain(mgba: MgbaClient, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await mgba.call<{ pending: number }>("input_status");
    if (s.pending === 0) return 0;
    if (Date.now() >= deadline) return s.pending;
    await new Promise((r) => setTimeout(r, 16));
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerTools(server: Server, mgba: MgbaClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;

    switch (name) {
      case "mgba_ping": {
        const r = await mgba.call<string>("ping");
        return ok(r);
      }

      case "mgba_get_info": {
        const r = await mgba.call<{
          title?: string;
          code?: string;
          frame?: number;
          platform?: number | string;
          capabilities?: Record<string, boolean>;
        }>("get_info");
        const lines = [
          `Title:    ${r.title ?? "(unavailable)"}`,
          `Code:     ${r.code ?? "(unavailable)"}`,
          `Platform: ${r.platform ?? "(unavailable)"}`,
          `Frame:    ${r.frame ?? "(unavailable)"}`,
        ];
        if (r.capabilities) {
          const present = Object.entries(r.capabilities).filter(([, v]) => v).map(([k]) => k);
          const missing = Object.entries(r.capabilities).filter(([, v]) => !v).map(([k]) => k);
          lines.push("");
          lines.push(`Capabilities present: ${present.length ? present.join(", ") : "(none)"}`);
          if (missing.length) lines.push(`Missing on this build: ${missing.join(", ")}`);
        }
        return ok(lines.join("\n"));
      }

      case "mgba_read8": {
        const v = await mgba.call<number>("read8", { address: p.address });
        return ok(`0x${(p.address as number).toString(16).toUpperCase()}: ${formatHex(v)}`);
      }

      case "mgba_read16": {
        const v = await mgba.call<number>("read16", { address: p.address });
        return ok(`0x${(p.address as number).toString(16).toUpperCase()}: ${formatHex(v)}`);
      }

      case "mgba_read32": {
        const v = await mgba.call<number>("read32", { address: p.address });
        return ok(`0x${(p.address as number).toString(16).toUpperCase()}: ${formatHex(v)}`);
      }

      case "mgba_write8": {
        await mgba.call("write8", { address: p.address, value: p.value });
        return ok(`Wrote ${formatHex(p.value)} → 0x${(p.address as number).toString(16).toUpperCase()}`);
      }

      case "mgba_write16": {
        await mgba.call("write16", { address: p.address, value: p.value });
        return ok(`Wrote ${formatHex(p.value)} → 0x${(p.address as number).toString(16).toUpperCase()}`);
      }

      case "mgba_write32": {
        await mgba.call("write32", { address: p.address, value: p.value });
        return ok(`Wrote ${formatHex(p.value)} → 0x${(p.address as number).toString(16).toUpperCase()}`);
      }

      case "mgba_read_range": {
        const bytes = await mgba.call<number[]>("read_range", {
          address: p.address,
          length:  p.length,
        });
        const hex = bytes
          .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
          .join(" ");
        const addr = (p.address as number).toString(16).toUpperCase();
        return ok(`0x${addr} [${bytes.length} bytes]:\n${hex}`);
      }

      case "mgba_write_range": {
        const r = await mgba.call<{ written: number }>("write_range", {
          address: p.address,
          bytes:   p.bytes,
        });
        const addr = (p.address as number).toString(16).toUpperCase();
        return ok(`Wrote ${r.written} bytes → 0x${addr}`);
      }

      case "mgba_press_buttons": {
        const r = await mgba.call<{ queued: boolean; queue_size: number }>("press_buttons", {
          buttons:        p.buttons,
          frames:         p.frames         ?? 1,
          release_frames: p.release_frames ?? 1,
        });
        const keys = (p.buttons as string[]).join("+");
        return ok(
          `Queued press: ${keys} ` +
          `(hold ${p.frames ?? 1}f, release ${p.release_frames ?? 1}f). ` +
          `Queue size: ${r.queue_size}`,
        );
      }

      case "mgba_search_memory": {
        const r = await mgba.call<{
          count: number;
          shown: number[];
          truncated: boolean;
          collect_capped: boolean;
          stored_as?: string;
          address: number;
          length: number;
        }>("search_memory", {
          ...(p.value       !== undefined ? { value:       p.value }       : {}),
          ...(p.width       !== undefined ? { width:       p.width }       : {}),
          ...(p.bytes       !== undefined ? { bytes:       p.bytes }       : {}),
          ...(p.text        !== undefined ? { text:        p.text }        : {}),
          ...(p.region      !== undefined ? { region:      p.region }      : {}),
          ...(p.address     !== undefined ? { address:     p.address }     : {}),
          ...(p.length      !== undefined ? { length:      p.length }      : {}),
          ...(p.align       !== undefined ? { align:       p.align }       : {}),
          ...(p.candidates  !== undefined ? { candidates:  p.candidates }  : {}),
          ...(p.store_as    !== undefined ? { store_as:    p.store_as }    : {}),
          ...(p.max_results !== undefined ? { max_results: p.max_results } : {}),
        });

        const term =
          p.text !== undefined  ? `text ${JSON.stringify(p.text)}` :
          p.bytes !== undefined ? `${(p.bytes as number[]).length} byte pattern` :
          `${formatHex(p.value)} @ ${p.width ?? 4}-byte`;
        const scope = p.candidates
          ? `candidate set "${p.candidates}"`
          : `${p.region ?? hexAddr(r.address)} [${r.length} bytes]`;

        const lines = [`Searched ${scope} for ${term} — ${r.count} match(es).`];
        if (r.stored_as) lines.push(`Stored as "${r.stored_as}" (full set, narrow it with candidates="${r.stored_as}").`);
        if (r.count > 0) lines.push(r.shown.map(hexAddr).join("  "));
        if (r.truncated) lines.push(`(showing first ${r.shown.length} of ${r.count})`);
        if (r.collect_capped) lines.push("WARNING: hit the 100000-match retention cap — narrow the region or widen the search term.");
        return ok(lines.join("\n"));
      }

      case "mgba_snapshot_memory": {
        const r = await mgba.call<{ name: string; address: number; length: number }>("snapshot_memory", {
          name: p.name,
          ...(p.region  !== undefined ? { region:  p.region }  : {}),
          ...(p.address !== undefined ? { address: p.address } : {}),
          ...(p.length  !== undefined ? { length:  p.length }  : {}),
        });
        return ok(`Snapshot "${r.name}": ${r.length} bytes at ${hexAddr(r.address)}`);
      }

      case "mgba_diff_memory": {
        const r = await mgba.call<{
          name: string;
          address: number;
          length: number;
          predicate: string;
          width: number;
          count: number;
          changes: { address: number; before: number; after: number }[];
          truncated: boolean;
          collect_capped: boolean;
          stored_as?: string;
          refreshed: boolean;
        }>("diff_memory", {
          name: p.name,
          ...(p.predicate   !== undefined ? { predicate:   p.predicate }   : {}),
          ...(p.value       !== undefined ? { value:       p.value }       : {}),
          ...(p.width       !== undefined ? { width:       p.width }       : {}),
          ...(p.align       !== undefined ? { align:       p.align }       : {}),
          ...(p.store_as    !== undefined ? { store_as:    p.store_as }    : {}),
          ...(p.refresh     !== undefined ? { refresh:     p.refresh }     : {}),
          ...(p.max_results !== undefined ? { max_results: p.max_results } : {}),
        });

        const lines = [
          `Diff "${r.name}" ${hexAddr(r.address)} [${r.length} bytes] ` +
          `predicate=${r.predicate} width=${r.width} — ${r.count} match(es).`,
        ];
        if (r.stored_as) lines.push(`Stored as "${r.stored_as}".`);
        if (r.refreshed) lines.push("Snapshot re-baselined to current contents.");
        for (const c of r.changes) {
          lines.push(`  ${hexAddr(c.address)}: ${formatHex(c.before)} → ${formatHex(c.after)}`);
        }
        if (r.truncated) lines.push(`(showing first ${r.changes.length} of ${r.count})`);
        if (r.collect_capped) lines.push("WARNING: hit the 100000-match retention cap — narrow the region or use a more selective predicate.");
        return ok(lines.join("\n"));
      }

      case "mgba_press_sequence": {
        const r = await mgba.call<{ queued: number; queue_size: number; frames: number }>("press_sequence", {
          presses: p.presses,
          ...(p.frames         !== undefined ? { frames:         p.frames }         : {}),
          ...(p.release_frames !== undefined ? { release_frames: p.release_frames } : {}),
        });

        if (p.wait === false) {
          return ok(`Queued ${r.queued} press(es), ${r.frames} frames. Queue size: ${r.queue_size}`);
        }

        const timeout = (p.timeout_ms as number | undefined) ?? r.frames * 50 + 2000;
        const pending = await waitForInputDrain(mgba, timeout);
        if (pending > 0) {
          return ok(
            `Queued ${r.queued} press(es), ${r.frames} frames — but ${pending} still pending after ${timeout}ms. ` +
            `Is emulation paused? The queue only drains while frames are running.`,
          );
        }
        return ok(`Executed ${r.queued} press(es) over ${r.frames} frames.`);
      }

      case "mgba_advance_frames": {
        const frame = await mgba.call<number>("advance_frames", { count: p.count ?? 1 });
        return ok(`Advanced ${p.count ?? 1} frame(s). Current frame: ${frame}`);
      }

      case "mgba_pause": {
        await mgba.call("pause");
        return ok("Emulation paused");
      }

      case "mgba_unpause": {
        await mgba.call("unpause");
        return ok("Emulation resumed");
      }

      case "mgba_reset": {
        await mgba.call("reset");
        return ok("ROM reset");
      }

      case "mgba_screenshot": {
        const path = await mgba.call<string>("screenshot", p.path ? { path: p.path } : {});
        return ok(`Screenshot saved: ${path}`);
      }

      case "mgba_save_state": {
        if (p.slot === undefined && p.path === undefined) {
          throw new Error("provide either `slot` (0-9) or `path`");
        }
        const r = await mgba.call<{ slot?: number; path?: string }>("save_state", {
          ...(p.slot !== undefined ? { slot: p.slot } : {}),
          ...(p.path !== undefined ? { path: p.path } : {}),
        });
        return ok(r.path ? `Saved state to ${r.path}` : `Saved state to slot ${r.slot}`);
      }

      case "mgba_load_state": {
        if (p.slot === undefined && p.path === undefined) {
          throw new Error("provide either `slot` (0-9) or `path`");
        }
        const r = await mgba.call<{ slot?: number; path?: string }>("load_state", {
          ...(p.slot !== undefined ? { slot: p.slot } : {}),
          ...(p.path !== undefined ? { path: p.path } : {}),
        });
        return ok(r.path ? `Loaded state from ${r.path}` : `Loaded state from slot ${r.slot}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}
