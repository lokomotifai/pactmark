import type { Digest } from "@pactmark/core";

export interface PortableRequest {
  readonly sku: string;
}
interface PortableEvent {
  readonly sequence: number;
  readonly type: "RunAccepted" | "ToolCompleted" | "ArtifactCreated" | "RunCompleted";
}
export interface PortableSuccess {
  readonly ok: true;
  readonly events: readonly PortableEvent[];
  readonly toolOutput: { readonly sku: string; readonly name: string; readonly available: boolean };
  readonly artifactDigest: Digest;
  readonly summary: string;
}
interface PortableFailure {
  readonly ok: false;
  readonly errorCode: "KAF_EXAMPLE_INPUT_INVALID" | "KAF_EXAMPLE_SKU_NOT_FOUND";
}
export type PortableResult = PortableSuccess | PortableFailure;
