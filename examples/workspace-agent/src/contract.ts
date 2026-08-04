export interface WorkspaceBudget {
  readonly maxCommands: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}
export interface DraftArtifact {
  readonly path: string;
  readonly contentDigest: Digest;
  readonly byteSize: number;
  readonly status: "draft";
}
export interface SandboxAdapterContract {
  readonly adapterKind: string;
  readonly network: "none";
  readonly nonRoot: true;
  readonly productionIsolationClaim: false;
}
import type { Digest } from "@pactmark/core";
