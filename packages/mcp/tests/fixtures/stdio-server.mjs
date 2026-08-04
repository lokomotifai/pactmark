import process from "node:process";

const inputSchema = {
  type: "object",
  properties: {
    value: { type: "string" },
    mode: { enum: ["malformed", "failure"] },
    marker: { type: "string" },
  },
  anyOf: [{ required: ["value"] }, { required: ["mode"] }],
};
const outputSchema = {
  type: "object",
  properties: { echo: { type: "string" } },
  required: ["echo"],
};

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (!("id" in message)) continue;
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "exact-env-server", version: "1.0.0" },
      });
    } else if (message.method === "tools/list") {
      respond(message.id, {
        tools: [{ name: "exact_env", inputSchema, outputSchema }],
      });
    } else if (message.method === "tools/call") {
      respond(message.id, {
        content: [],
        structuredContent: {
          echo: process.env.PACTMARK_MCP_AMBIENT_CANARY ?? "absent",
        },
      });
    }
  }
});
