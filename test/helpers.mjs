import net from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MgbaClient } from "../dist/mgba.js";
import { createVisionServer } from "../dist/vision/server.js";

export const HANG = Symbol("do not reply");
export const DEFAULT = Symbol("use normal reply");
export async function fakeBridge(t, handler = () => DEFAULT, options = {}) {
  const state = { calls: [], sockets: new Set(), connections: 0, queue: 0, autoDrain: options.autoDrain ?? true, frame: 1 };
  const server = net.createServer(socket => {
    state.connections++;
    state.sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => state.sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        state.calls.push(request);
        Promise.resolve().then(() => handler(request, socket, state)).then(value => {
          if (value === HANG) return;
          if (value === DEFAULT) value = normal(request, state);
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result: value }) + "\n");
        }).catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, error: { code: -32603, message: error.message } }) + "\n"); });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.port = server.address().port;
  t.after(async () => { for (const socket of state.sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return state;
}
function normal(request, state) {
  switch (request.method) {
    case "vision_claim": return { version: 1, claimed: true, controlling_clients: 1, pending: state.queue };
    case "ping": return "pong";
    case "get_info": return { rom_loaded: true, title: "FIREEMBLEM", code: "AE7E", frame: state.frame++, platform: 0,
      capabilities: { screenshot: true, setKeys: true, currentFrame: true, readRange: true },
      cursor: { x: 7, y: 8 }, hp: 20, secret: "NEVER_RETURN_THIS" };
    case "input_status": if (state.autoDrain) state.queue = 0; return { pending: state.queue, queued: state.queue, active: false };
    case "press_buttons": state.queue++; return { queued: true, queue_size: state.queue, hp: 42 };
    case "press_sequence": {
      state.queue += request.params.presses.length;
      const frames = request.params.presses.reduce((sum, p) => sum + (typeof p === "string" ? (request.params.frames ?? 1) + (request.params.release_frames ?? 1) : (p.frames ?? request.params.frames ?? 1) + (p.release_frames ?? request.params.release_frames ?? 1)), 0);
      return { queued: request.params.presses.length, queue_size: state.queue, frames, cursor: [1, 2] };
    }
    case "screenshot": return request.params.path;
    default: throw new Error("Unexpected bridge method in test: " + request.method);
  }
}
export async function fixture(t, { handler, bridgeOptions, ...options } = {}) {
  const bridge = await fakeBridge(t, handler, bridgeOptions);
  const client = new MgbaClient("127.0.0.1", bridge.port, { connectTimeoutMs: 100, rpcTimeoutMs: 100, strictResponses: true });
  const { server, service } = createVisionServer({ client, experimentId: "test-experiment", attemptId: "test-attempt", ...options });
  t.after(() => service.close());
  return { bridge, client, server, service };
}
export async function mcpPair(t, server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
export function value(result) { return result.structuredContent ?? JSON.parse(result.content[0].text); }
export function inputs(bridge) { return bridge.calls.filter(call => call.method === "press_buttons" || call.method === "press_sequence"); }
export async function until(predicate, timeout = 1000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Test condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
