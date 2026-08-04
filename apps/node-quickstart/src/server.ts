import { createPactmarkNodeServer, installGracefulShutdown } from "@pactmark/node";

import { nodeQuickstartHandler, nodeQuickstartRuntime } from "./host.js";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("KAF_NODE_PORT_INVALID");
  }
  return port;
}

export function startNodeQuickstart(port = parsePort(process.env["PORT"])) {
  const server = createPactmarkNodeServer(nodeQuickstartHandler, {
    capabilities: nodeQuickstartRuntime.getCapabilities(),
    readEnvironment: () => ({}),
  });
  installGracefulShutdown(server);
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ code: "KAF_NODE_LISTENING", port })}\n`);
  });
  return server;
}

if (process.env["PACTMARK_NODE_NO_AUTOSTART"] !== "1") startNodeQuickstart();
