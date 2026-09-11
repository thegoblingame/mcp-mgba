import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MgbaClient } from "../mgba.js";
import { VisionBridge, type VisionLifecycleEvent } from "./bridge.js";
import { LIMITS, listVisionTools } from "./contracts.js";
import { VisionService, type VisionServiceOptions } from "./service.js";

export function createVisionServer(options: VisionServiceOptions & { client?: MgbaClient; host?: string; port?: number; onLifecycle?: (event: VisionLifecycleEvent) => void } = {}) {
  const client = options.client ?? new MgbaClient(options.host ?? "127.0.0.1", options.port ?? 8765,
    { connectTimeoutMs: LIMITS.connectMs, rpcTimeoutMs: LIMITS.rpcMs, maxResponseBytes: 64 * 1024, strictResponses: true });
  const service = new VisionService(new VisionBridge(client, options.onLifecycle), options);
  const server = new Server({ name: "mcp-mgba-vision", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listVisionTools() }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => service.invoke(request.params.name, request.params.arguments, extra.signal));
  server.onclose = () => service.close();
  return { server, service };
}
