import { digestCanonicalJson } from "@pactmark/core";
const approvalPolicy = Object.freeze({
  id: "example.message.policy",
  version: "1.0.0",
  default: "deny" as const,
  riskClass: "R4" as const,
  decision: "require_approval" as const,
});
export const approvalPolicyRegistrationDigest = digestCanonicalJson(approvalPolicy);
