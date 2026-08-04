import { z } from "zod";

import {
  JsonValueSchema,
  type JsonValue,
  type AuthorityContext,
  type Artifact,
  type EvidenceRecord,
  type MigrationManager,
  type RunEvent,
  type RunProjection,
  type RuntimeReadinessProfile,
  type RuntimeReadinessReport,
} from "@pactmark/core";
import type { RuntimeFacade } from "@pactmark/agent";

export interface CliRuntime {
  getRun(authority: AuthorityContext, runId: string): Promise<RunProjection>;
  events(
    authority: AuthorityContext,
    runId: string,
    options?: Readonly<{ afterSequence?: number; signal?: AbortSignal }>,
  ): AsyncIterable<RunEvent>;
  evaluateReadiness(input: Readonly<{ profile: RuntimeReadinessProfile }>): RuntimeReadinessReport;
}

export type CliOperationName =
  | "dev"
  | "run"
  | "test"
  | "eval"
  | "audit.verify"
  | "policy.explain"
  | "effects.reconcile"
  | "effects.compensate";

export interface CliOperationRequest {
  readonly name: CliOperationName;
  readonly arguments: readonly string[];
  readonly input?: JsonValue;
  readonly runId?: string;
  readonly effectId?: string;
}

export const CliOperationResultSchema = z
  .object({
    schemaVersion: z.literal("1"),
    status: z.enum(["completed", "started", "verified", "explained"]),
    summary: z.string().min(1).max(500),
    data: JsonValueSchema.optional(),
  })
  .strict();
export type CliOperationResult = z.infer<typeof CliOperationResultSchema>;

export interface PactmarkCliHost {
  readonly runtime: CliRuntime | Pick<RuntimeFacade, "getRun" | "events" | "evaluateReadiness">;
  readonly authority: AuthorityContext;
  readonly migrationManager?: MigrationManager;
  readonly getEvidence?: (runId: string) => Promise<EvidenceRecord | undefined>;
  readonly readArtifact?: (
    artifactId: string,
  ) => Promise<Readonly<{ artifact: Artifact; content: Uint8Array }> | undefined>;
  readonly probeReadiness?: (
    input: Readonly<{
      profile: RuntimeReadinessProfile;
    }>,
  ) => Promise<readonly CliHostProbe[]>;
  readonly operate?: (request: CliOperationRequest) => Promise<CliOperationResult>;
}

export const CliHostProbeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    status: z.enum(["pass", "warn", "fail"]),
    code: z.string().regex(/^KAF_[A-Z0-9_]+$/),
    safeMessage: z.string().min(1).max(300),
    remediationSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    evidence: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  })
  .strict();
export type CliHostProbe = z.infer<typeof CliHostProbeSchema>;

export interface CompileResult {
  readonly schemaVersion: "1";
  readonly command: "compile";
  readonly manifestPath: string;
  readonly sourceDigest: string;
  readonly instructionBundleDigest: string;
  readonly skillManifestDigests: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly fileCount: number;
  readonly summary: string;
}

export interface CliIo {
  readonly isTty: boolean;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  readTextFile(path: string): Promise<string>;
  resolvePath(path: string): string;
  loadHost(): Promise<PactmarkCliHost | undefined>;
  compileAgentPackage?(): Promise<CompileResult>;
  probeReadiness?(profile: RuntimeReadinessProfile): Promise<readonly CliHostProbe[]>;
}

export interface CliRunResult {
  readonly exitCode: number;
}
