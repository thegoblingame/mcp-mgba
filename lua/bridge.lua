-- bridge.lua: mGBA scripting bridge for mcp-mgba
--
-- Exposes a newline-delimited JSON-RPC server on 127.0.0.1:8765.
-- Load via mGBA: Tools > Scripting... > Open Script (select this file).
--
-- json.lua must live in the same folder as this file.
-- socket is a pre-registered global in mGBA's Lua environment.
--
-- mGBA socket API (discovered via metatable probe):
--   bind, listen, accept, connect, send, receive, hasdata, poll, _hook
--
-- Requires mGBA >= 0.10.

local json = require("json")

local HOST = "127.0.0.1"
local PORT = 8765

-- ── Key name → bitmask bit index ────────────────────────────────────────────
-- The same map covers GBA and GB/GBC: mGBA's setKeys uses platform-appropriate
-- bits, ignoring keys that don't apply (e.g. R/L on DMG). Names match the
-- convention used elsewhere in mGBA scripting.
local KEY_BIT = {
    A = 0, B = 1, Select = 2, Start = 3,
    Right = 4, Left = 5, Up = 6, Down = 7,
    R = 8, L = 9,
}

-- ── Capability detection (deferred until first frame) ──────────────────────
-- The `emu` global only exists once a ROM is loaded; probing it at script-load
-- time crashes when mGBA is sitting on a blank screen. We defer detection to
-- the first frame callback (which only fires once a ROM is running) and cache
-- the result.
local CAPS              -- nil until detected
local advance_one       -- nil until detected; resolves to a function

local function detect_caps()
    local function has(name) return type(emu[name]) == "function" end
    CAPS = {
        pause          = has("pause"),
        unpause        = has("unpause"),
        frameAdvance   = has("frameAdvance"),
        runFrame       = has("runFrame"),       -- alternative name on some builds
        step           = has("step"),           -- alternative name on some builds
        reset          = has("reset"),
        screenshot     = has("screenshot"),
        setKeys        = has("setKeys"),
        saveStateSlot  = has("saveStateSlot"),
        loadStateSlot  = has("loadStateSlot"),
        saveStateFile  = has("saveStateFile"),
        loadStateFile  = has("loadStateFile"),
        readRange      = has("readRange"),
        getGameTitle   = has("getGameTitle"),
        getGameCode    = has("getGameCode"),
        currentFrame   = has("currentFrame"),
        platform       = has("platform"),
    }
    if     CAPS.frameAdvance then advance_one = function() emu:frameAdvance() end
    elseif CAPS.runFrame     then advance_one = function() emu:runFrame()    end
    elseif CAPS.step         then advance_one = function() emu:step()        end
    end
    -- Log what we found (or didn't) once.
    local missing = {}
    for k, v in pairs(CAPS) do if not v then table.insert(missing, k) end end
    if #missing == 0 then
        console:log("[mcp-mgba] all known emu methods present")
    else
        table.sort(missing)
        console:log("[mcp-mgba] missing emu methods: " .. table.concat(missing, ", "))
    end
end

-- Cap-guarded helper for handlers — ensures CAPS is populated and the named
-- method exists before the handler tries to use it.
local function require_cap(name)
    if not CAPS then error("no ROM loaded — capabilities not yet detected") end
    if not CAPS[name] then error("emu:" .. name .. " not available on this mGBA build") end
end

-- ── Press-button queue ──────────────────────────────────────────────────────
-- Each record describes one keypress: hold for `hold` frames, then release
-- for `release` frames (so consecutive presses of the same button generate
-- distinct edges that ROMs see as separate events). Records are pulled FIFO.
local press_queue = {}
local active                   -- { bits, hold_remaining, release_remaining }

-- ── Command handlers ────────────────────────────────────────────────────────

local function cmd_ping() return "pong" end

local function cmd_get_info()
    if not CAPS then return { rom_loaded = false } end
    return {
        rom_loaded   = true,
        title        = CAPS.getGameTitle and emu:getGameTitle() or nil,
        code         = CAPS.getGameCode  and emu:getGameCode()  or nil,
        frame        = CAPS.currentFrame and emu:currentFrame() or nil,
        platform     = CAPS.platform     and emu:platform()     or nil,
        capabilities = CAPS,
    }
end

-- emu:read8/16/32 are flaky when called repeatedly via pcall from the frame
-- callback ("invoking failed" intermittently). emu:readRange is reliable, so
-- we route the typed reads through it and decode little-endian on the Lua side.
local function cmd_read8(p)
    local raw = emu:readRange(assert(p.address, "address required"), 1)
    return raw:byte(1)
end
local function cmd_read16(p)
    local raw = emu:readRange(assert(p.address, "address required"), 2)
    return raw:byte(1) | (raw:byte(2) << 8)
end
local function cmd_read32(p)
    local raw = emu:readRange(assert(p.address, "address required"), 4)
    return raw:byte(1) | (raw:byte(2) << 8) | (raw:byte(3) << 16) | (raw:byte(4) << 24)
end

-- emu:writeN — like emu:readN — intermittently throws "invoking failed" when
-- pcall'd from a frame callback. Retry up to a few times before giving up.
--
-- IMPORTANT: emu:writeN is debug-direct memory access. It bypasses the bus
-- model, including any cartridge MBC state machine. On Game Boy, that means:
--   * Writes to ROM region (0x0000-0x7FFF) are no-ops — they don't trigger
--     MBC bank switches or RAM-enable.
--   * Writes to SRAM region (0xA000-0xBFFF) hit the underlying buffer
--     regardless of MBC enable state.
-- For seeding cartridge SRAM on GB, prefer save_state / load_state with a
-- pre-prepared state file, or have the ROM seed itself at boot.
local function retry_call(fn, ...)
    local last_err
    for _ = 1, 8 do
        local ok, err = pcall(fn, ...)
        if ok then return true end
        last_err = err
    end
    error(last_err)
end

local function cmd_write8(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    retry_call(function() emu:write8(addr, val) end)
    return true
end
local function cmd_write16(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    retry_call(function() emu:write16(addr, val) end)
    return true
end
local function cmd_write32(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    retry_call(function() emu:write32(addr, val) end)
    return true
end

local function cmd_read_range(p)
    local addr = assert(p.address, "address required")
    local len  = assert(p.length,  "length required")
    if len > 4096 then error("length exceeds 4096 byte limit") end
    local raw   = emu:readRange(addr, len)
    local bytes = {}
    for i = 1, #raw do bytes[i] = raw:byte(i) end
    return bytes
end

-- Bulk write: counterpart to read_range. Loops emu:write8 with the same
-- retry shielding the typed writes use. Same MBC caveat applies — these are
-- debug-direct writes, the bus model isn't honoured.
local function cmd_write_range(p)
    local addr  = assert(p.address, "address required")
    local bytes = assert(p.bytes,   "bytes required (array of integers)")
    if #bytes > 4096 then error("byte count exceeds 4096 limit") end
    for i, b in ipairs(bytes) do
        retry_call(function() emu:write8(addr + i - 1, b) end)
    end
    return { written = #bytes }
end

-- ── Memory search / snapshot state ──────────────────────────────────────────
-- Candidate sets and snapshots are held HERE, inside mGBA, rather than being
-- shipped to the client. A first-pass value search over EWRAM routinely matches
-- tens of thousands of addresses; serializing that through json.lua and back
-- over the socket costs far more than the scan itself. Keeping the set Lua-side
-- means the iterative narrowing workflow (search → act → search within previous
-- results) stays one round-trip per step regardless of how wide the first pass is.
local search_sets = {}   -- name -> { address, length, addrs = { addr, ... } }
local snapshots   = {}   -- name -> { address, length, data = "<raw bytes>" }

local SCAN_CHUNK  = 4096      -- readRange call size; also the diff block size
local MAX_REGION  = 16777216  -- 16 MiB sanity cap on a single scanned region
local COLLECT_CAP = 100000    -- max hits retained per set (guards Lua memory)

-- Named regions, so callers can say region="EWRAM" instead of memorising bases.
local REGIONS = {
    -- GBA
    EWRAM   = { 0x02000000, 0x40000 },
    IWRAM   = { 0x03000000, 0x8000  },
    PALETTE = { 0x05000000, 0x400   },
    VRAM    = { 0x06000000, 0x18000 },
    OAM     = { 0x07000000, 0x400   },
    -- Game Boy / GBC
    WRAM    = { 0xC000, 0x2000 },
    SRAM    = { 0xA000, 0x2000 },
    HRAM    = { 0xFF80, 0x7F   },
}

local function resolve_region(p)
    if p.region then
        local r = REGIONS[string.upper(tostring(p.region))]
        if not r then error("unknown region: " .. tostring(p.region)) end
        return r[1], r[2]
    end
    local addr = assert(p.address, "address (or region) required")
    local len  = assert(p.length,  "length (or region) required")
    if len < 1          then error("length must be >= 1") end
    if len > MAX_REGION then error("length exceeds " .. MAX_REGION .. " byte limit") end
    return addr, len
end

-- retry_call's sibling for calls whose return value we need. Same rationale:
-- emu methods intermittently throw "invoking failed" from the frame callback,
-- and a region scan issues dozens of readRange calls back-to-back.
local function retry_value(fn)
    local last_err
    for _ = 1, 8 do
        local ok, res = pcall(fn)
        if ok then return res end
        last_err = res
    end
    error(last_err)
end

-- Read an arbitrary-length region as one Lua string. Chunked because readRange
-- is only reliable up to a few KiB, but concatenated before any searching —
-- so a pattern straddling a chunk boundary is still found.
local function read_region(addr, len)
    local parts, n, off = {}, 0, 0
    while off < len do
        local want, at = math.min(SCAN_CHUNK, len - off), addr + off
        n = n + 1
        parts[n] = retry_value(function() return emu:readRange(at, want) end)
        off = off + want
    end
    return table.concat(parts)
end

-- Little-endian decode of `width` bytes at 1-based string offset `off`.
local function decode_le(data, off, width)
    local b1 = data:byte(off)
    if width == 1 then return b1 end
    local b2 = data:byte(off + 1)
    if width == 2 then return b1 | (b2 << 8) end
    return b1 | (b2 << 8) | (data:byte(off + 2) << 16) | (data:byte(off + 3) << 24)
end

local function check_width(w)
    if w ~= 1 and w ~= 2 and w ~= 4 then error("width must be 1, 2, or 4") end
    return w
end

-- Build the byte pattern to search for, from exactly one of value / bytes / text.
-- Returns the needle plus the width it implies (used to pick a default alignment).
local function build_needle(p)
    if p.text then
        if #p.text == 0 then error("text must not be empty") end
        return p.text, 1, "text"
    end
    if p.bytes then
        if #p.bytes == 0 then error("bytes must not be empty") end
        local t = {}
        for i, b in ipairs(p.bytes) do t[i] = string.char(b & 0xFF) end
        return table.concat(t), 1, "bytes"
    end
    if p.value ~= nil then
        local w, t = check_width(p.width or 4), {}
        for i = 1, w do t[i] = string.char((p.value >> ((i - 1) * 8)) & 0xFF) end
        return table.concat(t), w, "value"
    end
    error("one of value, bytes, or text is required")
end

-- Scan a whole region string for `needle`. Alignment is tested against the
-- ABSOLUTE address, since struct alignment is a property of the address itself.
local function scan_region(data, base, needle, align)
    local hits, n, init, capped = {}, 0, 1, false
    while true do
        local s = string.find(data, needle, init, true)
        if not s then break end
        local addr = base + s - 1
        if align <= 1 or addr % align == 0 then
            if n >= COLLECT_CAP then
                capped = true
                break
            end
            n = n + 1
            hits[n] = addr
        end
        init = s + 1   -- +1 (not +#needle) so overlapping matches are found
    end
    return hits, capped
end

-- Build an O(1) lookup from a stored set, for subtracting known-noisy addresses.
--
-- This is what makes hot regions searchable at all. IWRAM rewrites thousands of
-- bytes every frame (stack, scratch), so "what changed when I did X" is buried in
-- self-churn. The workflow this enables:
--
--   snapshot("base")                       -- capture
--   diff("base", store_as="noise")         -- change nothing; this IS the noise floor
--   <perform the action>
--   diff("base", exclude="noise")          -- signal only
local function build_exclude(name)
    if not name then return nil end
    local set = search_sets[name]
    if not set then error("unknown exclude set: " .. tostring(name)) end
    local lookup = {}
    for _, a in ipairs(set.addrs) do lookup[a] = true end
    return lookup
end

local function cmd_search_memory(p)
    local needle, width, kind = build_needle(p)
    local align = p.align or (kind == "value" and width or 1)
    local excl = build_exclude(p.exclude)
    local base, len, hits, capped

    if p.candidates then
        -- Narrowing pass: re-test only the addresses in a previously stored set.
        -- The set carries its own region, so one region read covers every check.
        local set = search_sets[p.candidates]
        if not set then error("unknown candidate set: " .. tostring(p.candidates)) end
        base, len = set.address, set.length
        local data, nlen = read_region(base, len), #needle
        hits, capped = {}, false
        for _, addr in ipairs(set.addrs) do
            local off = addr - base + 1
            if off >= 1 and off + nlen - 1 <= #data
               and string.sub(data, off, off + nlen - 1) == needle then
                hits[#hits + 1] = addr
            end
        end
    else
        base, len = resolve_region(p)
        hits, capped = scan_region(read_region(base, len), base, needle, align)
    end

    -- Subtract the exclude set BEFORE storing, so a stored set is already clean
    -- and can be narrowed further without re-excluding each time.
    local excluded = 0
    if excl then
        local kept = {}
        for _, a in ipairs(hits) do
            if excl[a] then excluded = excluded + 1 else kept[#kept + 1] = a end
        end
        hits = kept
    end

    if p.store_as then
        search_sets[p.store_as] = { address = base, length = len, addrs = hits }
    end

    local limit, shown = p.max_results or 64, {}
    for i = 1, math.min(#hits, limit) do shown[i] = hits[i] end
    return {
        count      = #hits,
        shown      = shown,
        truncated  = #hits > #shown,
        collect_capped = capped,
        excluded   = excluded,
        stored_as  = p.store_as,
        address    = base,
        length     = len,
    }
end

local function cmd_snapshot_memory(p)
    local name = assert(p.name, "name required")
    local addr, len = resolve_region(p)
    snapshots[name] = { address = addr, length = len, data = read_region(addr, len) }
    return { name = name, address = addr, length = len }
end

local PREDICATES = {
    changed = true, unchanged = true, increased = true, decreased = true, equals = true,
}

local function cmd_diff_memory(p)
    local name = assert(p.name, "name required")
    local snap = snapshots[name]
    if not snap then error("unknown snapshot: " .. tostring(name)) end

    local width = check_width(p.width or 1)
    local pred  = p.predicate or "changed"
    if not PREDICATES[pred] then error("unknown predicate: " .. tostring(pred)) end
    local target
    if pred == "equals" then target = assert(p.value, "value required for predicate 'equals'") end
    local align = p.align or width
    local excl  = build_exclude(p.exclude)

    local old, new = snap.data, read_region(snap.address, snap.length)
    local len = #old
    local hits, total, capped, excluded = {}, 0, false, 0

    local bstart = 0
    while bstart < len do
        local bend = math.min(bstart + SCAN_CHUNK, len)
        -- Block fast path: compare whole blocks as strings (one C-level memcmp)
        -- and skip the byte walk entirely when nothing moved. The window is
        -- extended by width-1 so a value straddling into the next block is not
        -- missed by the skip. Doesn't apply to "unchanged", where identical
        -- blocks are exactly the hits we want.
        local wend = math.min(bend + width - 1, len)
        local skip = pred ~= "unchanged"
                     and string.sub(old, bstart + 1, wend) == string.sub(new, bstart + 1, wend)

        if not skip then
            local i = bstart
            if align > 1 then
                i = i + (align - (snap.address + i) % align) % align
            end
            while i < bend and i + width <= len do
                local o = decode_le(old, i + 1, width)
                local n = decode_le(new, i + 1, width)
                local match
                if     pred == "changed"   then match = o ~= n
                elseif pred == "unchanged" then match = o == n
                elseif pred == "increased" then match = n > o
                elseif pred == "decreased" then match = n < o
                else                            match = n == target
                end
                if match and excl and excl[snap.address + i] then
                    -- Known-noisy address: suppressed, and not counted in `count`,
                    -- so the reported total reflects signal rather than churn.
                    excluded = excluded + 1
                elseif match then
                    total = total + 1
                    if total <= COLLECT_CAP then
                        hits[#hits + 1] = { address = snap.address + i, before = o, after = n }
                    else
                        capped = true
                    end
                end
                i = i + align
            end
        end
        bstart = bend
    end

    if p.store_as then
        local addrs = {}
        for i, h in ipairs(hits) do addrs[i] = h.address end
        search_sets[p.store_as] = { address = snap.address, length = snap.length, addrs = addrs }
    end
    -- Re-baseline so the next diff measures from here — the iterative
    -- "act, diff, act, diff" narrowing loop wants this.
    if p.refresh then snap.data = new end

    local limit, shown = p.max_results or 64, {}
    for i = 1, math.min(#hits, limit) do shown[i] = hits[i] end
    return {
        name      = name,
        address   = snap.address,
        length    = snap.length,
        predicate = pred,
        width     = width,
        count     = total,
        changes   = shown,
        truncated = total > #shown,
        collect_capped = capped,
        excluded  = excluded,
        stored_as = p.store_as,
        refreshed = p.refresh and true or false,
    }
end

-- Append one press to the queue. `hold` = frames to hold; `release` = frames
-- to leave keys cleared after, so consecutive presses generate edges.
local function cmd_press_buttons(p)
    require_cap("setKeys")
    local keys = assert(p.buttons, "buttons required")
    local bits = 0
    for _, name in ipairs(keys) do
        local b = KEY_BIT[name]
        if not b then error("unknown key: " .. tostring(name)) end
        bits = bits | (1 << b)
    end
    table.insert(press_queue, {
        bits    = bits,
        hold    = p.frames         or 1,
        release = p.release_frames or 1,
    })
    return { queued = true, queue_size = #press_queue + (active and 1 or 0) }
end

-- Append a whole sequence of presses in one call. Each entry is either a bare
-- button name ("A") or a record ({ buttons = {"Down","B"}, frames = 4 }).
--
-- The entire sequence is validated BEFORE anything is queued: a bad key name at
-- step 7 must not leave steps 1-6 already executing in the emulator, which would
-- leave the ROM in a state the caller never asked for and can't easily undo.
local function cmd_press_sequence(p)
    require_cap("setKeys")
    local seq = assert(p.presses, "presses required")
    if type(seq) ~= "table" then error("presses must be an array") end
    if #seq == 0   then error("presses must contain at least one entry") end
    if #seq > 256  then error("sequence exceeds 256 presses") end

    local default_hold    = p.frames         or 1
    local default_release = p.release_frames or 1

    local recs, total = {}, 0
    for i, step in ipairs(seq) do
        local names, hold, release
        if type(step) == "string" then
            names, hold, release = { step }, default_hold, default_release
        elseif type(step) == "table" then
            names   = step.buttons or error("presses[" .. i .. "]: buttons required")
            hold    = step.frames         or default_hold
            release = step.release_frames or default_release
        else
            error("presses[" .. i .. "]: expected a button name or an object")
        end
        if type(names) ~= "table" or #names == 0 then
            error("presses[" .. i .. "]: buttons must be a non-empty array")
        end
        if hold < 1 or release < 1 then
            error("presses[" .. i .. "]: frames and release_frames must be >= 1")
        end
        local bits = 0
        for _, name in ipairs(names) do
            local b = KEY_BIT[name]
            if not b then error("presses[" .. i .. "]: unknown key: " .. tostring(name)) end
            bits = bits | (1 << b)
        end
        recs[i] = { bits = bits, hold = hold, release = release }
        total   = total + hold + release
    end

    for _, rec in ipairs(recs) do table.insert(press_queue, rec) end
    return { queued = #recs, queue_size = #press_queue + (active and 1 or 0), frames = total }
end

-- Lets the caller tell when a queued sequence has finished. Without this the
-- only way to know is to guess at wall-clock timing, and a screenshot taken too
-- early captures the ROM mid-sequence.
local function cmd_input_status()
    return {
        pending = #press_queue + (active and 1 or 0),
        queued  = #press_queue,
        active  = active and true or false,
    }
end

local function cmd_advance_frames(p)
    if not CAPS or not advance_one then error("frame-advance API not available on this mGBA build") end
    local n = p.count or 1
    for _ = 1, n do advance_one() end
    return CAPS.currentFrame and emu:currentFrame() or nil
end

local function cmd_pause()    require_cap("pause");      emu:pause();   return true end
local function cmd_unpause()  require_cap("unpause");    emu:unpause(); return true end
local function cmd_reset()    require_cap("reset");      emu:reset();   return true end

local function cmd_screenshot(p)
    require_cap("screenshot")
    local path = p.path or (os.tmpname() .. ".png")
    emu:screenshot(path)
    return path
end

-- Save / load state. Prefers slot-based API (numeric slot, mGBA-managed file),
-- falls back to file-based API for builds that only expose that.
local function cmd_save_state(p)
    if not CAPS then error("no ROM loaded — capabilities not yet detected") end
    if p.path and CAPS.saveStateFile then
        emu:saveStateFile(p.path); return { path = p.path }
    end
    if CAPS.saveStateSlot then
        local slot = assert(p.slot, "slot required (0-9)")
        emu:saveStateSlot(slot); return { slot = slot }
    end
    error("no save-state API available on this mGBA build")
end
local function cmd_load_state(p)
    if not CAPS then error("no ROM loaded — capabilities not yet detected") end
    if p.path and CAPS.loadStateFile then
        emu:loadStateFile(p.path); return { path = p.path }
    end
    if CAPS.loadStateSlot then
        local slot = assert(p.slot, "slot required (0-9)")
        emu:loadStateSlot(slot); return { slot = slot }
    end
    error("no load-state API available on this mGBA build")
end

-- ── Dispatch table ──────────────────────────────────────────────────────────

local HANDLERS = {
    ping           = cmd_ping,
    get_info       = cmd_get_info,
    read8          = cmd_read8,
    read16         = cmd_read16,
    read32         = cmd_read32,
    write8         = cmd_write8,
    write16        = cmd_write16,
    write32        = cmd_write32,
    read_range     = cmd_read_range,
    write_range    = cmd_write_range,
    search_memory  = cmd_search_memory,
    snapshot_memory = cmd_snapshot_memory,
    diff_memory    = cmd_diff_memory,
    press_buttons  = cmd_press_buttons,
    press_sequence = cmd_press_sequence,
    input_status   = cmd_input_status,
    advance_frames = cmd_advance_frames,
    pause          = cmd_pause,
    unpause        = cmd_unpause,
    reset          = cmd_reset,
    screenshot     = cmd_screenshot,
    save_state     = cmd_save_state,
    load_state     = cmd_load_state,
}

local function dispatch(cmd)
    if not cmd.method then
        return nil, { code = -32600, message = "missing method field" }
    end
    local handler = HANDLERS[cmd.method]
    if not handler then
        return nil, { code = -32601, message = "unknown method: " .. cmd.method }
    end
    local ok, result = pcall(handler, cmd.params or {})
    if not ok then
        return nil, { code = -32603, message = tostring(result) }
    end
    return result, nil
end

-- ── Process one client's buffer — call after appending new data ─────────────

local function process_buffer(c)
    while true do
        local nl = c.buf:find("\n", 1, true)
        if not nl then break end

        local line = c.buf:sub(1, nl - 1)
        c.buf      = c.buf:sub(nl + 1)

        if #line > 0 then
            local parse_ok, cmd = pcall(json.decode, line)
            local response
            if parse_ok and type(cmd) == "table" then
                local result, rpc_err = dispatch(cmd)
                if rpc_err then
                    response = { id = cmd.id, error = rpc_err }
                else
                    response = { id = cmd.id, result = result }
                end
            else
                response = { id = nil, error = { code = -32700, message = "parse error" } }
            end
            c.sock:send(json.encode(response) .. "\n")
        end
    end
end

-- ── Server socket ───────────────────────────────────────────────────────────

local server = assert(socket.tcp(), "socket.tcp() failed")
assert(server:bind(HOST, PORT), "bind failed — port " .. PORT .. " may already be in use")
assert(server:listen(),         "listen failed")

local clients = {}

-- ── Per-frame callback ──────────────────────────────────────────────────────

callbacks:add("frame", function()

    -- First-frame: probe emu capabilities. We can only do this once a ROM is
    -- running (emu global doesn't exist until then).
    if not CAPS then detect_caps() end

    -- Drive the press queue: each record holds for N frames, releases for M,
    -- then we move to the next record. This guarantees edges between presses,
    -- so ROMs that detect input via edge-trigger see distinct events.
    if active then
        if active.hold_remaining > 0 then
            emu:setKeys(active.bits)
            active.hold_remaining = active.hold_remaining - 1
        elseif active.release_remaining > 0 then
            emu:setKeys(0)
            active.release_remaining = active.release_remaining - 1
        else
            active = nil
        end
    end
    if not active and #press_queue > 0 then
        local rec = table.remove(press_queue, 1)
        active = { bits = rec.bits, hold_remaining = rec.hold, release_remaining = rec.release }
        emu:setKeys(active.bits)
        active.hold_remaining = active.hold_remaining - 1
    end

    -- poll() flushes the socket's internal event queue. Without it, accept()
    -- and hasdata() see stale state and never observe new I/O.
    server:poll()
    local client = server:accept()
    if client then
        console:log("[mcp-mgba] client connected")
        table.insert(clients, { sock = client, buf = "" })
    end

    local i = 1
    while i <= #clients do
        local c = clients[i]
        c.sock:poll()
        if c.sock:hasdata() then
            local ok, data = pcall(function() return c.sock:receive(4096) end)
            if ok and data and #data > 0 then
                c.buf = c.buf .. data
                process_buffer(c)
                i = i + 1
            elseif ok and data == nil then
                console:log("[mcp-mgba] client disconnected")
                table.remove(clients, i)
            else
                console:log("[mcp-mgba] receive error: " .. tostring(data))
                table.remove(clients, i)
            end
        else
            i = i + 1
        end
    end
end)

console:log(string.format("[mcp-mgba] bridge listening on %s:%d", HOST, PORT))
console:log("[mcp-mgba] frame callback registered — capabilities will be probed on first frame")
