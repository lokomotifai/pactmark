import {
  ApprovalSchema,
  DecisionGateSchema,
  DecisionRejectionSchema,
  DecisionSubmissionChallengeSchema,
  KafError,
  canonicalJsonStringify,
  type Approval,
  type DecisionGate,
  type DecisionRejection,
  type DecisionStore,
  type DecisionSubmissionChallenge,
} from "@pactmark/core";

const gateKey = (tenantId: string, runId: string, decisionId: string): string =>
  canonicalJsonStringify([tenantId, runId, decisionId]);

type DecisionStoreSnapshot = Readonly<{
  gates: Map<string, DecisionGate>;
  challenges: Map<string, DecisionSubmissionChallenge>;
  activeChallenges: Map<string, string>;
  approvals: Map<string, Approval>;
  rejections: Map<string, DecisionRejection>;
}>;

export class MemoryDecisionStore implements DecisionStore {
  readonly #gates = new Map<string, DecisionGate>();
  readonly #challenges = new Map<string, DecisionSubmissionChallenge>();
  readonly #activeChallenges = new Map<string, string>();
  readonly #approvals = new Map<string, Approval>();
  readonly #rejections = new Map<string, DecisionRejection>();

  async putGateOnce(input: DecisionGate): Promise<DecisionGate> {
    await Promise.resolve();
    const gate = DecisionGateSchema.parse(input);
    if (
      gate.tenantId !== gate.binding.tenant.id ||
      gate.runId !== gate.binding.runId ||
      gate.decisionId !== gate.binding.decisionId
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "decision_gate_binding_changed" },
      });
    }
    const key = gateKey(gate.tenantId, gate.runId, gate.decisionId);
    const existing = this.#gates.get(key);
    if (existing !== undefined) {
      if (canonicalJsonStringify(existing) === canonicalJsonStringify(gate)) return existing;
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "decision_gate_changed" },
      });
    }
    this.#gates.set(key, gate);
    return gate;
  }

  async getGate(
    tenantId: string,
    runId: string,
    decisionId: string,
  ): Promise<DecisionGate | undefined> {
    await Promise.resolve();
    return this.#gates.get(gateKey(tenantId, runId, decisionId));
  }

  async putChallenge(input: DecisionSubmissionChallenge): Promise<void> {
    await Promise.resolve();
    const challenge = DecisionSubmissionChallengeSchema.parse(input);
    const key = gateKey(
      challenge.binding.tenant.id,
      challenge.binding.runId,
      challenge.binding.decisionId,
    );
    const challengeKey = gateKey(
      challenge.binding.tenant.id,
      challenge.binding.runId,
      challenge.id,
    );
    const collidingChallenge = [...this.#challenges.values()].find(
      (stored) =>
        stored.binding.tenant.id === challenge.binding.tenant.id &&
        stored.id === challenge.id &&
        stored.binding.runId !== challenge.binding.runId,
    );
    if (collidingChallenge !== undefined) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "decision_challenge_id_changed_run" },
      });
    }
    const existing = this.#challenges.get(challengeKey);
    if (
      existing !== undefined &&
      canonicalJsonStringify(existing) !== canonicalJsonStringify(challenge)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "decision_challenge_changed" },
      });
    }
    this.#challenges.set(challengeKey, challenge);
    this.#activeChallenges.set(key, challengeKey);
  }

  async getActiveChallenge(
    tenantId: string,
    runId: string,
    decisionId: string,
  ): Promise<DecisionSubmissionChallenge | undefined> {
    await Promise.resolve();
    const challengeKey = this.#activeChallenges.get(gateKey(tenantId, runId, decisionId));
    return challengeKey === undefined ? undefined : this.#challenges.get(challengeKey);
  }

  async consumeChallenge(
    challengeId: string,
    commandId: string,
    consumedAt: string,
    expectedTenantId?: string,
  ): Promise<void> {
    await Promise.resolve();
    const matches = [...this.#challenges.entries()].filter(
      ([, challenge]) =>
        challenge.id === challengeId &&
        (expectedTenantId === undefined || challenge.binding.tenant.id === expectedTenantId),
    );
    if (matches.length !== 1) throw new KafError("KAF_STORAGE_NOT_FOUND");
    const match = matches[0];
    if (match === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    const [challengeKey, challenge] = match;
    if (expectedTenantId !== undefined && challenge.binding.tenant.id !== expectedTenantId) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "cross_tenant_decision_challenge" },
      });
    }
    const key = gateKey(
      challenge.binding.tenant.id,
      challenge.binding.runId,
      challenge.binding.decisionId,
    );
    if (this.#activeChallenges.get(key) !== challengeKey) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "decision_challenge_replaced" },
      });
    }
    if (challenge.consumingCommandId !== undefined) {
      if (challenge.consumingCommandId === commandId) return;
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "decision_challenge_used" },
      });
    }
    if (Date.parse(challenge.expiresAt) <= Date.parse(consumedAt)) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "decision_challenge_expired" },
      });
    }
    this.#challenges.set(
      challengeKey,
      DecisionSubmissionChallengeSchema.parse({
        ...challenge,
        consumingCommandId: commandId,
        consumedAt,
      }),
    );
  }

  async putApproval(input: Approval): Promise<void> {
    await Promise.resolve();
    const approval = ApprovalSchema.parse(input);
    const challenges = [...this.#challenges.values()].filter(
      (challenge) =>
        challenge.binding.tenant.id === approval.binding.tenant.id &&
        challenge.id === approval.challengeId,
    );
    const challenge = challenges.length === 1 ? challenges[0] : undefined;
    if (
      challenge === undefined ||
      challenge.consumingCommandId === undefined ||
      approval.challengeProofDigest !== challenge.proofDigest ||
      canonicalJsonStringify(approval.binding) !== canonicalJsonStringify(challenge.binding)
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "approval_challenge_binding_mismatch" },
      });
    }
    const key = gateKey(approval.binding.tenant.id, approval.binding.runId, approval.id);
    const existing = this.#approvals.get(key);
    if (
      existing !== undefined &&
      canonicalJsonStringify(existing) !== canonicalJsonStringify(approval)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
    }
    this.#approvals.set(key, approval);
  }

  async getApproval(tenantId: string, approvalId: string): Promise<Approval | undefined> {
    await Promise.resolve();
    for (const approval of this.#approvals.values()) {
      if (approval.binding.tenant.id === tenantId && approval.id === approvalId) return approval;
    }
    return undefined;
  }

  async putRejection(input: DecisionRejection): Promise<void> {
    await Promise.resolve();
    const rejection = DecisionRejectionSchema.parse(input);
    const key = gateKey(rejection.tenantId, rejection.runId, rejection.decisionId);
    const existing = this.#rejections.get(key);
    if (
      existing !== undefined &&
      canonicalJsonStringify(existing) !== canonicalJsonStringify(rejection)
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT");
    }
    this.#rejections.set(key, rejection);
  }

  transactionSnapshot(): DecisionStoreSnapshot {
    return {
      gates: structuredClone(this.#gates),
      challenges: structuredClone(this.#challenges),
      activeChallenges: structuredClone(this.#activeChallenges),
      approvals: structuredClone(this.#approvals),
      rejections: structuredClone(this.#rejections),
    };
  }

  transactionRestore(snapshot: DecisionStoreSnapshot): void {
    replaceMap(this.#gates, snapshot.gates);
    replaceMap(this.#challenges, snapshot.challenges);
    replaceMap(this.#activeChallenges, snapshot.activeChallenges);
    replaceMap(this.#approvals, snapshot.approvals);
    replaceMap(this.#rejections, snapshot.rejections);
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
