#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVisionServer } from "./vision/server.js";

async function main(): Promise<void> {
  const host = process.env.MGBA_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Vision bridge must be local");
  const portText = process.env.MGBA_PORT ?? "8765";
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("Invalid bridge port");
  const { server, service } = createVisionServer({ host, port: Number(portText),
    experimentId: process.env.VISION_EXPERIMENT_ID, attemptId: process.env.VISION_ATTEMPT_ID,
    onLifecycle: event => { process.stderr.write(JSON.stringify({ component: "mcp-mgba-vision", ...event }) + "\n"); } });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    service.close();
    // MCP close is normally immediate; bound shutdown if an output stream stalls.
    const timer = setTimeout(() => process.exit(1), 1000);
    void server.close().then(() => clearTimeout(timer), () => { clearTimeout(timer); process.exitCode = 1; });
  };
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  process.stdin.once("error", close);
  process.stdout.once("error", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 }));
  process.stderr.write("[mcp-mgba-vision] ready (stdio); bridge connection is lazy\n");
}
main().catch(() => { process.stderr.write("[mcp-mgba-vision] startup failed; check local configuration\n"); process.exitCode = 1; });
