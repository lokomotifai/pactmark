import { readFileSync } from "node:fs";

import { repositoryRoot } from "./lib/repository.mjs";

const requiredConsumers = ["packages/agent", "packages/mcp"] as const;

for (const directory of requiredConsumers) {
  const manifest = JSON.parse(
    readFileSync(`${repositoryRoot}/${directory}/package.json`, "utf8"),
  ) as Readonly<{ name?: unknown; dependencies?: unknown }>;
  if (
    manifest.dependencies === null ||
    typeof manifest.dependencies !== "object" ||
    Array.isArray(manifest.dependencies) ||
    !("@pactmark/policy" in manifest.dependencies)
  ) {
    throw new Error(`KAF_POLICY_PRODUCTION_WIRING_MISSING:${directory}`);
  }
}

process.stdout.write(
  "Policy package is wired as a production dependency of the agent and MCP boundaries.\n",
);
