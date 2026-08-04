export interface MessageArguments {
  readonly target: string;
  readonly content: string;
}
export interface ApprovalPreview {
  readonly decisionId: string;
  readonly normalizedTarget: string;
  readonly contentDigest: Digest;
  readonly argumentsDigest: Digest;
  readonly policyRegistrationDigest: Digest;
  readonly expiresAt: string;
  readonly materialConsequence: string;
}
export type CrashBoundary = "none" | "before_dispatch" | "after_dispatch";
export type EffectOutcome =
  | {
      readonly status: "acknowledged";
      readonly idempotencyKey: string;
      readonly dispatchCount: number;
    }
  | {
      readonly status: "unknown";
      readonly idempotencyKey: string;
      readonly boundary: Exclude<CrashBoundary, "none">;
    };
import type { Digest } from "@pactmark/core";
