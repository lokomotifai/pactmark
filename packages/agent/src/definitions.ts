import {
  AgentDefinitionSchema,
  ApprovalPreviewDisplaySchema,
  DigestSchema,
  JsonValueSchema,
  ResourceScopeSchema,
  ToolRegistrationContractSchema,
  ToolSecuritySchema,
  definePolicyRegistration,
  defineToolRegistration,
  digestBytes,
  digestCanonicalJson,
  type AgentDefinition,
  type ApprovalPreviewDisplay,
  type Digest,
  type InstructionBundle,
  type JsonValue,
  type ModelAgentContext,
  type ResourceScope,
  type ModelDriver,
  type ToolExecutionContext,
  type ToolRegistrationContract,
  type ToolSecurity,
} from "@pactmark/core";
import { defineSchema } from "@pactmark/core";
import type { DefinedSchema } from "@pactmark/core";
import { EXECUTOR_IN_PROCESS_VERSION } from "@pactmark/executor-in-process";
import { z } from "zod";

/**
 * Facade sugar: raw Zod schemas are accepted anywhere a DefinedSchema is, and
 * are compiled with an identifier derived from the owning tool or agent id
 * (`<ownerId>.<role>`, semantic revision "1"). Passing the equivalent explicit
 * DefinedSchema produces byte-identical registration digests.
 */
export type SchemaInput<S extends z.ZodType> = DefinedSchema<S> | S;

function isDefinedSchema<S extends z.ZodType>(value: SchemaInput<S>): value is DefinedSchema<S> {
  return "identity" in value && "schemaIdentity" in value;
}

function coerceSchema<S extends z.ZodType>(
  value: SchemaInput<S>,
  ownerId: string,
  role: "input" | "output",
): DefinedSchema<S> {
  if (isDefinedSchema(value)) return value;
  return defineSchema({ id: `${ownerId}.${role}`, semanticRevision: "1", schema: value });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function defineInstructions(
  input: Readonly<{ text: string; sourceName?: string }>,
): InstructionBundle {
  const text = input.text
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  if (text.trim().length === 0) throw new TypeError("Instructions must not be empty");
  const entry = {
    schemaVersion: "1" as const,
    sourceName: input.sourceName ?? "inline",
    text,
    contentDigest: digestBytes(new TextEncoder().encode(text)),
  };
  return deepFreeze({
    schemaVersion: "1",
    entries: [entry],
    bundleDigest: digestCanonicalJson({ schemaVersion: "1", entries: [entry] }),
  });
}

export interface CompiledModelDefinition {
  readonly modelSecurityProfileDigest: Digest;
  readonly modelResourceProfileDigest: Digest;
  readonly modelAdapterRegistrationDigest: Digest;
  readonly modelConfig: JsonValue;
  readonly driver: ModelDriver;
  readonly credentialMode?: "ambient_preview" | "host_bound";
  /**
   * Optional composition-time binding of one agent's governed surface. The
   * facade calls this with schema-only tool advertisements so a provider
   * adapter can describe tools to the model; proposal validation, policy,
   * and dispatch remain host-owned.
   */
  readonly bindAgentContext?: (context: ModelAgentContext) => ModelDriver;
}

/**
 * Conservative local defaults apply to every omitted field except
 * `requiredScopes`, which stays explicit because capability naming is the
 * point of the framework. Defaults never widen authority: reads default to
 * risk class R1; a write operation must declare its own risk class.
 */
export type DefineToolSecurityInput = Readonly<
  Partial<Omit<ToolSecurity, "schemaVersion" | "requiredScopes">> & {
    requiredScopes: ToolSecurity["requiredScopes"];
  }
>;

export interface DefineToolInput<I extends z.ZodType, O extends z.ZodType> {
  readonly id: string;
  readonly implementationVersion?: string;
  readonly description: string;
  readonly input: SchemaInput<I>;
  readonly output: SchemaInput<O>;
  readonly security: DefineToolSecurityInput;
  /** Host-owned extraction of every resource the validated call can touch. Defaults to the tenant scope. */
  readonly resources?: (
    input: z.output<I>,
    context: Readonly<{
      tenantId: string;
      purposeCode: string;
      dataClass: ToolSecurity["dataClasses"][number];
    }>,
  ) => readonly ResourceScope[];
  /** Optional deterministic cost used by policy cost ceilings. */
  readonly cost?: (input: z.output<I>) => number;
  readonly operation: DefineToolReadOperation<I, O> | DefineToolWriteOperation<I, O>;
}

export type DefineToolReadOperation<I extends z.ZodType, O extends z.ZodType> = Readonly<{
  kind: "read";
  execute(input: z.output<I>, context: ToolExecutionContext): Promise<z.input<O>>;
}>;

/**
 * A facade write tool dispatches through the kernel's governed effect path:
 * deterministic preview, bound authorization, effect ledger, and a bound
 * acknowledgement. The facade local profile supports R2 writes and explicit
 * one-use approval for R4 writes. R3 compensation and R5 production-grade
 * user-presence policy remain kernel-level composition concerns, so
 * `security.riskClass` is mandatory for writes.
 */
export type DefineToolWriteOperation<I extends z.ZodType, O extends z.ZodType> = Readonly<{
  kind: "write";
  /** The author's real-world claim about the effect; recorded in every preview. */
  reversibility: "compensatable" | "irreversible";
  /** One-line consequence statement recorded in the effect preview. */
  materialConsequence?: string;
  /**
   * Explicitly safe, human-readable fields persisted with approval requests.
   * Do not return secrets or sensitive inputs: the result becomes run truth.
   */
  approvalPreview?: (
    input: z.output<I>,
  ) => Pick<ApprovalPreviewDisplay, "title" | "summary" | "fields">;
  execute(input: z.output<I>, context: ToolExecutionContext): Promise<z.input<O>>;
}>;

/** Deterministic facade normalized-target string shared by policy and preview. */
export function facadeEffectTarget(
  toolRegistrationDigest: string,
  argumentsDigest: string,
): string {
  return `urn:pactmark:facade-effect:${toolRegistrationDigest}:${argumentsDigest}`;
}

export interface ToolEffectDefinition {
  readonly reversibility: "compensatable" | "irreversible";
  readonly materialConsequence: string;
  readonly previewRegistrationDigest: Digest;
  renderApprovalDisplay(input: JsonValue): ApprovalPreviewDisplay;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>;
}

const toolEffectDefinitions = new WeakMap<object, ToolEffectDefinition>();

/** Present only for tools compiled with a write operation. */
export function getToolEffectDefinition(tool: DefinedTool): ToolEffectDefinition | undefined {
  return toolEffectDefinitions.get(tool);
}

export interface DefinedTool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly registration: ToolRegistrationContract;
  readonly input: DefinedSchema<I>;
  readonly output: DefinedSchema<O>;
  readonly security: ToolSecurity;
}

type ToolRuntimeDefinition = Readonly<{
  resolve(
    input: JsonValue,
    context: Readonly<{
      tenantId: string;
      purposeCode: string;
      dataClass: ToolSecurity["dataClasses"][number];
    }>,
  ): Readonly<{
    validatedInput: JsonValue;
    resources: readonly ResourceScope[];
    requestedCost?: number;
  }>;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>;
}>;

const toolRuntimeDefinitions = new WeakMap<object, ToolRuntimeDefinition>();

const DEFAULT_TENANT_RESOURCES = (
  _input: unknown,
  context: Readonly<{ tenantId: string }>,
): readonly ResourceScope[] => [
  {
    kind: "tenant",
    value: context.tenantId,
    normalizationVersion: "pactmark.policy-normalization@1",
  },
];

export function defineTool<const I extends z.ZodType, const O extends z.ZodType>(
  input: DefineToolInput<I, O>,
): DefinedTool<I, O> {
  const implementationVersion = input.implementationVersion ?? "1.0.0";
  const inputSchema = coerceSchema(input.input, input.id, "input");
  const outputSchema = coerceSchema(input.output, input.id, "output");
  const resolveResources = input.resources ?? DEFAULT_TENANT_RESOURCES;
  const write = input.operation.kind === "write" ? input.operation : undefined;
  if (write !== undefined) {
    if (input.security.riskClass === undefined) {
      throw new TypeError("A write tool must declare its risk class explicitly");
    }
    if (input.security.riskClass !== "R2" && input.security.riskClass !== "R4") {
      throw new TypeError(
        "Facade write tools support risk classes R2 and R4; R3 compensation and R5 " +
          "user-presence policy require kernel-level composition",
      );
    }
    if (
      input.security.reversibility !== undefined &&
      input.security.reversibility !== write.reversibility
    ) {
      throw new TypeError("security.reversibility must match operation.reversibility");
    }
  }
  const security = ToolSecuritySchema.parse({
    schemaVersion: "1",
    riskClass: input.security.riskClass ?? "R1",
    dataClasses: input.security.dataClasses ?? ["public"],
    reversibility: write?.reversibility ?? input.security.reversibility ?? "not_applicable",
    requiredScopes: input.security.requiredScopes,
    egress: input.security.egress ?? { mode: "none" },
    networkEnforcement: input.security.networkEnforcement ?? "declared_ok",
    maxCallsPerRun: input.security.maxCallsPerRun ?? 3,
    timeoutMs: input.security.timeoutMs ?? 10_000,
    ...(input.security.costCeiling === undefined
      ? {}
      : { costCeiling: input.security.costCeiling }),
  });
  const effectStrategyIdentity =
    write === undefined
      ? { id: `${input.id}.read-effect@1`, implementationVersion, kind: "read" }
      : { id: `${input.id}.write-effect@1`, implementationVersion, kind: "none" };
  const previewStrategyIdentity =
    write === undefined
      ? undefined
      : {
          id: `${input.id}.preview@1`,
          implementationVersion,
          kind: "facade-deterministic@1",
        };
  const identity = defineToolRegistration({
    id: input.id,
    implementationVersion,
    inputSchemaIdentityDigest: inputSchema.identity.schemaIdentityDigest,
    outputSchemaIdentityDigest: outputSchema.identity.schemaIdentityDigest,
    securityMetadata: security,
    effectStrategyIdentity,
    ...(previewStrategyIdentity === undefined ? {} : { previewStrategyIdentity }),
    executorIdentity: {
      package: "@pactmark/executor-in-process",
      export: "createDeclaredToolExecutor",
      version: EXECUTOR_IN_PROCESS_VERSION,
    },
    identifierNormalizerVersion: "pactmark.identifier@1",
    resourceNormalizerVersion: "pactmark.resource@1",
    urlNormalizerVersion: "whatwg-url@1",
  });
  const registration = ToolRegistrationContractSchema.parse({
    schemaVersion: "1",
    id: input.id,
    implementationVersion,
    description: input.description,
    inputSchemaDigest: inputSchema.identity.schemaIdentityDigest,
    outputSchemaDigest: outputSchema.identity.schemaIdentityDigest,
    security,
    effectStrategyKind: write === undefined ? "read" : "none",
    effectStrategyRegistrationDigest: digestCanonicalJson(effectStrategyIdentity),
    ...(previewStrategyIdentity === undefined
      ? {}
      : { previewStrategyRegistrationDigest: digestCanonicalJson(previewStrategyIdentity) }),
    executorKind: "@pactmark/executor-in-process",
    executorVersion: EXECUTOR_IN_PROCESS_VERSION,
    toolRegistrationDigest: identity.toolRegistrationDigest,
  });
  const result = deepFreeze({
    id: registration.id,
    registration,
    input: inputSchema,
    output: outputSchema,
    security,
  });
  toolRuntimeDefinitions.set(result, {
    resolve(value, context) {
      const parsedInput = inputSchema.parse(value);
      const resources = z
        .array(ResourceScopeSchema)
        .min(1)
        .max(256)
        .parse(resolveResources(parsedInput, context));
      const requestedCost = input.cost?.(parsedInput);
      if (requestedCost !== undefined && (!Number.isFinite(requestedCost) || requestedCost < 0)) {
        throw new TypeError("KAF_POLICY_BUDGET_INVALID");
      }
      return Object.freeze({
        validatedInput: JsonValueSchema.parse(parsedInput),
        resources: Object.freeze(resources),
        ...(requestedCost === undefined ? {} : { requestedCost }),
      });
    },
    async execute(value, context) {
      const parsedInput = inputSchema.parse(value);
      const output = await input.operation.execute(parsedInput, context);
      return JsonValueSchema.parse(outputSchema.parse(output));
    },
  });
  if (write !== undefined) {
    const previewRegistrationDigest = registration.previewStrategyRegistrationDigest;
    if (previewRegistrationDigest === undefined) {
      throw new TypeError("Write tool registration is missing its preview strategy digest");
    }
    toolEffectDefinitions.set(result, {
      reversibility: write.reversibility,
      materialConsequence:
        write.materialConsequence ?? `Executes the declared ${input.id} write operation.`,
      previewRegistrationDigest,
      renderApprovalDisplay(value) {
        const parsedInput = inputSchema.parse(value);
        const consequence =
          write.materialConsequence ?? `Executes the declared ${input.id} write operation.`;
        const display = write.approvalPreview?.(parsedInput) ?? {
          title: input.description,
          summary: consequence,
        };
        return ApprovalPreviewDisplaySchema.parse({
          ...display,
          materialConsequence: consequence,
          reversibility: write.reversibility,
        });
      },
      async execute(value, context) {
        const parsedInput = inputSchema.parse(value);
        const output = await write.execute(parsedInput, context);
        return JsonValueSchema.parse(outputSchema.parse(output));
      },
    });
  }
  return result;
}

export interface DefinePolicyInput {
  readonly id: string;
  readonly implementationVersion: string;
  readonly default: "deny";
  readonly rules: readonly Readonly<{
    riskClass: ToolSecurity["riskClass"];
    decision: "deny" | "allow_with_grant" | "require_approval";
  }>[];
}

export interface DefinedPolicy {
  readonly id: string;
  readonly implementationVersion: string;
  readonly default: "deny";
  readonly rules: DefinePolicyInput["rules"];
  readonly policyRegistrationDigest: Digest;
}

export function definePolicy(input: DefinePolicyInput): DefinedPolicy {
  const rules = input.rules.map((rule) => Object.freeze({ ...rule }));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.riskClass)) throw new TypeError("Policy risk classes must be unique");
    seen.add(rule.riskClass);
  }
  const registration = definePolicyRegistration({
    id: input.id,
    implementationVersion: input.implementationVersion,
    defaultDecision: "deny",
    rules,
    config: { policyFormat: "pactmark.facade-policy@1" },
    schemaIdentityDigests: [],
    reasonCodes: [
      "KAF_POLICY_ALLOWED",
      "KAF_POLICY_DEFAULT_DENY",
      "KAF_POLICY_APPROVAL_REQUIRED",
      "KAF_POLICY_NETWORK_ENFORCEMENT_REQUIRED",
    ],
    executorIdentity: {
      package: "@pactmark/agent",
      export: "definePolicy",
      version: input.implementationVersion,
    },
  });
  return deepFreeze({
    id: input.id,
    implementationVersion: input.implementationVersion,
    default: "deny",
    rules,
    policyRegistrationDigest: registration.policyRegistrationDigest,
  });
}

export interface DefineAgentInput<I extends z.ZodType, O extends z.ZodType> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly input: SchemaInput<I>;
  readonly instructions: InstructionBundle | string;
  readonly model: CompiledModelDefinition;
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  /**
   * Defaults to a deny-everything policy that grants only R0/R1 reads.
   * Composing an R2+ tool under the default policy fails at composition —
   * consequential authority always requires an explicit policy line.
   */
  readonly policy?: DefinedPolicy;
  readonly output: SchemaInput<O>;
  readonly verifiers?: readonly string[];
  readonly requiredRuntimeCapabilities?: readonly string[];
}

declare const DEFINED_AGENT_TYPES: unique symbol;
export type DefinedAgent<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = AgentDefinition & {
  readonly [DEFINED_AGENT_TYPES]?: Readonly<{ input: z.output<I>; output: z.output<O> }>;
};

export type InferAgentInput<A extends DefinedAgent> =
  A extends DefinedAgent<infer I> ? z.output<I> : never;
export type InferAgentOutput<A extends DefinedAgent> =
  A extends DefinedAgent<z.ZodType, infer O> ? z.output<O> : never;

export interface AgentRuntimeMetadata {
  readonly input: DefinedSchema<z.ZodType>;
  readonly output: DefinedSchema<z.ZodType>;
  readonly model: CompiledModelDefinition;
  readonly tools: readonly DefinedTool[];
  readonly policy: DefinedPolicy;
  readonly verifiers: ReadonlyMap<Digest, string>;
  readonly credentialMode: "ambient_preview" | "host_bound";
}

const agentRuntimeDefinitions = new WeakMap<object, AgentRuntimeMetadata>();

const DEFAULT_POLICY_RISK_CLASSES: readonly ToolSecurity["riskClass"][] = ["R0", "R1"];

function defaultAgentPolicy(agentId: string): DefinedPolicy {
  return definePolicy({
    id: `${agentId}.default-policy`,
    implementationVersion: "1.0.0",
    default: "deny",
    rules: DEFAULT_POLICY_RISK_CLASSES.map((riskClass) => ({
      riskClass,
      decision: "allow_with_grant" as const,
    })),
  });
}

export function defineAgent<const I extends z.ZodType, const O extends z.ZodType>(
  input: DefineAgentInput<I, O>,
): DefinedAgent<I, O> {
  const tools = Object.values(input.tools ?? {});
  if (
    new Set(tools.map((tool) => tool.registration.toolRegistrationDigest)).size !== tools.length
  ) {
    throw new TypeError("Agent tools must have unique registration digests");
  }
  const description = input.description ?? input.id;
  const inputSchema = coerceSchema(input.input, input.id, "input");
  const outputSchema = coerceSchema(input.output, input.id, "output");
  const instructions =
    typeof input.instructions === "string"
      ? defineInstructions({ text: input.instructions })
      : input.instructions;
  const policy = input.policy ?? defaultAgentPolicy(input.id);
  if (input.policy === undefined) {
    const ungoverned = tools.filter(
      (tool) => !DEFAULT_POLICY_RISK_CLASSES.includes(tool.security.riskClass),
    );
    if (ungoverned.length > 0) {
      throw new TypeError(
        `The default agent policy grants only ${DEFAULT_POLICY_RISK_CLASSES.join("/")} reads; ` +
          `declare an explicit policy rule for: ${ungoverned
            .map((tool) => `${tool.id} (${tool.security.riskClass})`)
            .join(", ")}`,
      );
    }
  }
  const verifiers = input.verifiers ?? ["schema@1"];
  const verifierEntries = verifiers.map(
    (id) =>
      [
        digestCanonicalJson({ id, outputSchemaDigest: outputSchema.identity.schemaIdentityDigest }),
        id,
      ] as const,
  );
  if (new Set(verifierEntries.map(([digest]) => digest)).size !== verifierEntries.length) {
    throw new TypeError("Agent verifiers must be unique");
  }
  const modelSecurityProfileDigest = DigestSchema.parse(input.model.modelSecurityProfileDigest);
  const modelResourceProfileDigest = DigestSchema.parse(input.model.modelResourceProfileDigest);
  const modelAdapterRegistrationDigest = DigestSchema.parse(
    input.model.modelAdapterRegistrationDigest,
  );
  const material = {
    schemaVersion: "1" as const,
    id: input.id,
    version: input.version,
    description,
    instructions,
    skillManifestDigests: [],
    inputSchemaDigest: inputSchema.identity.schemaIdentityDigest,
    outputSchemaDigest: outputSchema.identity.schemaIdentityDigest,
    toolRegistrationDigests: tools.map((tool) => tool.registration.toolRegistrationDigest),
    policyRegistrationDigest: policy.policyRegistrationDigest,
    verifierRegistrationDigests: verifierEntries.map(([digest]) => digest),
    modelSecurityProfileDigest,
    modelResourceProfileDigest,
    modelAdapterRegistrationDigest,
    modelConfig: JsonValueSchema.parse(input.model.modelConfig),
    requiredRuntimeCapabilities: [...(input.requiredRuntimeCapabilities ?? [])],
  };
  const definition = deepFreeze(
    AgentDefinitionSchema.parse({
      ...material,
      agentDefinitionDigest: digestCanonicalJson(material),
    }),
  ) as DefinedAgent<I, O>;
  agentRuntimeDefinitions.set(definition, {
    input: inputSchema,
    output: outputSchema,
    model: input.model,
    tools,
    policy,
    verifiers: new Map(verifierEntries),
    credentialMode: input.model.credentialMode ?? "host_bound",
  });
  return definition;
}

/** Schema-only advertisement of one compiled agent's governed surface. */
export function agentModelContext(agent: DefinedAgent): ModelAgentContext {
  const metadata = getAgentRuntimeMetadata(agent);
  return deepFreeze({
    agent: {
      id: agent.id,
      version: agent.version,
      agentDefinitionDigest: agent.agentDefinitionDigest,
    },
    instructions: agent.instructions,
    tools: metadata.tools.map((tool) => ({
      id: tool.id,
      description: tool.registration.description,
      toolRegistrationDigest: tool.registration.toolRegistrationDigest,
      inputJsonSchema: tool.input.identity.canonicalJsonSchema,
    })),
    output: {
      schemaId: metadata.output.identity.id,
      jsonSchema: metadata.output.identity.canonicalJsonSchema,
    },
  });
}

export function getAgentRuntimeMetadata(agent: AgentDefinition): AgentRuntimeMetadata {
  const metadata = agentRuntimeDefinitions.get(agent);
  if (metadata === undefined) throw new TypeError("KAF_AGENT_NOT_COMPILED_BY_FACADE");
  return metadata;
}

export function getToolRuntimeDefinition(tool: DefinedTool): ToolRuntimeDefinition {
  const definition = toolRuntimeDefinitions.get(tool);
  if (definition === undefined) throw new TypeError("KAF_TOOL_NOT_COMPILED_BY_FACADE");
  return definition;
}

export function requiredCapabilitiesForAgents(
  agents: readonly AgentDefinition[],
): readonly string[] {
  const required = new Set<string>();
  for (const agent of agents) {
    for (const capability of agent.requiredRuntimeCapabilities) required.add(capability);
    const metadata = getAgentRuntimeMetadata(agent);
    if (metadata.credentialMode === "host_bound") required.add("model_credentials");
    if (metadata.policy.rules.some((rule) => rule.decision === "require_approval")) {
      required.add("human_decisions");
    }
    for (const tool of metadata.tools) {
      if (tool.security.networkEnforcement === "required") required.add("network_enforced");
    }
  }
  return [...required].sort();
}
