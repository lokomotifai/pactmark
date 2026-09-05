import { z } from "zod";

import { ExecutionDefinitionRefSchema } from "./agent.js";
import type { AuthorityContext } from "./authority.js";
import { AuthenticationStrengthSchema, PrincipalSchema, TenantSchema } from "./authority.js";
import type { CommandContext } from "./commands.js";
import { DigestSchema, JsonValueSchema } from "./serialization.js";
import { ApprovalPreviewDisplaySchema } from "./tool.js";
import { PurposeSchema } from "./work-order.js";

export const ProposedEffectBindingSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenant: TenantSchema,
    principal: PrincipalSchema,
    runId: z.string().trim().min(1).max(256),
    stepId: z.string().trim().min(1).max(256),
    decisionId: z.string().trim().min(1).max(256),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    toolId: z.string().trim().min(1).max(256),
    toolVersion: z.string().trim().min(1).max(128),
    toolRegistrationDigest: DigestSchema,
    argumentsDigest: DigestSchema,
    targetDigest: DigestSchema,
    contentDigest: DigestSchema.optional(),
    previewDigest: DigestSchema,
    purpose: PurposeSchema,
    policyRegistrationDigest: DigestSchema,
  })
  .strict();
export type ProposedEffectBinding = z.infer<typeof ProposedEffectBindingSchema>;

export const DecisionGateSchema = z
  .object({
    schemaVersion: z.literal("1"),
    decisionId: z.string().trim().min(1).max(256),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    requestingEventId: z.string().trim().min(1).max(256),
    binding: ProposedEffectBindingSchema,
    decisionGateDigest: DigestSchema,
    requiredAuthenticationStrength: AuthenticationStrengthSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DecisionGate = z.infer<typeof DecisionGateSchema>;

export const DecisionApprovalSubmissionSchema = z
  .object({
    decision: z.literal("approve"),
    decisionId: z.string().trim().min(1).max(256),
    challengeProof: z.string().min(16).max(4096),
  })
  .strict();
export type DecisionApprovalSubmission = z.infer<typeof DecisionApprovalSubmissionSchema>;

export const DecisionRejectionSubmissionSchema = z
  .object({
    decision: z.literal("reject"),
    decisionId: z.string().trim().min(1).max(256),
    challengeProof: z.string().min(16).max(4096),
    reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_:-]{0,127}$/u),
  })
  .strict();
export type DecisionRejectionSubmission = z.infer<typeof DecisionRejectionSubmissionSchema>;

export const DecisionRejectionSchema = z
  .object({
    schemaVersion: z.literal("1"),
    decisionId: z.string().trim().min(1).max(256),
    tenantId: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    challengeId: z.string().trim().min(1).max(256),
    binding: ProposedEffectBindingSchema,
    rejectedBy: PrincipalSchema,
    authenticationStrength: AuthenticationStrengthSchema,
    reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_:-]{0,127}$/u),
    rejectedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DecisionRejection = z.infer<typeof DecisionRejectionSchema>;

export const TypedInputValidationResultSchema = z
  .object({
    schemaVersion: z.literal("1"),
    inputSchemaDigest: DigestSchema,
    value: JsonValueSchema,
  })
  .strict();
export type TypedInputValidationResult = z.infer<typeof TypedInputValidationResultSchema>;

export const DecisionPreviewReferenceSchema = z
  .object({
    schemaVersion: z.literal("1"),
    previewDigest: DigestSchema,
    contentDigest: DigestSchema.optional(),
    approvalDisplay: ApprovalPreviewDisplaySchema.optional(),
  })
  .strict();
export type DecisionPreviewReference = z.infer<typeof DecisionPreviewReferenceSchema>;

/** Host registration that renders an executable strategy's exact, deterministic preview. */
export interface DecisionPreviewer {
  preview(
    input: Readonly<{
      tenantId: string;
      runId: string;
      stepId: string;
      decisionId: string;
      toolRegistrationDigest: string;
      argumentsDigest: string;
      targetDigest: string;
      value: unknown;
    }>,
  ): Promise<DecisionPreviewReference>;
}

export const DecisionSubmissionChallengeSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().trim().min(1).max(256),
    issuerId: z.string().trim().min(1).max(256),
    proofDigest: DigestSchema,
    binding: ProposedEffectBindingSchema,
    requiredAuthenticationStrength: AuthenticationStrengthSchema,
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    consumingCommandId: z.string().trim().min(1).max(256).optional(),
    consumedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type DecisionSubmissionChallenge = z.infer<typeof DecisionSubmissionChallengeSchema>;

export const ApprovalSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().trim().min(1).max(256),
    issuerId: z.string().trim().min(1).max(256),
    challengeId: z.string().trim().min(1).max(256),
    challengeProofDigest: DigestSchema,
    binding: ProposedEffectBindingSchema,
    approvedBy: PrincipalSchema,
    authenticationStrength: AuthenticationStrengthSchema,
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    maximumUses: z.literal(1),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalUseClaimSchema = z
  .object({
    schemaVersion: z.literal("1"),
    approvalId: z.string().trim().min(1).max(256),
    authorizationKey: z.string().trim().min(1).max(512),
    claimedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ApprovalUseClaim = z.infer<typeof ApprovalUseClaimSchema>;

export const DecisionChallengeIssueRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    binding: ProposedEffectBindingSchema,
    requiredAuthenticationStrength: AuthenticationStrengthSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DecisionChallengeIssueRequest = z.infer<typeof DecisionChallengeIssueRequestSchema>;

export type IssuedDecisionChallenge = Readonly<{
  challenge: DecisionSubmissionChallenge;
  challengeProof: string;
}>;

export interface DecisionChallengeIssuer {
  issue(
    authority: AuthorityContext,
    request: DecisionChallengeIssueRequest,
    command: CommandContext,
  ): Promise<IssuedDecisionChallenge>;
  verify(
    authority: AuthorityContext,
    challengeProof: string,
    binding: ProposedEffectBinding,
    command: CommandContext,
  ): Promise<DecisionSubmissionChallenge>;
  createApproval(
    authority: AuthorityContext,
    challenge: DecisionSubmissionChallenge,
    command: CommandContext,
  ): Promise<Approval>;
}

/** Read/write state is tenant scoped; command writes must be called through RunCommandUnitOfWork. */
export interface DecisionStore {
  putGateOnce(gate: DecisionGate): Promise<DecisionGate>;
  getGate(tenantId: string, runId: string, decisionId: string): Promise<DecisionGate | undefined>;
  putChallenge(challenge: DecisionSubmissionChallenge): Promise<void>;
  getActiveChallenge(
    tenantId: string,
    runId: string,
    decisionId: string,
  ): Promise<DecisionSubmissionChallenge | undefined>;
  consumeChallenge(
    tenantId: string,
    challengeId: string,
    commandId: string,
    consumedAt: string,
  ): Promise<void>;
  putApproval(approval: Approval): Promise<void>;
  getApproval(tenantId: string, approvalId: string): Promise<Approval | undefined>;
  putRejection(rejection: DecisionRejection): Promise<void>;
}

/** Host-owned parser registry for exact persisted input SchemaIdentity digests. */
export interface TypedInputRegistry {
  validate(inputSchemaDigest: string, value: unknown): TypedInputValidationResult;
}
