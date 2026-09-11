import test from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { registerTools } from "../dist/tools.js";
import { TOOL_NAMES, LIMITS, listVisionTools, validateArguments } from "../dist/vision/contracts.js";
import { fixture, mcpPair, value, inputs, DEFAULT, HANG, until } from "./helpers.mjs";

const valid = {
  vision_session: {}, vision_observe: {}, mgba_press_buttons: { buttons: ["A"] },
  mgba_press_sequence: { presses: ["A", { buttons: ["Down", "B"], frames: 2 }] },
  vision_step: { presses: ["A"] }, vision_wait: { frames: 20 },
  vision_note: { claim: "The visible menu opened.", category: "observation", evidence: ["obs:1"] }, vision_recall: {},
};

test("MCP list is exact and discovery/unknown/unavailable calls never connect", async t => {
  const f = await fixture(t);
  const client = await mcpPair(t, f.server);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), TOOL_NAMES);
  const full = new Server({ name: "full-test", version: "1" }, { capabilities: { tools: {} } });
  registerTools(full, f.client);
  const fullClient = await mcpPair(t, full);
  const forbidden = (await fullClient.listTools()).tools.map(tool => tool.name).filter(name => !TOOL_NAMES.includes(name));
  for (const name of [...forbidden, "__proto__", "constructor", "toString", "read_range", "vision_claim", "mgba_call", "unknown"]) {
    const r = await client.callTool({ name, arguments: {} });
    assert.equal(r.isError, true, name);
    assert.equal(value(r).error.code, "UNKNOWN_TOOL", name);
  }
  for (const name of ["vision_observe", "vision_step", "vision_wait", "vision_note", "vision_recall"]) {
    const r = await client.callTool({ name, arguments: valid[name] });
    assert.equal(r.isError, true, name);
    assert.equal(value(r).error.code, "NOT_IMPLEMENTED", name);
  }
  assert.equal(f.bridge.calls.length, 0);
  assert.equal(f.bridge.connections, 0);
});

test("all schemas enforce nested strictness, integers, bounds, aggregate limits before I/O", async t => {
  const { service, bridge } = await fixture(t);
  const cases = [
    ["vision_session", { address: 123 }], ["vision_observe", { path: "secret" }],
    ["vision_observe", { crop: { x: 239, y: 0, width: 2, height: 1 } }],
    ["vision_observe", { crop: { x: 0, y: 0, width: 1, height: 1, path: "x" } }],
    ["vision_observe", { scale: 2 }], ["vision_observe", { scale: 3.1 }],
    ["mgba_press_buttons", { buttons: [] }], ["mgba_press_buttons", { buttons: ["a"] }],
    ["mgba_press_buttons", { buttons: ["A", "A"] }], ["mgba_press_buttons", { buttons: ["A"], frames: 0 }],
    ["mgba_press_buttons", { buttons: ["A"], frames: 1.5 }], ["mgba_press_buttons", { buttons: ["A"], release_frames: 601 }],
    ["mgba_press_buttons", { buttons: ["A"], frames: "1" }],
    ["mgba_press_sequence", { presses: ["A", { buttons: ["B"], unexpected: true }] }],
    ["mgba_press_sequence", { presses: ["A", "invalid"] }], ["mgba_press_sequence", { presses: [] }],
    ["mgba_press_sequence", { presses: Array(257).fill("A") }],
    ["mgba_press_sequence", { presses: Array(4).fill("A"), frames: 600, release_frames: 600 }],
    ["mgba_press_sequence", { presses: ["A"], timeout_ms: LIMITS.operationMs + 1 }],
    ["mgba_press_sequence", { presses: ["A", null] }], ["vision_step", { presses: ["A"], wait: false }],
    ["vision_wait", {}], ["vision_wait", { frames: 1, milliseconds: 1 }],
    ["vision_wait", { milliseconds: 0 }], ["vision_wait", { frames: 1, observe: false, scale: 3 }],
    ["vision_note", { ...valid.vision_note, path: "secret" }], ["vision_note", { ...valid.vision_note, claim: " " }],
    ["vision_note", { ...valid.vision_note, evidence: ["../secret"] }],
    ["vision_note", { ...valid.vision_note, supersedes: [] }],
    ["vision_recall", { query: "x".repeat(201) }], ["vision_recall", { limit: 21 }],
    ["vision_recall", { tags: ["x", "x"] }], ["vision_recall", { offset: -1 }],
  ];
  for (const name of TOOL_NAMES) {
    for (const args of [null, [], "bad", 1, { ...valid[name], nested: {} }]) cases.push([name, args]);
  }
  for (const [name, args] of cases) {
    const result = value(await service.invoke(name, args));
    assert.equal(result.ok, false, JSON.stringify([name, args]));
    assert.equal(result.error.code, "INVALID_ARGUMENTS", JSON.stringify([name, args]));
  }
  for (const [name, args] of Object.entries(valid)) assert.doesNotThrow(() => validateArguments(name, args));
  assert.equal(bridge.calls.length, 0);
});

test("reset chord and any containing combination reject the whole batch", async t => {
  const { service, bridge } = await fixture(t);
  for (const buttons of [["A", "B", "Select", "Start"], ["R", "Start", "Select", "B", "A"]]) {
    assert.equal(value(await service.invoke("mgba_press_buttons", { buttons })).error.code, "PROHIBITED_INPUT");
    assert.equal(value(await service.invoke("mgba_press_sequence", { presses: ["A", { buttons }] })).error.code, "PROHIBITED_INPUT");
  }
  assert.equal(bridge.calls.length, 0);
});

test("session filters metadata/capabilities, uses stable IDs and a persistent claimed socket", async t => {
  const { service, bridge } = await fixture(t);
  const first = value(await service.invoke("vision_session", {}));
  const second = value(await service.invoke("vision_session", {}));
  assert.equal(first.ok, true);
  assert.equal(first.data.exclusive_controller, true);
  assert.deepEqual(first.data.capabilities, { screenshot: true, controller_input: true, frame_counter: true });
  assert.equal(first.experiment_id, "test-experiment");
  assert.equal(first.attempt_id, "test-attempt");
  assert.equal(first.session_id, second.session_id);
  assert.equal(bridge.connections, 1);
  assert.equal(bridge.calls.filter(c => c.method === "vision_claim").length, 1);
  for (const text of ["NEVER_RETURN_THIS", "readRange", '"cursor"', '"hp"']) assert.equal(JSON.stringify(first).includes(text), false);
});

test("bridge errors and malformed approved metadata cannot leak text or paths", async t => {
  for (const info of [{ rom_loaded: true, title: "C:\\secret\\guide.md", capabilities: {} }, { rom_loaded: true, capabilities: { setKeys: "SECRET" } }, { rom_loaded: true, frame: "SECRET", capabilities: {} }]) {
    const { service } = await fixture(t, { handler: request => request.method === "get_info" ? info : DEFAULT });
    const result = value(await service.invoke("vision_session", {}));
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  const { service } = await fixture(t, { handler: () => { throw new Error("SECRET C:\\hidden\\file 0x02000000"); } });
  const result = value(await service.invoke("vision_session", {}));
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("unsupported/existing queue/multiple-client lease preflight fails without input", async t => {
  for (const claim of [{ version: 0, claimed: true, controlling_clients: 1, pending: 0 }, { version: 1, claimed: true, controlling_clients: 2, pending: 0 }, { version: 1, claimed: true, controlling_clients: 1, pending: 1 }]) {
    const { service, bridge } = await fixture(t, { handler: request => request.method === "vision_claim" ? claim : DEFAULT });
    assert.equal(value(await service.invoke("mgba_press_buttons", { buttons: ["A"] })).error.code, "SESSION_PREFLIGHT_FAILED");
    assert.equal(inputs(bridge).length, 0);
  }
  const { service, bridge } = await fixture(t, { handler: request => { if (request.method === "vision_claim") throw new Error("unknown method"); return DEFAULT; } });
  assert.equal(value(await service.invoke("mgba_press_buttons", { buttons: ["A"] })).ok, false);
  assert.equal(inputs(bridge).length, 0);
});

test("raw input defaults, mixed batch normalization, queued versus drained receipts are honest", async t => {
  const { service, bridge } = await fixture(t);
  const button = value(await service.invoke("mgba_press_buttons", { buttons: ["A", "Down"] }));
  assert.equal(button.data.input_state, "queued");
  assert.equal(button.data.game_acceptance, "not_verified");
  assert.equal(button.data.requested_frames, 2);
  assert.deepEqual(inputs(bridge)[0].params, { buttons: ["A", "Down"], frames: 1, release_frames: 1 });
  const batch = value(await service.invoke("mgba_press_sequence", { presses: ["A", { buttons: ["B"], frames: 3 }], frames: 2, release_frames: 4 }));
  assert.equal(batch.data.input_state, "drained");
  assert.equal(batch.data.pending, 0);
  assert.equal(batch.data.requested_frames, 13);
  assert.equal(batch.data.accepted_presses, 2);
  assert.equal(inputs(bridge).length, 2);
  assert.deepEqual(inputs(bridge)[1].params.presses, [{ buttons: ["A"], frames: 2, release_frames: 4 }, { buttons: ["B"], frames: 3, release_frames: 4 }]);
  const queued = value(await service.invoke("mgba_press_sequence", { presses: ["A"], wait: false }));
  assert.equal(queued.data.input_state, "queued");
  assert.equal(JSON.stringify(queued).includes("cursor"), false);
});

test("global outstanding-frame cap rejects another append instead of growing unbounded", async t => {
  const { service, bridge } = await fixture(t, { bridgeOptions: { autoDrain: false } });
  for (let i = 0; i < 3; i++) assert.equal(value(await service.invoke("mgba_press_buttons", { buttons: ["A"], frames: 600, release_frames: 600 })).ok, true);
  assert.equal(value(await service.invoke("mgba_press_buttons", { buttons: ["A"] })).error.code, "QUEUE_LIMIT");
  assert.equal(inputs(bridge).length, 3);
});

test("lost input ack or malformed receipt permanently latches; future tools make zero further I/O", async t => {
  for (const kind of ["disconnect", "timeout", "malformed"]) {
    const { service, bridge } = await fixture(t, { operationTimeoutMs: 60, handler: (request, socket) => {
      if (request.method !== "press_buttons") return DEFAULT;
      if (kind === "disconnect") { socket.destroy(); return HANG; }
      if (kind === "timeout") return HANG;
      return { queued: false, queue_size: 0 };
    } });
    const result = value(await service.invoke("mgba_press_buttons", { buttons: ["A"] }));
    assert.equal(result.ok, false, kind);
    assert.equal(result.error.input_state, "unknown", kind);
    assert.equal(result.error.technical_interruption, true, kind);
    const count = bridge.calls.length;
    for (const name of TOOL_NAMES) assert.equal(value(await service.invoke(name, valid[name])).error.technical_interruption, true);
    assert.equal(bridge.calls.length, count);
    assert.equal(inputs(bridge).length, 1);
  }
});

test("acknowledged wait:false input still invalidates on later disconnect", async t => {
  const { service, bridge } = await fixture(t, { bridgeOptions: { autoDrain: false } });
  assert.equal(value(await service.invoke("mgba_press_sequence", { presses: ["A"], wait: false })).data.input_state, "queued");
  for (const socket of bridge.sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  const count = bridge.calls.length;
  const result = value(await service.invoke("vision_session", {}));
  assert.equal(result.error.technical_interruption, true);
  assert.equal(result.error.input_state, "unknown");
  assert.equal(bridge.calls.length, count);
});

test("confirmed drain allows safe reconnect and a new claim, without replay", async t => {
  const { service, bridge } = await fixture(t);
  assert.equal(value(await service.invoke("mgba_press_sequence", { presses: ["A"] })).data.input_state, "drained");
  for (const socket of bridge.sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(value(await service.invoke("vision_session", {})).ok, true);
  assert.equal(bridge.connections, 2);
  assert.equal(bridge.calls.filter(c => c.method === "vision_claim").length, 2);
  assert.equal(inputs(bridge).length, 1);
});

test("drain timeout bounds an open hung status RPC and never resubmits", async t => {
  let sent = false;
  const { service, bridge } = await fixture(t, { handler: request => {
    if (request.method === "press_sequence") sent = true;
    if (request.method === "input_status" && sent) return HANG;
    return DEFAULT;
  } });
  const started = performance.now();
  const result = value(await service.invoke("mgba_press_sequence", { presses: ["A"], timeout_ms: 30 }));
  assert.ok(performance.now() - started < 600);
  assert.equal(result.error.code, "INPUT_DRAIN_TIMEOUT");
  assert.equal(result.error.technical_interruption, true);
  assert.equal(result.error.input_state, "unknown");
  assert.equal(inputs(bridge).length, 1);
});

test("whole-operation deadline includes serial-queue waiting; expired queued action never executes", async t => {
  let finish;
  let entered = false;
  const blocked = new Promise(resolve => { finish = resolve; });
  const { service, bridge } = await fixture(t, { operationTimeoutMs: 35, backends: { vision_wait: async () => { entered = true; await blocked; return { data: {} }; } } });
  const first = service.invoke("vision_wait", { frames: 1 });
  await until(() => entered);
  const second = service.invoke("mgba_press_buttons", { buttons: ["A"] });
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => value(result).error.code === "OPERATION_TIMEOUT"));
  finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bridge.calls.length, 0);
});

test("extension hooks serialize top-level work, revoke retained capabilities and reject concurrent use", async t => {
  let retained;
  let active = 0;
  let maximum = 0;
  const { service, bridge } = await fixture(t, { backends: { vision_wait: async (_, operation) => {
    retained = operation;
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { data: { waited: true } };
  } } });
  assert.ok((await Promise.all([service.invoke("vision_wait", { frames: 1 }), service.invoke("vision_wait", { frames: 2 })])).every(r => value(r).ok));
  assert.equal(maximum, 1);
  await assert.rejects(retained.pressButtons({ buttons: ["A"] }), { code: "OPERATION_EXPIRED" });
  assert.equal(bridge.calls.length, 0);
  const concurrent = await fixture(t, { backends: { vision_wait: async (_, op) => { await Promise.all([op.session(), op.session()]); return { data: {} }; } } });
  assert.equal(value(await concurrent.service.invoke("vision_wait", { frames: 1 })).error.code, "CONCURRENT_OPERATION");
  assert.equal(inputs(concurrent.bridge).length, 0);
});

test("MCP cancellation before and during input remains bounded and cannot replay", async t => {
  const { service, bridge } = await fixture(t, { handler: request => request.method === "press_buttons" ? HANG : DEFAULT });
  const cancelled = value(await service.invoke("mgba_press_buttons", { buttons: ["A"] }, AbortSignal.abort()));
  assert.equal(cancelled.error.input_state, "not_sent");
  assert.equal(bridge.calls.length, 0);
  const controller = new AbortController();
  const pending = service.invoke("mgba_press_buttons", { buttons: ["A"] }, controller.signal);
  await until(() => inputs(bridge).length === 1);
  controller.abort();
  const result = value(await pending);
  assert.equal(result.error.technical_interruption, true);
  assert.equal(result.error.input_state, "unknown");
  assert.equal(inputs(bridge).length, 1);
});

test("tool definitions are returned defensively and contain no full-server knowledge", () => {
  const definitions = listVisionTools();
  definitions[0].name = "read8";
  assert.equal(listVisionTools()[0].name, "vision_session");
  const text = JSON.stringify(listVisionTools());
  for (const token of ["0x02000000", "fe7_state", "mgba_read", "RAM.md", "llm_plays_fe7"]) assert.equal(text.includes(token), false);
});
