import type { Digest, JsonValue, ToolSecurity } from "@pactmark/core";
import type { MCPConnection } from "@pactmark/mcp";

import {
  createExecutorToolExecutor,
  defineExecutorDeploymentProfile,
  defineExecutorToolPin,
  type ExecutorSelfHostConformanceReceipt,
  type ExecutorToolExecutor,
} from "@pactmark/executor-sh";

export function createReviewedExecutorReadTool(input: {
  readonly connection: MCPConnection;
  readonly executeToolRegistrationDigest: Digest;
  readonly conformanceReceipt: ExecutorSelfHostConformanceReceipt;
  readonly evaluatedAt: string;
  readonly tenantId: string;
  readonly executorOrigin: string;
  readonly opaqueConnectionRef: string;
  readonly backupPolicyId: string;
  readonly toolAddress: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema: Readonly<Record<string, JsonValue>>;
  readonly security: ToolSecurity;
  readonly effectStrategyRegistrationDigest: Digest;
}): ExecutorToolExecutor {
  const deploymentProfile = defineExecutorDeploymentProfile({
    tenantId: input.tenantId,
    executorOrigin: input.executorOrigin,
    opaqueConnectionRef: input.opaqueConnectionRef,
    backupPolicyId: input.backupPolicyId,
    receipt: input.conformanceReceipt,
    evaluatedAt: input.evaluatedAt,
  });
  const pin = defineExecutorToolPin({
    registrationId: "records.list@1",
    implementationVersion: "1.0.0",
    serverIdentityDigest: input.connection.serverIdentity.mcpServerIdentityDigest,
    executeToolRegistrationDigest: input.executeToolRegistrationDigest,
    connectionBindingDigest: deploymentProfile.connectionBindingDigest,
    toolAddress: input.toolAddress,
    safeDescription: "List reviewed records",
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    security: input.security,
    effectStrategyRegistrationDigest: input.effectStrategyRegistrationDigest,
  });
  return createExecutorToolExecutor({
    connection: input.connection,
    executeToolRegistrationDigest: input.executeToolRegistrationDigest,
    toolPins: [pin],
    deploymentProfile,
    conformanceReceipt: input.conformanceReceipt,
    evaluatedAt: input.evaluatedAt,
  });
}
