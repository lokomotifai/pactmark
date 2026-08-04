import process from "node:process";

import { containerConformanceInternals, runContainerConformance } from "./conformance.mjs";

try {
  const result = await runContainerConformance();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code = error instanceof Error ? error.message : "KAF_CONTAINER_CONFORMANCE_FAILED";
  const detail = containerConformanceInternals.safeCommandFailureDetail(error);
  process.stderr.write(`${JSON.stringify(detail === undefined ? { code } : { code, detail })}\n`);
  process.exitCode = 1;
}
