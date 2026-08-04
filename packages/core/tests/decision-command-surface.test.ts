import {
  DecisionApprovalSubmissionSchema,
  DecisionGateSchema,
  DecisionRejectionSchema,
  DecisionRejectionSubmissionSchema,
  TypedInputValidationResultSchema,
  digestCanonicalJson,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const d = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const binding = {
  schemaVersion: "1" as const,
  tenant: { id: "tenant-1" },
  principal: { type: "user" as const, id: "user-1" },
  runId: "run-1",
  stepId: "step-1",
  decisionId: "decision-1",
  workOrderBindingDigest: d("1"),
  executionDefinition: {
    kind: "agent" as const,
    id: "agent-1",
    version: "0.1.0",
    agentDefinitionDigest: d("2"),
  },
  executionDefinitionDigest: d("3"),
  toolId: "mail.send@1",
  toolVersion: "1.0.0",
  toolRegistrationDigest: d("4"),
  argumentsDigest: d("5"),
  targetDigest: d("6"),
  contentDigest: d("7"),
  previewDigest: d("8"),
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  policyRegistrationDigest: d("9"),
};

describe("decision command contracts", () => {
  it("materializes a referential gate digest and strict approve/reject submissions", () => {
    const requestingEventId = "event-1";
    const requiredAuthenticationStrength = "multi_factor" as const;
    const decisionGateDigest = digestCanonicalJson({
      decisionId: binding.decisionId,
      requestingEventId,
      binding,
      requiredAuthenticationStrength,
    });
    expect(
      DecisionGateSchema.parse({
        schemaVersion: "1",
        decisionId: binding.decisionId,
        tenantId: binding.tenant.id,
        runId: binding.runId,
        requestingEventId,
        binding,
        decisionGateDigest,
        requiredAuthenticationStrength,
        createdAt: "2026-08-03T12:00:00.000Z",
      }).decisionGateDigest,
    ).toBe(decisionGateDigest);
    expect(
      DecisionApprovalSubmissionSchema.parse({
        decision: "approve",
        decisionId: binding.decisionId,
        challengeProof: "opaque-proof-value",
      }),
    ).toMatchObject({ decision: "approve" });
    expect(() =>
      DecisionRejectionSubmissionSchema.parse({
        decision: "reject",
        decisionId: binding.decisionId,
        challengeProof: "opaque-proof-value",
        reasonCode: "contains spaces",
      }),
    ).toThrow();
  });

  it("keeps rejections referential and validates typed input as JSON", () => {
    expect(
      DecisionRejectionSchema.parse({
        schemaVersion: "1",
        decisionId: binding.decisionId,
        tenantId: binding.tenant.id,
        runId: binding.runId,
        challengeId: "challenge-1",
        binding,
        rejectedBy: binding.principal,
        authenticationStrength: "multi_factor",
        reasonCode: "operator_rejected",
        rejectedAt: "2026-08-03T12:00:00.000Z",
      }).reasonCode,
    ).toBe("operator_rejected");
    expect(
      TypedInputValidationResultSchema.parse({
        schemaVersion: "1",
        inputSchemaDigest: d("a"),
        value: { answer: 42 },
      }).value,
    ).toEqual({ answer: 42 });
    expect(() =>
      TypedInputValidationResultSchema.parse({
        schemaVersion: "1",
        inputSchemaDigest: d("a"),
        value: Number.NaN,
      }),
    ).toThrow();
  });
});
