import { createPactmarkNodeServer, installGracefulShutdown } from "@pactmark/node";

import { nodeQuickstartHandler, nodeQuickstartRuntime } from "./host.js";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("KAF_NODE_PORT_INVALID");
  }
  return port;
}

function parseBindHost(value: string | undefined): "127.0.0.1" | "0.0.0.0" {
  if (value === undefined || value === "127.0.0.1") return "127.0.0.1";
  if (value === "0.0.0.0") return value;
  throw new TypeError("KAF_NODE_BIND_HOST_INVALID");
}

export function startNodeQuickstart(
  port = parsePort(process.env["PORT"]),
  host = parseBindHost(process.env["PACTMARK_BIND_HOST"]),
) {
  const server = createPactmarkNodeServer(nodeQuickstartHandler, {
    capabilities: nodeQuickstartRuntime.getCapabilities(),
    readEnvironment: () => ({}),
  });
  installGracefulShutdown(server);
  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({ code: "KAF_NODE_LISTENING", host, port })}\n`);
  });
  return server;
}

if (process.env["PACTMARK_NODE_NO_AUTOSTART"] !== "1") startNodeQuickstart();
