import process from "node:process";

import { runContainerConformance } from "./conformance.mjs";

try {
  const result = await runContainerConformance();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error ? error.message : "KAF_CONTAINER_CONFORMANCE_FAILED";
  process.stderr.write(`${JSON.stringify({ code })}\n`);
  process.exitCode = 1;
}
