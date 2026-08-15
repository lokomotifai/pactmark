import {
  JsonValueSchema,
  ResourceScopeSchema,
  digestCanonicalJson,
  type AcceptedWorkOrder,
  type Digest,
  type JsonValue,
  type PolicyEngine,
  type ResourceScope,
  type ToolCallResolver,
  type ToolRegistrationContract,
} from "@pactmark/core";
import { z } from "zod";

const ResolvedResourcesSchema = z.array(ResourceScopeSchema).min(1).max(256);

export interface ResolvedHostToolCall {
  readonly validatedInput: JsonValue;
  readonly argumentsDigest: Digest;
  readonly resources: readonly ResourceScope[];
  readonly requestedCost?: number;
}

/**
 * Revalidates the host resolver result at the runtime boundary. A resolver is authority-bearing,
 * but it remains an injected adapter and cannot bypass the portable wire contracts.
 */
export async function resolveHostToolCall(
  input: Readonly<{
    resolver: ToolCallResolver;
    workOrder: AcceptedWorkOrder;
    registration: ToolRegistrationContract;
    proposedInput: JsonValue;
  }>,
): Promise<ResolvedHostToolCall> {
  const resolved = await input.resolver.resolve({
    workOrder: input.workOrder,
    registration: input.registration,
    proposedInput: input.proposedInput,
  });
  const validatedInput = JsonValueSchema.parse(resolved.validatedInput);
  const resources = ResolvedResourcesSchema.parse(resolved.resources);
  if (
    resolved.requestedCost !== undefined &&
    (!Number.isFinite(resolved.requestedCost) || resolved.requestedCost < 0)
  ) {
    throw new TypeError("KAF_POLICY_COST_INVALID");
  }
  return Object.freeze({
    validatedInput,
    argumentsDigest: digestCanonicalJson(validatedInput),
    resources: Object.freeze([...resources]),
    ...(resolved.requestedCost === undefined ? {} : { requestedCost: resolved.requestedCost }),
  });
}

export function evaluateHostToolCall(
  input: Readonly<{
    policyEngine: PolicyEngine;
    workOrder: AcceptedWorkOrder;
    registration: ToolRegistrationContract;
    resolvedCall: ResolvedHostToolCall;
    networkPolicy: "none" | "declared" | "enforced";
    callsAlreadyUsed: number;
  }>,
): ReturnType<PolicyEngine["evaluate"]> {
  return input.policyEngine.evaluate({
    workOrder: input.workOrder,
    tool: input.registration,
    argumentsDigest: input.resolvedCall.argumentsDigest,
    resources: input.resolvedCall.resources,
    schemaValidated: true,
    networkPolicy: input.networkPolicy,
    callsAlreadyUsed: input.callsAlreadyUsed,
    ...(input.resolvedCall.requestedCost === undefined
      ? {}
      : { requestedCost: input.resolvedCall.requestedCost }),
  });
}
