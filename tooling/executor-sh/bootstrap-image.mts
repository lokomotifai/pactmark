import process from "node:process";

import {
  assertPinnedImage,
  executorDockerPlatform,
  executorPlatformImage,
  runDocker,
} from "./docker.mjs";

try {
  const platform = await executorDockerPlatform();
  const image = executorPlatformImage(platform);
  await runDocker(["pull", image], { timeoutMs: 300_000, maxOutputBytes: 16 * 1024 * 1024 });
  await assertPinnedImage(platform);
  process.stdout.write(
    `${JSON.stringify({ code: "KAF_EXECUTOR_IMAGE_READY", platform, image })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ code: error instanceof Error ? error.message : "KAF_EXECUTOR_IMAGE_BOOTSTRAP_FAILED" })}\n`,
  );
  process.exitCode = 1;
}
