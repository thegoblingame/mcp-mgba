import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fengari from "fengari";

const json = await readFile(new URL("../lua/json.lua", import.meta.url), "utf8");
const bridge = await readFile(new URL("../lua/bridge.lua", import.meta.url), "utf8");
const environment = String.raw`
frame = 0
keys = {}
memory_reads = 0
resets = 0
logs = {}
emu = {
  setKeys = function(self, bits) table.insert(keys, bits) end,
  screenshot = function(self, path) end,
  getGameTitle = function() return "TEST" end,
  getGameCode = function() return "TEST" end,
  currentFrame = function() return frame end,
  platform = function() return 0 end,
  readRange = function(self, address, length) memory_reads = memory_reads + 1; return string.rep(string.char(7), length) end,
  reset = function() resets = resets + 1 end,
}
console = { log = function(self, text) table.insert(logs, text) end }
callbacks = { add = function(self, event, fn) frame_callback = fn end }
accept_queue = {}
listener = {
  bind = function() return true end,
  listen = function() return true end,
  poll = function() end,
  accept = function() return table.remove(accept_queue, 1) end,
}
socket = { tcp = function() return listener end }
function tick(n)
  for i=1,(n or 1) do frame = frame + 1; frame_callback() end
end
function add_client()
  local c = { incoming = {}, outgoing = {}, disconnected = false }
  c.poll = function() end
  c.hasdata = function() return c.disconnected or #c.incoming > 0 end
  c.receive = function()
    if c.receive_error then error("receive failed") end
    if c.disconnected then return nil end
    return table.remove(c.incoming, 1)
  end
  c.send = function(self, text) table.insert(c.outgoing, text) end
  table.insert(accept_queue, c)
  tick()
  return c
end
request_id = 0
function request(c, method, params)
  request_id = request_id + 1
  table.insert(c.incoming, require("json").encode({id=request_id,method=method,params=params or {}}) .. "\n")
  tick()
  assert(#c.outgoing > 0, "bridge failed to reply")
  return require("json").decode(table.remove(c.outgoing, 1))
end
function close_client(c, receive_error)
  c.disconnected = true
  c.receive_error = receive_error
  tick()
end
`;
function execute(body) {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const source = `package.preload["json"] = function()\n${json}\nend\n${environment}\n${bridge}\n${body}`;
  const result = lauxlib.luaL_dostring(state, to_luastring(source));
  const error = result === lua.LUA_OK ? undefined : lua.lua_tojsstring(state, -1);
  lua.lua_close(state);
  assert.equal(result, lua.LUA_OK, error);
}

test("actual Lua bridge enforces socket-bound lease and preserves legacy behavior", () => execute(String.raw`
local a = add_client()
assert(request(a, "read8", {address=123}).result == 7)
assert(memory_reads == 1)
local b = add_client()
assert(request(a, "vision_claim").error.code == -32011)
close_client(b)
local claim = request(a, "vision_claim").result
assert(claim.version == 1 and claim.claimed and claim.pending == 0 and claim.controlling_clients == 1)
assert(request(a, "vision_claim").result.claimed)
assert(request(a, "read8", {address=123}).error.code == -32601)
assert(request(a, "reset").error.code == -32601)
assert(memory_reads == 1 and resets == 0)
local outsider = add_client()
assert(request(outsider, "press_buttons", {buttons={"A"}}).error.code == -32010)
assert(request(outsider, "reset").error.code == -32010)
assert(request(outsider, "ping").error.code == -32010)
assert(request(outsider, "vision_claim").error.code == -32010)
assert(request(a, "ping").result == "pong")
assert(request(a, "vision_claim").result.claimed)
assert(#keys == 0 and resets == 0)
close_client(a)
assert(request(outsider, "read8", {address=123}).result == 7)
assert(memory_reads == 2)
assert(request(outsider, "vision_claim").result.claimed)
`));

test("actual Lua lease release retains accepted queue and requires drain before a new claim", () => execute(String.raw`
local a = add_client()
assert(request(a, "vision_claim").result.claimed)
local r = request(a, "press_sequence", {presses={{buttons={"A"},frames=3,release_frames=2},{buttons={"B"},frames=2,release_frames=2}}}).result
assert(r.queued == 2 and r.queue_size == 2 and r.frames == 9)
assert(#keys == 0)
close_client(a)
local b = add_client()
assert(request(b, "vision_claim").error.code == -32012)
tick(15)
assert(request(b, "input_status").result.pending == 0)
assert(request(b, "vision_claim").result.claimed)
local a_count, b_count, released = 0, 0, 0
for _,bits in ipairs(keys) do
  if bits == 1 then a_count=a_count+1 elseif bits == 2 then b_count=b_count+1 elseif bits == 0 then released=released+1 else error("unexpected key") end
end
assert(a_count == 3 and b_count == 2 and released == 4)
assert(resets == 0)
`));

test("actual Lua refuses preexisting input and validates a whole sequence before appending", () => execute(String.raw`
local a = add_client()
assert(request(a, "press_buttons", {buttons={"A"},frames=20,release_frames=2}).result.queued)
assert(request(a, "vision_claim").error.code == -32012)
tick(30)
assert(request(a, "vision_claim").result.claimed)
local before = #keys
assert(request(a, "press_sequence", {presses={"A",{buttons={"not-a-key"}}}}).error)
assert(request(a, "input_status").result.pending == 0)
tick(5)
assert(#keys == before)
close_client(a, true)
local b = add_client()
assert(request(b, "vision_claim").result.claimed)
`));
