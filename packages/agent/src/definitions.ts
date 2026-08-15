import {
  AgentDefinitionSchema,
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
  type Digest,
  type InstructionBundle,
  type JsonValue,
  type ResourceScope,
  type ModelDriver,
  type ToolExecutionContext,
  type ToolRegistrationContract,
  type ToolSecurity,
} from "@pactmark/core";
import type { DefinedSchema } from "@pactmark/core";
import { z } from "zod";

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
}

export interface DefineToolInput<I extends z.ZodType, O extends z.ZodType> {
  readonly id: string;
  readonly implementationVersion: string;
  readonly description: string;
  readonly input: DefinedSchema<I>;
  readonly output: DefinedSchema<O>;
  readonly security: Omit<ToolSecurity, "schemaVersion">;
  /** Host-owned extraction of every resource the validated call can touch. */
  readonly resources: (
    input: z.output<I>,
    context: Readonly<{
      tenantId: string;
      purposeCode: string;
      dataClass: ToolSecurity["dataClasses"][number];
    }>,
  ) => readonly ResourceScope[];
  /** Optional deterministic cost used by policy cost ceilings. */
  readonly cost?: (input: z.output<I>) => number;
  readonly operation: Readonly<{
    kind: "read";
    execute(input: z.output<I>, context: ToolExecutionContext): Promise<z.input<O>>;
  }>;
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

export function defineTool<const I extends z.ZodType, const O extends z.ZodType>(
  input: DefineToolInput<I, O>,
): DefinedTool<I, O> {
  const security = ToolSecuritySchema.parse({ schemaVersion: "1", ...input.security });
  const effectStrategyIdentity = {
    id: `${input.id}.read-effect@1`,
    implementationVersion: input.implementationVersion,
    kind: "read",
  };
  const identity = defineToolRegistration({
    id: input.id,
    implementationVersion: input.implementationVersion,
    inputSchemaIdentityDigest: input.input.identity.schemaIdentityDigest,
    outputSchemaIdentityDigest: input.output.identity.schemaIdentityDigest,
    securityMetadata: security,
    effectStrategyIdentity,
    executorIdentity: {
      package: "@pactmark/executor-in-process",
      export: "createDeclaredToolExecutor",
      version: "0.1.0",
    },
    identifierNormalizerVersion: "pactmark.identifier@1",
    resourceNormalizerVersion: "pactmark.resource@1",
    urlNormalizerVersion: "whatwg-url@1",
  });
  const registration = ToolRegistrationContractSchema.parse({
    schemaVersion: "1",
    id: input.id,
    implementationVersion: input.implementationVersion,
    description: input.description,
    inputSchemaDigest: input.input.identity.schemaIdentityDigest,
    outputSchemaDigest: input.output.identity.schemaIdentityDigest,
    security,
    effectStrategyKind: "read",
    effectStrategyRegistrationDigest: digestCanonicalJson(effectStrategyIdentity),
    executorKind: "@pactmark/executor-in-process",
    executorVersion: "0.1.0",
    toolRegistrationDigest: identity.toolRegistrationDigest,
  });
  const result = deepFreeze({
    id: registration.id,
    registration,
    input: input.input,
    output: input.output,
    security,
  });
  toolRuntimeDefinitions.set(result, {
    resolve(value, context) {
      const parsedInput = input.input.parse(value);
      const resources = z
        .array(ResourceScopeSchema)
        .min(1)
        .max(256)
        .parse(input.resources(parsedInput, context));
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
      const parsedInput = input.input.parse(value);
      const output = await input.operation.execute(parsedInput, context);
      return JsonValueSchema.parse(input.output.parse(output));
    },
  });
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
  readonly description: string;
  readonly input: DefinedSchema<I>;
  readonly instructions: InstructionBundle;
  readonly model: CompiledModelDefinition;
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  readonly policy: DefinedPolicy;
  readonly output: DefinedSchema<O>;
  readonly verifiers: readonly string[];
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

export function defineAgent<const I extends z.ZodType, const O extends z.ZodType>(
  input: DefineAgentInput<I, O>,
): DefinedAgent<I, O> {
  const tools = Object.values(input.tools ?? {});
  if (
    new Set(tools.map((tool) => tool.registration.toolRegistrationDigest)).size !== tools.length
  ) {
    throw new TypeError("Agent tools must have unique registration digests");
  }
  const verifierEntries = input.verifiers.map(
    (id) =>
      [
        digestCanonicalJson({ id, outputSchemaDigest: input.output.identity.schemaIdentityDigest }),
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
    description: input.description,
    instructions: input.instructions,
    skillManifestDigests: [],
    inputSchemaDigest: input.input.identity.schemaIdentityDigest,
    outputSchemaDigest: input.output.identity.schemaIdentityDigest,
    toolRegistrationDigests: tools.map((tool) => tool.registration.toolRegistrationDigest),
    policyRegistrationDigest: input.policy.policyRegistrationDigest,
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
    input: input.input,
    output: input.output,
    model: input.model,
    tools,
    policy: input.policy,
    verifiers: new Map(verifierEntries),
    credentialMode: input.model.credentialMode ?? "host_bound",
  });
  return definition;
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
    for (const tool of metadata.tools) {
      if (tool.security.networkEnforcement === "required") required.add("network_enforced");
    }
  }
  return [...required].sort();
}
