import process from "node:process";

import { ExecutorPackedConsumerError, runExecutorPackedConsumer } from "./packed-consumer.mjs";

try {
  process.stdout.write(`${JSON.stringify(await runExecutorPackedConsumer(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code:
        error instanceof Error
          ? error.message.split("\n", 1)[0]
          : "KAF_EXECUTOR_PACKED_CONSUMER_FAILED",
      ...(error instanceof ExecutorPackedConsumerError && error.safeDetail !== undefined
        ? { detail: error.safeDetail }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
}
