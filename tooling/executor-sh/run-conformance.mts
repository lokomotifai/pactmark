import process from "node:process";

import { runExecutorContainerConformance } from "./conformance.mjs";
import { ExecutorConformanceError } from "./docker.mjs";

try {
  process.stdout.write(`${JSON.stringify(await runExecutorContainerConformance(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: error instanceof Error ? error.message : "KAF_EXECUTOR_CONFORMANCE_FAILED",
      ...(error instanceof ExecutorConformanceError && error.safeDetail !== undefined
        ? { detail: error.safeDetail }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
}
