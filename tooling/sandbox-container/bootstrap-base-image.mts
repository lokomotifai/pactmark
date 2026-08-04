import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { sandboxBaseImageReference, sandboxBaseImageRepoDigest } from "./conformance.mjs";

const execute = promisify(execFile);

try {
  await execute("docker", ["pull", sandboxBaseImageReference], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const inspected = await execute(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoDigests}}", sandboxBaseImageReference],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const repoDigests: unknown = JSON.parse(inspected.stdout);
  if (!Array.isArray(repoDigests) || !repoDigests.includes(sandboxBaseImageRepoDigest)) {
    throw new Error("KAF_SANDBOX_BASE_IMAGE_DIGEST_INVALID");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: "1",
        action: "sandbox_base_image_bootstrap",
        reference: sandboxBaseImageReference,
        repoDigest: sandboxBaseImageRepoDigest,
        retainedForOfflineConformance: true,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const code = error instanceof Error ? error.message : "KAF_SANDBOX_BASE_IMAGE_BOOTSTRAP_FAILED";
  process.stderr.write(`${JSON.stringify({ code })}\n`);
  process.exitCode = 1;
}
