import { z } from "zod";
import { AgentExecutionDefinitionRefSchema } from "./model.js";
import { DigestSchema, JsonValueSchema } from "./serialization.js";

export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const InstructionEntrySchema = z
  .object({
    schemaVersion: z.literal("1"),
    sourceName: z.string().min(1),
    text: z.string().min(1),
    contentDigest: DigestSchema,
  })
  .strict();
export const InstructionBundleSchema = z
  .object({
    schemaVersion: z.literal("1"),
    entries: z.array(InstructionEntrySchema).min(1),
    bundleDigest: DigestSchema,
  })
  .strict();
export type InstructionBundle = z.infer<typeof InstructionBundleSchema>;

export const CompensationExecutionDefinitionRefSchema = z
  .object({
    kind: z.literal("compensation"),
    id: IdentifierSchema,
    version: SemverSchema,
    compensationRunDefinitionDigest: DigestSchema,
    originalAgentDefinitionDigest: DigestSchema,
    originalEffectDigest: DigestSchema,
    compensationStrategyRegistrationDigest: DigestSchema,
    compensationToolRegistrationDigest: DigestSchema,
  })
  .strict();
export type CompensationExecutionDefinitionRef = z.infer<
  typeof CompensationExecutionDefinitionRefSchema
>;

export const ExecutionDefinitionRefSchema = z.discriminatedUnion("kind", [
  AgentExecutionDefinitionRefSchema,
  CompensationExecutionDefinitionRefSchema,
]);
export type ExecutionDefinitionRef = z.infer<typeof ExecutionDefinitionRefSchema>;

export const CompensationRunDefinitionSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: IdentifierSchema,
    version: SemverSchema,
    originalAgentDefinitionDigest: DigestSchema,
    originalToolRegistrationDigest: DigestSchema,
    originalEffectSchemaDigest: DigestSchema,
    acknowledgementSchemaDigest: DigestSchema,
    compensationStrategyRegistrationDigest: DigestSchema,
    compensationToolId: IdentifierSchema,
    compensationToolVersion: SemverSchema,
    compensationToolRegistrationDigest: DigestSchema,
    compensationInputSchemaDigest: DigestSchema,
    compensationOutputSchemaDigest: DigestSchema,
    requiredVerifierRegistrationDigests: z.array(DigestSchema).min(1),
    policyRegistrationDigest: DigestSchema,
    purposeCode: z.string().min(1),
    purposeRegistryVersion: z.string().min(1),
    requiredCapabilities: z.array(z.string().min(1)),
    executorVersion: z.string().min(1),
    compensationRunDefinitionDigest: DigestSchema,
  })
  .strict();
export type CompensationRunDefinition = z.infer<typeof CompensationRunDefinitionSchema>;

export const AgentDefinitionSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: IdentifierSchema,
    version: SemverSchema,
    description: z.string().min(1),
    instructions: InstructionBundleSchema,
    skillManifestDigests: z.array(DigestSchema),
    inputSchemaDigest: DigestSchema,
    outputSchemaDigest: DigestSchema,
    toolRegistrationDigests: z.array(DigestSchema),
    policyRegistrationDigest: DigestSchema,
    verifierRegistrationDigests: z.array(DigestSchema),
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    modelAdapterRegistrationDigest: DigestSchema,
    modelConfig: JsonValueSchema,
    requiredRuntimeCapabilities: z.array(z.string().min(1)),
    agentDefinitionDigest: DigestSchema,
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
