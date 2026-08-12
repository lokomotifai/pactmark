import process from "node:process";

import { ExecutorConformanceError } from "./docker.mjs";
import { runExecutorLiveReadToolMatrix } from "./live-read-tools.mjs";

try {
  process.stdout.write(`${JSON.stringify(await runExecutorLiveReadToolMatrix(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: error instanceof Error ? error.message : "KAF_EXECUTOR_LIVE_READ_MATRIX_FAILED",
      ...(error instanceof ExecutorConformanceError && error.safeDetail !== undefined
        ? { detail: error.safeDetail }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
}
