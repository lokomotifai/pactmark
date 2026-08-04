import {
  RuntimeCapabilitiesSchema,
  RuntimeReadinessProfileSchema,
  RuntimeReadinessReportSchema,
  type RuntimeCapabilities,
  type RuntimeReadinessCheck,
  type RuntimeReadinessProfile,
  type RuntimeReadinessReport,
} from "@pactmark/core";

const RULES_VERSION = "pactmark.readiness@1";

type BooleanCapability = {
  [K in keyof RuntimeCapabilities]: RuntimeCapabilities[K] extends boolean ? K : never;
}[keyof RuntimeCapabilities];

const REQUIREMENT_MAP: Readonly<
  Record<string, BooleanCapability | "network_enforced" | "sandbox_isolated">
> = Object.freeze({
  durable_storage: "durableStorage",
  protected_context: "protectedContext",
  protected_work_orders: "protectedWorkOrders",
  protected_input_submissions: "protectedInputSubmissions",
  streaming: "streaming",
  cancellation: "cancellation",
  background_wakeup: "backgroundWakeup",
  atomic_command_and_wakeup: "atomicCommandAndWakeup",
  human_decisions: "humanDecisions",
  typed_input: "typedInput",
  effect_reconciliation: "effectReconciliation",
  compensation: "compensation",
  model_credentials: "modelCredentials",
  tool_credentials: "toolCredentials",
  network_enforced: "network_enforced",
  sandbox_isolated: "sandbox_isolated",
});

function check(
  id: string,
  passes: boolean,
  code: string,
  safeMessage: string,
  remediationSlug: string,
  requiredCapability?: string,
): RuntimeReadinessCheck {
  return {
    schemaVersion: "1",
    id,
    status: passes ? "pass" : "fail",
    code,
    safeMessage,
    remediationSlug,
    ...(requiredCapability === undefined ? {} : { requiredCapability }),
  };
}

function capabilitySatisfied(capabilities: RuntimeCapabilities, requirement: string): boolean {
  const mapped = REQUIREMENT_MAP[requirement];
  if (mapped === undefined) return false;
  if (mapped === "network_enforced") return capabilities.networkPolicy === "enforced";
  if (mapped === "sandbox_isolated") return capabilities.sandbox === "isolated";
  return capabilities[mapped];
}

export interface EvaluateRuntimeReadinessInput {
  readonly profile: RuntimeReadinessProfile;
  readonly capabilities: RuntimeCapabilities;
  readonly requiredCapabilities?: readonly string[];
  readonly evaluatedAt: string;
  readonly admissionConfigured?: boolean;
  readonly activeExecutionConfigured?: boolean;
}

/** Pure, versioned evaluation. It performs no probing, I/O, or mutation. */
export function evaluateRuntimeReadiness(
  input: EvaluateRuntimeReadinessInput,
): RuntimeReadinessReport {
  const profile = RuntimeReadinessProfileSchema.parse(input.profile);
  const capabilities = RuntimeCapabilitiesSchema.parse(input.capabilities);
  const checks: RuntimeReadinessCheck[] = [];
  if (profile === "production") {
    checks.push(
      check(
        "production-execution-profile",
        capabilities.executionProfile === "durable",
        "KAF_READINESS_DURABLE_EXECUTION_REQUIRED",
        "Production requires a durable execution profile.",
        "configure-durable-execution",
        "durable_storage",
      ),
      check(
        "production-protected-context",
        capabilities.protectedContext,
        "KAF_READINESS_PROTECTED_CONTEXT_REQUIRED",
        "Production requires a protected operational context store.",
        "configure-protected-context",
        "protected_context",
      ),
      check(
        "production-protected-work-orders",
        capabilities.protectedWorkOrders,
        "KAF_READINESS_PROTECTED_WORK_ORDERS_REQUIRED",
        "Production requires protected immutable WorkOrder storage.",
        "configure-protected-work-orders",
        "protected_work_orders",
      ),
      check(
        "production-protected-inputs",
        capabilities.protectedInputSubmissions,
        "KAF_READINESS_PROTECTED_INPUTS_REQUIRED",
        "Production requires protected typed input storage.",
        "configure-protected-inputs",
        "protected_input_submissions",
      ),
    );
    if (input.admissionConfigured !== undefined) {
      checks.push(
        check(
          "production-admission-controller",
          input.admissionConfigured,
          "KAF_READINESS_ADMISSION_REQUIRED",
          "Production requires an explicit admission controller.",
          "configure-admission-controller",
        ),
      );
    }
    if (input.activeExecutionConfigured !== undefined) {
      checks.push(
        check(
          "production-active-execution-reservations",
          input.activeExecutionConfigured,
          "KAF_READINESS_ACTIVE_EXECUTION_REQUIRED",
          "Production requires durable active-execution reservations in the command transaction domain.",
          "configure-active-execution-reservations",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "preview-profile-declared",
        true,
        "KAF_READINESS_PROFILE_DECLARED",
        "The runtime profile is explicitly declared.",
        "review-runtime-profile",
      ),
    );
  }
  for (const requirement of [...new Set(input.requiredCapabilities ?? [])].sort()) {
    checks.push(
      check(
        `required-${requirement.replaceAll("_", "-")}`,
        capabilitySatisfied(capabilities, requirement),
        "KAF_READINESS_CAPABILITY_REQUIRED",
        `Required runtime capability is ${requirement}.`,
        "configure-required-capability",
        requirement,
      ),
    );
  }
  return RuntimeReadinessReportSchema.parse({
    schemaVersion: "1",
    ready: checks.every((item) => item.status !== "fail"),
    profile,
    capabilities,
    checks,
    evaluatedAt: input.evaluatedAt,
    rulesVersion: RULES_VERSION,
  });
}
