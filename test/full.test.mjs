import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { registerTools } from "../dist/tools.js";
import { MgbaClient } from "../dist/mgba.js";
import { fakeBridge, mcpPair, DEFAULT } from "./helpers.mjs";

test("full server retains the baseline 32 public names/schemas", async t => {
  const server = new Server({ name: "full", version: "1" }, { capabilities: { tools: {} } });
  registerTools(server, new MgbaClient());
  const client = await mcpPair(t, server);
  const list = (await client.listTools()).tools;
  assert.equal(list.length, 32);
  // The baseline was captured before SDK response parsing. Zod preserves the
  // structures but reorders some object properties during the MCP round trip.
  const handlers = [];
  registerTools({ setRequestHandler: (_schema, handler) => handlers.push(handler) }, new MgbaClient());
  const registered = (await handlers[0]()).tools;
  assert.deepEqual(list.map(({ name, inputSchema }) => ({ name, inputSchema })), registered.map(({ name, inputSchema }) => ({ name, inputSchema })));
  const schemaHash = createHash("sha256").update(JSON.stringify(registered.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest("hex");
  assert.equal(schemaHash, "2af4d84ada95d462337b3bfd6c68294de140662699ad61e1147c1962081b96e9");
});

test("full ping/info and shared raw submissions retain parameters and output formatting", async t => {
  const bridge = await fakeBridge(t, request => {
    if (request.method === "get_info") return { title: "TEST", code: "TEST", platform: 0, frame: 12, capabilities: { setKeys: true, screenshot: false } };
    return DEFAULT;
  });
  const mgba = new MgbaClient("127.0.0.1", bridge.port);
  t.after(() => mgba.disconnect());
  const server = new Server({ name: "full", version: "1" }, { capabilities: { tools: {} } });
  registerTools(server, mgba);
  const client = await mcpPair(t, server);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.equal(await call("mgba_ping"), "pong");
  assert.equal(await call("mgba_get_info"), "Title:    TEST\nCode:     TEST\nPlatform: 0\nFrame:    12\n\nCapabilities present: setKeys\nMissing on this build: screenshot");
  assert.equal(await call("mgba_press_buttons", { buttons: ["A"] }), "Queued press: A (hold 1f, release 1f). Queue size: 1");
  assert.deepEqual(bridge.calls.at(-1).params, { buttons: ["A"], frames: 1, release_frames: 1 });
  assert.equal(await call("mgba_press_buttons", { buttons: ["Down", "B"], frames: 2, release_frames: 3 }), "Queued press: Down+B (hold 2f, release 3f). Queue size: 2");
  assert.deepEqual(bridge.calls.at(-1).params, { buttons: ["Down", "B"], frames: 2, release_frames: 3 });
  assert.equal(await call("mgba_press_sequence", { presses: ["A"], wait: false }), "Queued 1 press(es), 2 frames. Queue size: 3");
  assert.deepEqual(bridge.calls.at(-1).params, { presses: ["A"] });
  assert.equal(await call("mgba_press_sequence", { presses: ["B", { buttons: ["Left"], frames: 2 }], frames: 3, release_frames: 4 }), "Executed 2 press(es) over 13 frames.");
  assert.deepEqual(bridge.calls.findLast(c => c.method === "press_sequence").params, { presses: ["B", { buttons: ["Left"], frames: 2 }], frames: 3, release_frames: 4 });
  assert.equal(bridge.calls.some(c => c.method === "vision_claim"), false);
});

test("full server preserves bridge RPC error propagation", async t => {
  const bridge = await fakeBridge(t, () => { throw new Error("legacy detail"); });
  const mgba = new MgbaClient("127.0.0.1", bridge.port);
  t.after(() => mgba.disconnect());
  await assert.rejects(mgba.call("ping"), { message: "mGBA RPC error [-32603]: legacy detail" });
});
