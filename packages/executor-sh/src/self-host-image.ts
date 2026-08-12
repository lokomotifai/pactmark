import { z } from "zod";

import type { Digest } from "@pactmark/core";

export const EXECUTOR_SELF_HOST_VERSION = "1.5.40" as const;
export const EXECUTOR_SELF_HOST_SOURCE_REVISION =
  "b029643641832ef5f9b0d4ff263d96e1a5b2739c" as const;
export const EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST =
  "sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88" as const;
export const EXECUTOR_SELF_HOST_IMAGE_REPOSITORY =
  "ghcr.io/usefulsoftwareco/executor-selfhost" as const;
export const EXECUTOR_SELF_HOST_IMAGE =
  `${EXECUTOR_SELF_HOST_IMAGE_REPOSITORY}@${EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST}` as const;

export const ExecutorSelfHostPlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
export type ExecutorSelfHostPlatform = z.infer<typeof ExecutorSelfHostPlatformSchema>;

const manifestDigests = Object.freeze({
  "linux/amd64": "sha256:2f6cc4e03470b1eca58f4cec08b99d3195fbffa07e4c626cf89cc328a74504d4",
  "linux/arm64": "sha256:603522956d12788f9b50badd83e339ff5ab75486b4c16e4f10f46b6d0b49ee5b",
} satisfies Readonly<Record<ExecutorSelfHostPlatform, Digest>>);

export function executorSelfHostManifestDigest(platform: ExecutorSelfHostPlatform): Digest {
  return manifestDigests[ExecutorSelfHostPlatformSchema.parse(platform)];
}
