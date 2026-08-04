import { describe, expect, it } from "vitest";
import { ApprovalAgentHarness } from "../src/agent.js";
import { previewMatches } from "../src/verifiers/preview.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const args = { target: " Team-Alerts ", content: "Fixture release is ready for review." };
describe("approval agent", () => {
  it("binds and approves the exact preview once", () => {
    const agent = new ApprovalAgentHarness();
    const { preview, challenge } = agent.requestDecision(args, now);
    expect(previewMatches(preview, args)).toBe(true);
    expect(preview).toMatchObject({
      normalizedTarget: "team-alerts",
      materialConsequence: "A message would be sent to team-alerts.",
    });
    expect(agent.approve(preview.decisionId, challenge, args, now)).toMatchObject({
      status: "acknowledged",
      dispatchCount: 1,
    });
    expect(() => agent.approve(preview.decisionId, challenge, args, now)).toThrow(
      "KAF_DECISION_REPLAY_DENIED",
    );
  });
  it("supports rejection, expiry, mutation denial, and invalid challenge denial", () => {
    const rejected = new ApprovalAgentHarness();
    const r = rejected.requestDecision(args, now);
    expect(rejected.reject(r.preview.decisionId, r.challenge, now).status).toBe("rejected");
    expect(rejected.receiver.dispatchCount).toBe(0);
    const expired = new ApprovalAgentHarness();
    const e = expired.requestDecision(args, now, 1);
    expect(() =>
      expired.approve(e.preview.decisionId, e.challenge, args, new Date(now.getTime() + 1)),
    ).toThrow("KAF_DECISION_EXPIRED");
    const changed = new ApprovalAgentHarness();
    const c = changed.requestDecision(args, now);
    expect(() =>
      changed.approve(c.preview.decisionId, c.challenge, { ...args, content: "changed" }, now),
    ).toThrow("KAF_DECISION_BINDING_MISMATCH");
    expect(changed.receiver.dispatchCount).toBe(0);
    const invalid = new ApprovalAgentHarness();
    const i = invalid.requestDecision(args, now);
    expect(() => invalid.approve(i.preview.decisionId, "wrong", args, now)).toThrow(
      "KAF_DECISION_CHALLENGE_INVALID",
    );
  });
  it("reconciles crash boundaries without repeating an effect", () => {
    const before = new ApprovalAgentHarness();
    const b = before.requestDecision(args, now);
    const bu = before.approve(b.preview.decisionId, b.challenge, args, now, "before_dispatch");
    expect(bu.status).toBe("unknown");
    if (bu.status === "unknown")
      expect(before.reconcile(bu.idempotencyKey)).toEqual({
        status: "not_dispatched",
        dispatchCount: 0,
      });
    const after = new ApprovalAgentHarness();
    const a = after.requestDecision(args, now);
    const au = after.approve(a.preview.decisionId, a.challenge, args, now, "after_dispatch");
    expect(au.status).toBe("unknown");
    if (au.status === "unknown") {
      expect(after.reconcile(au.idempotencyKey)).toEqual({
        status: "acknowledged",
        dispatchCount: 1,
      });
      expect(after.reconcile(au.idempotencyKey).dispatchCount).toBe(1);
    }
  });
});
