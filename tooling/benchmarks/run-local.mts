import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packPublishablePackages } from "../consumer/packed-artifacts.mjs";
import { runPackedQuickstartBenchmark } from "./packed-quickstart.mjs";
import { runProjectionBenchmark } from "./projection.mjs";
import { runSlowConsumerBenchmark } from "./slow-consumer.mjs";

const temporary = await mkdtemp(join(tmpdir(), "pactmark-benchmark-artifacts-"));
try {
  const tarballDirectory = join(temporary, "tarballs");
  await packPublishablePackages({
    destination: tarballDirectory,
    npmCacheDirectory: join(temporary, "npm-cache"),
  });
  const result = {
    schemaVersion: "1",
    measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    slowConsumer: await runSlowConsumerBenchmark(),
    projection: runProjectionBenchmark(),
    packedQuickstart: await runPackedQuickstartBenchmark({ tarballDirectory }),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
