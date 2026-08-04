export interface DecisionChallenge {
  readonly challengeProof: string;
  readonly expiresAt: string;
}

/** Short-lived, one-use process memory. It has no persistence or serialization surface. */
export class EphemeralChallengeVault {
  readonly #proofs = new Map<string, DecisionChallenge>();

  put(decisionId: string, challenge: DecisionChallenge): void {
    this.#proofs.set(decisionId, Object.freeze({ ...challenge }));
  }

  consume(decisionId: string, now = Date.now()): DecisionChallenge | undefined {
    const challenge = this.#proofs.get(decisionId);
    this.#proofs.delete(decisionId);
    if (challenge === undefined || Date.parse(challenge.expiresAt) <= now) return undefined;
    return challenge;
  }

  clear(): void {
    this.#proofs.clear();
  }

  has(decisionId: string, now = Date.now()): boolean {
    const challenge = this.#proofs.get(decisionId);
    if (challenge === undefined) return false;
    if (Date.parse(challenge.expiresAt) <= now) {
      this.#proofs.delete(decisionId);
      return false;
    }
    return true;
  }
}
