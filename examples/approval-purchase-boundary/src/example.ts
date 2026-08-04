import { definePolicy } from "@pactmark/agent";
import { digestCanonicalJson } from "@pactmark/core";

export interface PurchaseRequest {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly currency: "USD";
  readonly targetAccount: string;
}

export const purchasePolicy = definePolicy({
  id: "example.purchase.policy",
  implementationVersion: "1.0.0",
  default: "deny",
  rules: [{ riskClass: "R4", decision: "require_approval" }],
});

const dispatchCount = 0;

export function evaluatePurchaseBoundary(request: PurchaseRequest) {
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
    throw new TypeError("KAF_EXAMPLE_PURCHASE_QUANTITY_INVALID");
  }
  if (!Number.isSafeInteger(request.unitPriceMinor) || request.unitPriceMinor <= 0) {
    throw new TypeError("KAF_EXAMPLE_PURCHASE_PRICE_INVALID");
  }
  const preview = Object.freeze({
    operationClass: "external_purchase",
    normalizedTarget: request.targetAccount.trim().toLowerCase(),
    contentDigest: digestCanonicalJson({
      sku: request.sku,
      quantity: request.quantity,
      totalMinor: request.quantity * request.unitPriceMinor,
      currency: request.currency,
    }),
    reversibility: "irreversible",
    materialConsequence: `${String(request.quantity * request.unitPriceMinor)} ${request.currency} minor units would be charged`,
    policyRegistrationDigest: purchasePolicy.policyRegistrationDigest,
  });
  return Object.freeze({
    status: "blocked" as const,
    code: "KAF_EXAMPLE_APPROVAL_SURFACE_UNAVAILABLE" as const,
    preview,
    dispatchCount,
    productionClaim: false,
  });
}

export function observedDispatchCount(): number {
  return dispatchCount;
}
