import {
  ApprovalSchema,
  CapabilityGrantSchema,
  CapabilityGrantUseClaimSchema,
  DecisionGateSchema,
  DecisionRejectionSchema,
  DecisionSubmissionChallengeSchema,
  KafError,
  canonicalJsonStringify,
  digestCanonicalJson,
  type Approval,
  type ApprovalUseClaim,
  type CapabilityGrant,
  type CapabilityGrantUseClaim,
  type DecisionGate,
  type DecisionRejection,
  type DecisionSubmissionChallenge,
} from "@pactmark/core";

import type { PostgresClient } from "./database.js";
import { conflict, parseJsonColumn } from "./internal.js";

type GrantRow = { grant_json: unknown; remaining_uses: string | number };
type GateRow = { gate_json: unknown };
type ChallengeRow = { challenge_json: unknown };
type ApprovalRow = { approval_json: unknown };

export async function issueCapabilityGrant(
  client: PostgresClient,
  tenantId: string,
  input: CapabilityGrant,
): Promise<void> {
  const grant = CapabilityGrantSchema.parse(input);
  if (grant.tenant.id !== tenantId) conflict("cross_tenant_capability_grant");
  const prior = await client.query<GrantRow>(
    "SELECT grant_json,remaining_uses FROM pactmark_capability_grants WHERE tenant_id=$1 AND grant_id=$2 FOR UPDATE",
    [tenantId, grant.id],
  );
  const existing = prior.rows[0];
  if (existing !== undefined) {
    const stored = CapabilityGrantSchema.parse(parseJsonColumn(existing.grant_json));
    if (canonicalJsonStringify(stored) === canonicalJsonStringify(grant)) return;
    conflict("capability_grant_changed");
  }
  await client.query(
    `INSERT INTO pactmark_capability_grants
     (tenant_id,grant_id,issuer_id,principal_id,work_order_id,execution_definition_digest,
      tool_digest,resource_digest,purpose_code,expires_at,remaining_uses,revoked_at,
      work_order_binding_digest,canonical_digest,grant_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::timestamptz,$13,$14,$15::jsonb)`,
    [
      tenantId,
      grant.id,
      grant.issuerId,
      grant.principal.id,
      grant.workOrderId,
      grant.executionDefinitionDigest,
      grant.toolRegistrationDigest,
      digestCanonicalJson(grant.normalizedResources),
      grant.purpose.code,
      grant.expiresAt,
      grant.maximumUses,
      grant.revokedAt ?? null,
      grant.workOrderBindingDigest,
      digestCanonicalJson(grant),
      JSON.stringify(grant),
    ],
  );
}

export async function reserveCapabilityGrantUse(
  client: PostgresClient,
  tenantId: string,
  grantId: string,
  authorizationKey: string,
  at: string,
): Promise<CapabilityGrantUseClaim> {
  const priorClaim = await client.query<{
    use_number: string | number;
    claimed_at: string | Date;
  }>(
    `SELECT use_number,claimed_at FROM pactmark_capability_grant_use_claims
     WHERE tenant_id=$1 AND grant_id=$2 AND authorization_key=$3 FOR UPDATE`,
    [tenantId, grantId, authorizationKey],
  );
  const existingClaim = priorClaim.rows[0];
  if (existingClaim !== undefined) {
    return CapabilityGrantUseClaimSchema.parse({
      schemaVersion: "1",
      grantId,
      authorizationKey,
      useNumber: Number(existingClaim.use_number),
      claimedAt: toInstant(existingClaim.claimed_at),
    });
  }
  const grants = await client.query<GrantRow>(
    `SELECT grant_json,remaining_uses FROM pactmark_capability_grants
     WHERE tenant_id=$1 AND grant_id=$2 FOR UPDATE`,
    [tenantId, grantId],
  );
  const row = grants.rows[0];
  if (row === undefined) authorizationConflict("capability_grant_missing");
  const grant = CapabilityGrantSchema.parse(parseJsonColumn(row.grant_json));
  const remaining = Number(row.remaining_uses);
  if (
    grant.revokedAt !== undefined ||
    Date.parse(grant.expiresAt) <= Date.parse(at) ||
    remaining <= 0
  ) {
    authorizationConflict("capability_grant_unavailable");
  }
  const useNumber = grant.maximumUses - remaining + 1;
  await client.query(
    "UPDATE pactmark_capability_grants SET remaining_uses=remaining_uses-1 WHERE tenant_id=$1 AND grant_id=$2 AND remaining_uses > 0",
    [tenantId, grantId],
  );
  await client.query(
    `INSERT INTO pactmark_capability_grant_use_claims
     (tenant_id,grant_id,authorization_key,use_number,claimed_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz)`,
    [tenantId, grantId, authorizationKey, useNumber, at],
  );
  return CapabilityGrantUseClaimSchema.parse({
    schemaVersion: "1",
    grantId,
    authorizationKey,
    useNumber,
    claimedAt: at,
  });
}

export async function putDecisionGate(
  client: PostgresClient,
  tenantId: string,
  input: DecisionGate,
): Promise<void> {
  const gate = DecisionGateSchema.parse(input);
  if (
    gate.tenantId !== tenantId ||
    gate.binding.tenant.id !== tenantId ||
    gate.runId !== gate.binding.runId ||
    gate.decisionId !== gate.binding.decisionId
  ) {
    conflict("cross_tenant_decision_gate");
  }
  const prior = await client.query<GateRow>(
    `SELECT gate_json FROM pactmark_decision_gates
     WHERE tenant_id=$1 AND run_id=$2 AND decision_id=$3 FOR UPDATE`,
    [tenantId, gate.runId, gate.decisionId],
  );
  if (prior.rows[0] !== undefined) {
    const stored = DecisionGateSchema.parse(parseJsonColumn(prior.rows[0].gate_json));
    if (canonicalJsonStringify(stored) === canonicalJsonStringify(gate)) return;
    conflict("decision_gate_changed");
  }
  await client.query(
    `INSERT INTO pactmark_decision_gates
     (tenant_id,run_id,decision_id,decision_gate_digest,gate_json,created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
    [
      tenantId,
      gate.runId,
      gate.decisionId,
      gate.decisionGateDigest,
      JSON.stringify(gate),
      gate.createdAt,
    ],
  );
}

export async function putDecisionChallenge(
  client: PostgresClient,
  tenantId: string,
  input: DecisionSubmissionChallenge,
): Promise<void> {
  const challenge = DecisionSubmissionChallengeSchema.parse(input);
  if (challenge.binding.tenant.id !== tenantId) conflict("cross_tenant_decision_challenge");
  if (challenge.consumingCommandId !== undefined || challenge.consumedAt !== undefined) {
    conflict("decision_challenge_already_consumed_at_issue");
  }
  const prior = await client.query<ChallengeRow>(
    `SELECT challenge_json FROM pactmark_decision_challenges
     WHERE tenant_id=$1 AND challenge_id=$2 FOR UPDATE`,
    [tenantId, challenge.id],
  );
  if (prior.rows[0] !== undefined) {
    const stored = DecisionSubmissionChallengeSchema.parse(
      parseJsonColumn(prior.rows[0].challenge_json),
    );
    if (canonicalJsonStringify(stored) === canonicalJsonStringify(challenge)) return;
    conflict("decision_challenge_changed");
  }
  await client.query(
    `INSERT INTO pactmark_decision_challenges
     (tenant_id,run_id,challenge_id,binding_digest,expires_at,consumed_at,
      consuming_command_id,canonical_digest,challenge_json)
     VALUES ($1,$2,$3,$4,$5::timestamptz,NULL,NULL,$6,$7::jsonb)`,
    [
      tenantId,
      challenge.binding.runId,
      challenge.id,
      digestCanonicalJson(challenge.binding),
      challenge.expiresAt,
      digestCanonicalJson(challenge),
      JSON.stringify(challenge),
    ],
  );
}

export async function consumeDecisionChallenge(
  client: PostgresClient,
  tenantId: string,
  challengeId: string,
  commandId: string,
  consumedAt: string,
): Promise<void> {
  const prior = await client.query<ChallengeRow>(
    `SELECT challenge_json FROM pactmark_decision_challenges
     WHERE tenant_id=$1 AND challenge_id=$2 FOR UPDATE`,
    [tenantId, challengeId],
  );
  const row = prior.rows[0];
  if (row === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
  const challenge = DecisionSubmissionChallengeSchema.parse(parseJsonColumn(row.challenge_json));
  if (challenge.binding.tenant.id !== tenantId) conflict("cross_tenant_decision_challenge");
  if (challenge.consumingCommandId !== undefined) {
    if (challenge.consumingCommandId === commandId) return;
    authorizationConflict("decision_challenge_used");
  }
  if (Date.parse(challenge.expiresAt) <= Date.parse(consumedAt)) {
    authorizationConflict("decision_challenge_expired");
  }
  const consumed = DecisionSubmissionChallengeSchema.parse({
    ...challenge,
    consumingCommandId: commandId,
    consumedAt,
  });
  await client.query(
    `UPDATE pactmark_decision_challenges
     SET consumed_at=$1::timestamptz,consuming_command_id=$2,
       canonical_digest=$3,challenge_json=$4::jsonb
     WHERE tenant_id=$5 AND run_id=$6 AND challenge_id=$7`,
    [
      consumedAt,
      commandId,
      digestCanonicalJson(consumed),
      JSON.stringify(consumed),
      tenantId,
      challenge.binding.runId,
      challenge.id,
    ],
  );
}

export async function putApproval(
  client: PostgresClient,
  tenantId: string,
  input: Approval,
): Promise<void> {
  const approval = ApprovalSchema.parse(input);
  if (approval.binding.tenant.id !== tenantId) conflict("cross_tenant_approval");
  const challengeResult = await client.query<ChallengeRow>(
    `SELECT challenge_json FROM pactmark_decision_challenges
     WHERE tenant_id=$1 AND challenge_id=$2 FOR UPDATE`,
    [tenantId, approval.challengeId],
  );
  const challengeRow = challengeResult.rows[0];
  if (challengeRow === undefined) authorizationConflict("approval_challenge_missing");
  const challenge = DecisionSubmissionChallengeSchema.parse(
    parseJsonColumn(challengeRow.challenge_json),
  );
  if (
    challenge.consumingCommandId === undefined ||
    approval.challengeProofDigest !== challenge.proofDigest ||
    canonicalJsonStringify(approval.binding) !== canonicalJsonStringify(challenge.binding)
  ) {
    authorizationConflict("approval_challenge_binding_mismatch");
  }
  const prior = await client.query<ApprovalRow>(
    "SELECT approval_json FROM pactmark_approvals WHERE tenant_id=$1 AND approval_id=$2 FOR UPDATE",
    [tenantId, approval.id],
  );
  if (prior.rows[0] !== undefined) {
    const stored = ApprovalSchema.parse(parseJsonColumn(prior.rows[0].approval_json));
    if (canonicalJsonStringify(stored) === canonicalJsonStringify(approval)) return;
    conflict("approval_changed");
  }
  await client.query(
    `INSERT INTO pactmark_approvals
     (tenant_id,run_id,approval_id,decision_id,binding_digest,expires_at,used_at,use_claim_id,
      canonical_digest,challenge_proof_digest,maximum_uses,approval_json)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,NULL,NULL,$7,$8,1,$9::jsonb)`,
    [
      tenantId,
      approval.binding.runId,
      approval.id,
      approval.binding.decisionId,
      digestCanonicalJson(approval.binding),
      approval.expiresAt,
      digestCanonicalJson(approval),
      approval.challengeProofDigest,
      JSON.stringify(approval),
    ],
  );
}

export async function putDecisionRejection(
  client: PostgresClient,
  tenantId: string,
  input: DecisionRejection,
): Promise<void> {
  const rejection = DecisionRejectionSchema.parse(input);
  if (rejection.tenantId !== tenantId || rejection.binding.tenant.id !== tenantId) {
    conflict("cross_tenant_decision_rejection");
  }
  await client.query(
    `INSERT INTO pactmark_decisions
     (tenant_id,run_id,decision_id,challenge_id,canonical_digest,decision_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (tenant_id,run_id,decision_id) DO NOTHING`,
    [
      tenantId,
      rejection.runId,
      rejection.decisionId,
      rejection.challengeId,
      digestCanonicalJson(rejection),
      JSON.stringify(rejection),
    ],
  );
}

export async function claimApproval(
  client: PostgresClient,
  tenantId: string,
  approvalId: string,
  authorizationKey: string,
  at: string,
): Promise<ApprovalUseClaim> {
  const prior = await client.query<{ authorization_key: string; claimed_at: string | Date }>(
    `SELECT authorization_key,claimed_at FROM pactmark_approval_use_claims
     WHERE tenant_id=$1 AND approval_id=$2 FOR UPDATE`,
    [tenantId, approvalId],
  );
  if (prior.rows[0] !== undefined) {
    if (prior.rows[0].authorization_key !== authorizationKey) {
      authorizationConflict("approval_already_used");
    }
    return {
      schemaVersion: "1",
      approvalId,
      authorizationKey,
      claimedAt: toInstant(prior.rows[0].claimed_at),
    };
  }
  const approvalResult = await client.query<ApprovalRow>(
    "SELECT approval_json FROM pactmark_approvals WHERE tenant_id=$1 AND approval_id=$2 FOR UPDATE",
    [tenantId, approvalId],
  );
  const row = approvalResult.rows[0];
  if (row === undefined) authorizationConflict("approval_missing");
  const approval = ApprovalSchema.parse(parseJsonColumn(row.approval_json));
  if (Date.parse(approval.expiresAt) <= Date.parse(at)) authorizationConflict("approval_expired");
  await client.query(
    `INSERT INTO pactmark_approval_use_claims
     (tenant_id,approval_id,authorization_key,claimed_at) VALUES ($1,$2,$3,$4::timestamptz)`,
    [tenantId, approvalId, authorizationKey, at],
  );
  return { schemaVersion: "1", approvalId, authorizationKey, claimedAt: at };
}

function authorizationConflict(reason: string): never {
  throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", { details: { reason } });
}

function toInstant(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
