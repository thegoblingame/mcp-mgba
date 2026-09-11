import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { MgbaClient } from "../dist/mgba.js";
import { fakeBridge, HANG, DEFAULT, until } from "./helpers.mjs";

test("hung RPC is bounded, unknown after write, never replayed; late reply cannot satisfy another call", async t => {
  let first;
  const bridge = await fakeBridge(t, (request, socket) => {
    if (request.method === "press_buttons") { first = { request, socket }; return HANG; }
    if (request.method === "ping" && first) { socket.write(JSON.stringify({ id: first.request.id, result: "late" }) + "\n"); }
    return DEFAULT;
  });
  const client = new MgbaClient("127.0.0.1", bridge.port, { rpcTimeoutMs: 35 });
  t.after(() => client.disconnect());
  await assert.rejects(client.call("press_buttons", { buttons: ["A"] }), { code: "RPC_TIMEOUT", delivery: "unknown" });
  assert.equal(await client.call("ping"), "pong");
  assert.equal(bridge.calls.filter(c => c.method === "press_buttons").length, 1);
});

test("cancelled before connection writes nothing; cancelled after write stays unknown", async t => {
  const bridge = await fakeBridge(t, () => HANG);
  const client = new MgbaClient("127.0.0.1", bridge.port);
  t.after(() => client.disconnect());
  await assert.rejects(client.call("ping", {}, { signal: AbortSignal.abort() }), { code: "CANCELLED", delivery: "not_sent" });
  assert.equal(bridge.connections, 0);
  const controller = new AbortController();
  const promise = client.call("press_buttons", {}, { signal: controller.signal });
  const check = assert.rejects(promise, { code: "CANCELLED", delivery: "unknown" });
  await until(() => bridge.calls.length === 1);
  controller.abort();
  await check;
});

test("hung connect, independent cancellation, disconnect during connect are bounded", async () => {
  const socket = new net.Socket();
  const client = new MgbaClient("127.0.0.1", 1, { connectTimeoutMs: 50, createConnection: () => socket });
  const controller = new AbortController();
  const cancelled = assert.rejects(client.connect({ signal: controller.signal }), { code: "CANCELLED", delivery: "not_sent" });
  const timeout = assert.rejects(client.connect(), { code: "CONNECT_TIMEOUT", delivery: "not_sent" });
  controller.abort();
  await Promise.all([cancelled, timeout]);
  assert.equal(socket.destroyed, true);
  assert.equal(client.connected, false);
  const socket2 = new net.Socket();
  const other = new MgbaClient("127.0.0.1", 1, { createConnection: () => socket2 });
  const closed = assert.rejects(other.connect(), { code: "DISCONNECTED", delivery: "not_sent" });
  other.disconnect();
  await closed;
});

test("connection refusal and serialization failure are not_sent", async t => {
  const bridge = await fakeBridge(t);
  const client = new MgbaClient("bad.invalid", 1, { connectTimeoutMs: 100 });
  t.after(() => client.disconnect());
  await assert.rejects(client.call("ping"), error => error.delivery === "not_sent");
  const good = new MgbaClient("127.0.0.1", bridge.port);
  t.after(() => good.disconnect());
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(good.call("ping", cycle), { code: "INVALID_REQUEST", delivery: "not_sent" });
  assert.equal(bridge.calls.length, 0);
});

test("partial buffer dies with socket; old events cannot poison a new generation", async t => {
  let oldSocket;
  const bridge = await fakeBridge(t, (request, socket) => {
    if (request.method === "first") { oldSocket = socket; socket.write('{"id":'); socket.destroy(); return HANG; }
    return DEFAULT;
  });
  const client = new MgbaClient("127.0.0.1", bridge.port);
  t.after(() => client.disconnect());
  await assert.rejects(client.call("first"), { delivery: "unknown" });
  assert.equal(await client.call("ping"), "pong");
  assert.equal(bridge.connections, 2);
  oldSocket.emit("error", new Error("late old error"));
  assert.equal(await client.call("ping"), "pong");
  await assert.rejects(client.call("press_buttons", {}, { generation: 1 }), { code: "DISCONNECTED", delivery: "not_sent" });
  assert.equal(bridge.calls.length, 3);
});

for (const bad of [{ error: null }, { error: "secret" }, { error: {} }, { error: { code: "1", message: "secret" } }, { error: { code: 1, message: "secret" }, result: true }]) {
  test("malformed response envelope rejects: " + JSON.stringify(bad), async t => {
    const bridge = await fakeBridge(t, (request, socket) => { socket.write(JSON.stringify({ id: request.id, ...bad }) + "\n"); return HANG; });
    const client = new MgbaClient("127.0.0.1", bridge.port);
    t.after(() => client.disconnect());
    await assert.rejects(client.call("ping"), { code: "PROTOCOL_ERROR", delivery: "unknown" });
  });
}

test("legacy nil result is preserved, strict vision envelope rejects it", async t => {
  const bridge = await fakeBridge(t, (request, socket) => { socket.write(JSON.stringify({ id: request.id }) + "\n"); return HANG; });
  const legacy = new MgbaClient("127.0.0.1", bridge.port);
  const vision = new MgbaClient("127.0.0.1", bridge.port, { strictResponses: true });
  t.after(() => { legacy.disconnect(); vision.disconnect(); });
  assert.equal(await legacy.call("advance_frames"), undefined);
  await assert.rejects(vision.call("ping"), { code: "PROTOCOL_ERROR" });
});

test("size limit is per response, not coalesced TCP chunk; oversized tail fails", async t => {
  const requests = [];
  const bridge = await fakeBridge(t, (request, socket) => {
    requests.push(request);
    if (requests.length === 2) socket.write(requests.map(r => JSON.stringify({ id: r.id, result: "a".repeat(80) }) + "\n").join(""));
    if (request.method === "oversize") socket.write(" ".repeat(129));
    return HANG;
  });
  const client = new MgbaClient("127.0.0.1", bridge.port, { maxResponseBytes: 128 });
  t.after(() => client.disconnect());
  assert.deepEqual(await Promise.all([client.call("one"), client.call("two")]), ["a".repeat(80), "a".repeat(80)]);
  await assert.rejects(client.call("oversize"), { code: "PROTOCOL_ERROR" });
});
