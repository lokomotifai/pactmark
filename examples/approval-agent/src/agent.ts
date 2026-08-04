import { digestCanonicalJson } from "@pactmark/core";
import type {
  ApprovalPreview,
  CrashBoundary,
  EffectOutcome,
  MessageArguments,
} from "./contract.js";
import { approvalPolicyRegistrationDigest } from "./policy.js";
import { SimulatedMessageReceiver } from "./tools/simulated-message.js";

interface PendingDecision {
  readonly preview: ApprovalPreview;
  readonly challengeDigest: string;
  state: "pending" | "consumed" | "rejected";
  idempotencyKey?: string;
}
export interface DecisionRequest {
  readonly preview: ApprovalPreview;
  readonly challenge: string;
}

export class ApprovalAgentHarness {
  readonly #decisions = new Map<string, PendingDecision>();
  readonly receiver = new SimulatedMessageReceiver();
  #sequence = 0;

  requestDecision(args: MessageArguments, now: Date, ttlMs = 60_000): DecisionRequest {
    validate(args);
    this.#sequence += 1;
    const normalized = normalize(args);
    const decisionId = `decision-${String(this.#sequence)}`;
    const challenge = digestCanonicalJson({
      decisionId,
      nonce: this.#sequence,
      kind: "one-use-fixture",
    });
    const preview = Object.freeze({
      decisionId,
      normalizedTarget: normalized.target,
      contentDigest: digestCanonicalJson(normalized.content),
      argumentsDigest: digestCanonicalJson(normalized),
      policyRegistrationDigest: approvalPolicyRegistrationDigest,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      materialConsequence: `A message would be sent to ${normalized.target}.`,
    });
    this.#decisions.set(decisionId, {
      preview,
      challengeDigest: digestCanonicalJson(challenge),
      state: "pending",
    });
    return { preview, challenge };
  }

  reject(decisionId: string, challenge: string, now: Date): { readonly status: "rejected" } {
    const decision = this.#authorize(decisionId, challenge, now);
    decision.state = "rejected";
    return { status: "rejected" };
  }

  approve(
    decisionId: string,
    challenge: string,
    args: MessageArguments,
    now: Date,
    boundary: CrashBoundary = "none",
  ): EffectOutcome {
    const decision = this.#authorize(decisionId, challenge, now);
    const normalized = normalize(args);
    if (digestCanonicalJson(normalized) !== decision.preview.argumentsDigest) {
      decision.state = "consumed";
      throw new TypeError("KAF_DECISION_BINDING_MISMATCH");
    }
    decision.state = "consumed";
    const idempotencyKey = digestCanonicalJson({
      decisionId,
      argumentsDigest: decision.preview.argumentsDigest,
    });
    decision.idempotencyKey = idempotencyKey;
    if (boundary === "before_dispatch") return { status: "unknown", idempotencyKey, boundary };
    this.receiver.dispatch(idempotencyKey, normalized);
    if (boundary === "after_dispatch") return { status: "unknown", idempotencyKey, boundary };
    return { status: "acknowledged", idempotencyKey, dispatchCount: this.receiver.dispatchCount };
  }

  reconcile(idempotencyKey: string): {
    readonly status: "acknowledged" | "not_dispatched";
    readonly dispatchCount: number;
  } {
    return {
      status: this.receiver.has(idempotencyKey) ? "acknowledged" : "not_dispatched",
      dispatchCount: this.receiver.dispatchCount,
    };
  }

  #authorize(decisionId: string, challenge: string, now: Date): PendingDecision {
    const decision = this.#decisions.get(decisionId);
    if (decision === undefined) throw new TypeError("KAF_DECISION_NOT_FOUND");
    if (decision.state !== "pending") throw new TypeError("KAF_DECISION_REPLAY_DENIED");
    if (Date.parse(decision.preview.expiresAt) <= now.getTime()) {
      decision.state = "consumed";
      throw new TypeError("KAF_DECISION_EXPIRED");
    }
    if (decision.challengeDigest !== digestCanonicalJson(challenge)) {
      decision.state = "consumed";
      throw new TypeError("KAF_DECISION_CHALLENGE_INVALID");
    }
    return decision;
  }
}

function normalize(args: MessageArguments): MessageArguments {
  return Object.freeze({ target: args.target.trim().toLowerCase(), content: args.content });
}
function validate(args: MessageArguments): void {
  if (args.target.trim() === "" || args.content.trim() === "")
    throw new TypeError("KAF_EXAMPLE_MESSAGE_INVALID");
}
