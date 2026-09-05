import {
  ApprovalSchema,
  DecisionPreviewReferenceSchema,
  DecisionSubmissionChallengeSchema,
  JsonValueSchema,
  KafError,
  RuntimeCapabilitiesSchema,
  VerificationResultSchema,
  createCommandContext,
  createCommandId as createCoreCommandId,
  createWorkOrderRequest,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  parseJsonStrict,
  parseWire,
  type AgentDefinition,
  type AgentRegistry,
  type Artifact,
  type AuthorityContext,
  type AuthorityIssuer,
  type CommandContext,
  type ContextStore,
  type DataProtector,
  type DecisionChallengeIssuer,
  type DecisionPreviewer,
  type EvidenceBuilder,
  type EvidenceRecord,
  type EgressBroker,
  type InputSubmissionStore,
  type JsonValue,
  type PolicyEngine,
  type ProtectedValueRef,
  type ProposedEffectBinding,
  type RunEvent,
  type RunProjection,
  type RuntimeCapabilities,
  type RuntimeReadinessProfile,
  type RuntimeReadinessReport,
  type ToolCallResolver,
  type ToolExecutionContext,
  type VerificationResult,
  type WorkBudget,
  type VerifierRegistry as CoreVerifierRegistry,
  type WorkOrderRequest,
} from "@pactmark/core";
import { buildEvidenceRecord, verificationResultIdentity } from "@pactmark/evidence";
import {
  createDeclaredAllowlistEgressBroker,
  createDeclaredToolExecutor,
  createDenyAllEgressBroker,
  type DeclaredTool,
} from "@pactmark/executor-in-process";
import {
  evaluatePolicyPreflight,
  type DeterministicPolicyConfig,
  type KillSwitchRegistry,
} from "@pactmark/policy";
import {
  createRuntime as createKernelRuntime,
  effectProofDigest,
  type RuntimeEffectAuthorizationResolver,
  type RuntimeEffectServices,
  type RuntimeExecutableEffectStrategy,
  type RuntimeKernelConfig,
} from "@pactmark/runtime";
import { createMemoryStoreSuite } from "@pactmark/store-memory";

import { createLocalAuthorityIssuer, randomBytes } from "./authority.js";
import {
  agentModelContext,
  facadeEffectTarget,
  getAgentRuntimeMetadata,
  getToolEffectDefinition,
  getToolRuntimeDefinition,
  requiredCapabilitiesForAgents,
  type DefinedAgent,
} from "./definitions.js";
import { evaluateRuntimeReadiness } from "./readiness.js";

const LOCAL_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: true,
  protectedWorkOrders: false,
  protectedInputSubmissions: true,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "declared",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: true,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["memory.process-local"],
});

function clock() {
  const monotonicOrigin = globalThis.performance.now();
  return Object.freeze({
    now: () => new Date().toISOString(),
    monotonicMilliseconds: () => Math.max(0, globalThis.performance.now() - monotonicOrigin),
  });
}

function idGenerator() {
  return Object.freeze({
    generate: (kind: string) =>
      `${kind}_${Date.now().toString(36)}_${[...randomBytes(12)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`,
  });
}

function processLocalContextProtector(ids: ReturnType<typeof idGenerator>): DataProtector {
  const values = new Map<string, Uint8Array>();
  return Object.freeze({
    async protect(binding: Readonly<Record<string, string>>, plaintext: Uint8Array) {
      await Promise.resolve();
      const ciphertextRef = ids.generate("context");
      const value = new Uint8Array(plaintext);
      values.set(ciphertextRef, value);
      return {
        schemaVersion: "1" as const,
        protectorId: "pactmark.local-context@1",
        keyId: "process-local",
        ciphertextRef,
        ciphertextDigest: digestBytes(value),
        aadDigest: digestCanonicalJson(binding),
        algorithm: "process-local-opaque-reference",
      };
    },
    async unprotect(binding: Readonly<Record<string, string>>, reference: ProtectedValueRef) {
      await Promise.resolve();
      if (reference.aadDigest !== digestCanonicalJson(binding)) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH");
      }
      const value = values.get(reference.ciphertextRef);
      if (value === undefined || digestBytes(value) !== reference.ciphertextDigest) {
        throw new KafError("KAF_STORAGE_NOT_FOUND");
      }
      return new Uint8Array(value);
    },
  });
}

function verifiedLocalDecisionClaims(
  authorityIssuer: AuthorityIssuer,
  authority: AuthorityContext,
  now: string,
) {
  const verification = authorityIssuer.verify(authority, new Date(now));
  if (!verification.valid) {
    throw new KafError(
      verification.reason === "expired"
        ? "KAF_AUTHORIZATION_EXPIRED"
        : "KAF_AUTHORIZATION_BINDING_MISMATCH",
      {
        details: { reason: verification.reason },
      },
    );
  }
  return verification.claims;
}

/** Process-local, command-idempotent challenge authority for the ephemeral profile. */
function createProcessLocalDecisionChallengeIssuer(
  authorityIssuer: AuthorityIssuer,
  now: () => string,
  ids: ReturnType<typeof idGenerator>,
): DecisionChallengeIssuer {
  const issuedByCommand = new Map<
    string,
    Readonly<{
      requestDigest: string;
      challengeProof: string;
      challenge: ReturnType<typeof DecisionSubmissionChallengeSchema.parse>;
    }>
  >();
  const challengesByProofDigest = new Map<
    string,
    ReturnType<typeof DecisionSubmissionChallengeSchema.parse>
  >();
  const approvalsByCommand = new Map<
    string,
    Readonly<{
      requestDigest: string;
      approval: ReturnType<typeof ApprovalSchema.parse>;
    }>
  >();
  const assertPrincipalBinding = (
    claims: ReturnType<typeof verifiedLocalDecisionClaims>,
    binding: ProposedEffectBinding,
  ) => {
    if (
      claims.tenant.id !== binding.tenant.id ||
      canonicalJsonStringify(claims.actor) !== canonicalJsonStringify(binding.principal)
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "local_decision_principal_binding_changed" },
      });
    }
  };
  const issuer: DecisionChallengeIssuer = {
    async issue(authority, request, command) {
      await Promise.resolve();
      const issuedAt = now();
      const claims = verifiedLocalDecisionClaims(authorityIssuer, authority, issuedAt);
      assertPrincipalBinding(claims, request.binding);
      const key = canonicalJsonStringify([
        claims.tenant.id,
        claims.actor.type,
        claims.actor.id,
        command.commandId,
      ]);
      const requestDigest = digestCanonicalJson(request);
      const prior = issuedByCommand.get(key);
      if (prior !== undefined) {
        if (prior.requestDigest !== requestDigest) {
          throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
        }
        return { challengeProof: prior.challengeProof, challenge: prior.challenge };
      }
      const challengeProof = `pactmark_local_${[...randomBytes(32)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
      const challenge = DecisionSubmissionChallengeSchema.parse({
        schemaVersion: "1",
        id: ids.generate("challenge"),
        issuerId: "pactmark.local-decision@1",
        proofDigest: digestBytes(new TextEncoder().encode(challengeProof)),
        binding: request.binding,
        requiredAuthenticationStrength: request.requiredAuthenticationStrength,
        issuedAt,
        expiresAt: request.expiresAt,
      });
      const issued = Object.freeze({ requestDigest, challengeProof, challenge });
      issuedByCommand.set(key, issued);
      challengesByProofDigest.set(challenge.proofDigest, challenge);
      return { challengeProof, challenge };
    },
    async verify(authority, challengeProof, binding) {
      await Promise.resolve();
      const verifiedAt = now();
      const claims = verifiedLocalDecisionClaims(authorityIssuer, authority, verifiedAt);
      assertPrincipalBinding(claims, binding);
      const proofDigest = digestBytes(new TextEncoder().encode(challengeProof));
      const challenge = challengesByProofDigest.get(proofDigest);
      if (
        challenge === undefined ||
        canonicalJsonStringify(challenge.binding) !== canonicalJsonStringify(binding) ||
        Date.parse(challenge.expiresAt) <= Date.parse(verifiedAt)
      ) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "local_decision_challenge_invalid" },
        });
      }
      return challenge;
    },
    async createApproval(authority, challenge, command) {
      await Promise.resolve();
      const createdAt = now();
      const claims = verifiedLocalDecisionClaims(authorityIssuer, authority, createdAt);
      assertPrincipalBinding(claims, challenge.binding);
      const key = canonicalJsonStringify([
        claims.tenant.id,
        claims.actor.type,
        claims.actor.id,
        command.commandId,
      ]);
      const requestDigest = digestCanonicalJson({ challenge, actor: claims.actor });
      const prior = approvalsByCommand.get(key);
      if (prior !== undefined) {
        if (prior.requestDigest !== requestDigest) {
          throw new KafError("KAF_HTTP_IDEMPOTENCY_CONFLICT");
        }
        return prior.approval;
      }
      const approval = ApprovalSchema.parse({
        schemaVersion: "1",
        id: ids.generate("approval"),
        issuerId: "pactmark.local-decision@1",
        challengeId: challenge.id,
        challengeProofDigest: challenge.proofDigest,
        binding: challenge.binding,
        approvedBy: claims.actor,
        authenticationStrength: claims.authenticationStrength,
        createdAt,
        expiresAt: challenge.expiresAt,
        maximumUses: 1,
      });
      approvalsByCommand.set(key, Object.freeze({ requestDigest, approval }));
      return approval;
    },
  };
  return Object.freeze(issuer);
}

export function createCommandId(): ReturnType<typeof createCoreCommandId> {
  return createCoreCommandId({ now: () => new Date(), randomBytes });
}

class FacadeAgentRegistry implements AgentRegistry {
  readonly #definitions = new Map<string, AgentDefinition>();
  readonly #definitionsByDigest = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[]) {
    for (const definition of definitions) {
      const key = canonicalJsonStringify([definition.id, definition.version]);
      const existing = this.#definitions.get(key);
      const existingByDigest = this.#definitionsByDigest.get(definition.agentDefinitionDigest);
      if (
        (existing !== undefined && existing !== definition) ||
        (existingByDigest !== undefined && existingByDigest !== definition)
      ) {
        throw new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT");
      }
      this.#definitions.set(key, definition);
      this.#definitionsByDigest.set(definition.agentDefinitionDigest, definition);
    }
  }

  register(definition: AgentDefinition): Promise<void> {
    const key = canonicalJsonStringify([definition.id, definition.version]);
    const existing = this.#definitions.get(key);
    const existingByDigest = this.#definitionsByDigest.get(definition.agentDefinitionDigest);
    if (
      (existing !== undefined && existing !== definition) ||
      (existingByDigest !== undefined && existingByDigest !== definition)
    ) {
      return Promise.reject(new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT"));
    }
    this.#definitions.set(key, definition);
    this.#definitionsByDigest.set(definition.agentDefinitionDigest, definition);
    return Promise.resolve();
  }

  resolve(id: string, version: string, digest: string): Promise<AgentDefinition | undefined> {
    const definition = this.#definitions.get(canonicalJsonStringify([id, version]));
    return Promise.resolve(definition?.agentDefinitionDigest === digest ? definition : undefined);
  }
}

function createAgentPolicyPreflightEngine(
  agents: readonly DefinedAgent[],
  killSwitches?: KillSwitchRegistry,
): PolicyEngine {
  const policiesByDigest = new Map(
    agents.map((agent) => {
      const metadata = getAgentRuntimeMetadata(agent);
      return [agent.policyRegistrationDigest, metadata.policy] as const;
    }),
  );
  return Object.freeze({
    evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]) {
      const agentDefinitionDigest =
        input.workOrder.executionDefinition.kind === "agent"
          ? input.workOrder.executionDefinition.agentDefinitionDigest
          : undefined;
      const policy = policiesByDigest.get(
        agentDefinitionDigest === undefined
          ? ""
          : (agents.find((agent) => agent.agentDefinitionDigest === agentDefinitionDigest)
              ?.policyRegistrationDigest ?? ""),
      );
      const rule = policy?.rules.find(
        (candidate) => candidate.riskClass === input.tool.security.riskClass,
      );
      if (policy === undefined || rule === undefined || rule.decision === "deny") {
        return Promise.resolve({
          decision: "deny" as const,
          reasonCode: "KAF_POLICY_DEFAULT_DENY",
        });
      }
      const r5Enabled = policy.rules.some(
        (candidate) => candidate.riskClass === "R5" && candidate.decision !== "deny",
      );
      const config: DeterministicPolicyConfig = {
        schemaVersion: "1",
        id: policy.id,
        implementationVersion: policy.implementationVersion,
        allowedPurposes: [{ code: "service_delivery", registryVersion: "general@1" }],
        allowedToolRisksByWorkRisk: {
          low: ["R0", "R1", "R2"],
          medium: ["R0", "R1", "R2", "R3"],
          high: ["R0", "R1", "R2", "R3", "R4"],
          critical: r5Enabled
            ? ["R0", "R1", "R2", "R3", "R4", "R5"]
            : ["R0", "R1", "R2", "R3", "R4"],
        },
        enabledDataClasses: [
          "public",
          "internal",
          "confidential",
          "restricted",
          "highly_restricted",
        ],
        enableR5: r5Enabled,
        r5ApprovalMaxAgeMs: 5 * 60 * 1000,
      };
      const preflight = evaluatePolicyPreflight(
        config,
        { ...input, policyRegistrationDigest: policy.policyRegistrationDigest },
        killSwitches,
      );
      if (preflight.decision === "deny") return Promise.resolve(preflight);
      const requiresApproval = rule.decision === "require_approval" || preflight.approvalRequired;
      // Write effects bind their preview to a facade target derived from the
      // exact tool registration and validated arguments; reads keep the
      // resource-derived preflight digest.
      const normalizedTargetDigest =
        input.tool.effectStrategyKind === "read"
          ? preflight.normalizedTargetDigest
          : digestCanonicalJson(
              facadeEffectTarget(input.tool.toolRegistrationDigest, input.argumentsDigest),
            );
      if (requiresApproval) {
        return Promise.resolve({
          decision: "require_approval" as const,
          reasonCode: "KAF_POLICY_APPROVAL_REQUIRED" as const,
          normalizedResources: preflight.normalizedResources,
          normalizedTargetDigest,
        });
      }
      return Promise.resolve({
        decision: "allow_with_grant" as const,
        reasonCode: "KAF_POLICY_ALLOWED" as const,
        normalizedResources: preflight.normalizedResources,
        normalizedTargetDigest,
      });
    },
  });
}

function artifactContent(artifact: Artifact): Uint8Array {
  if (artifact.location.kind !== "inline" || artifact.location.encoding !== "utf8") {
    throw new KafError("KAF_STORAGE_NOT_FOUND");
  }
  return new TextEncoder().encode(artifact.location.content);
}

function createVerifierRegistry(
  agents: readonly DefinedAgent[],
  now: () => string,
  ids: ReturnType<typeof idGenerator>,
): CoreVerifierRegistry {
  const verifiers = new Map<string, Readonly<{ id: string; agent: DefinedAgent }>>();
  for (const agent of agents) {
    for (const [digest, id] of getAgentRuntimeMetadata(agent).verifiers) {
      const current = verifiers.get(digest);
      if (current !== undefined && current.id !== id) {
        throw new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT");
      }
      verifiers.set(digest, { id, agent });
    }
  }
  return Object.freeze({
    has: (id: string) => verifiers.has(id),
    verify(id: string, artifact: Artifact, signal: AbortSignal): Promise<VerificationResult> {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      }
      const verifier = verifiers.get(id);
      if (verifier === undefined)
        return Promise.reject(new TypeError("KAF_VERIFIER_NOT_REGISTERED"));
      const metadata = getAgentRuntimeMetadata(verifier.agent);
      const findings: VerificationResult["findings"] = [];
      try {
        metadata.output.parse(parseJsonStrict(new TextDecoder().decode(artifactContent(artifact))));
      } catch {
        findings.push({
          schemaVersion: "1",
          code: "KAF_VERIFY_SCHEMA",
          severity: "error",
          safeMessage: "Artifact does not match the declared output schema.",
        });
      }
      const material = {
        schemaVersion: "1" as const,
        status: findings.length === 0 ? ("pass" as const) : ("fail" as const),
        verificationId: ids.generate("verification"),
        verifierId: id,
        verifierVersion: verifier.id,
        verifierRegistrationDigest: id,
        method: "deterministic" as const,
        artifactDigest: artifact.artifactDigest,
        findings,
        rubricVersion: "1",
        rubricDigest: digestCanonicalJson({ verifier: verifier.id, rule: "output-schema" }),
        verifiedAt: now(),
      };
      return Promise.resolve(
        VerificationResultSchema.parse({
          ...material,
          verificationDigest: digestCanonicalJson(material),
        }),
      );
    },
  });
}

function createEvidenceBuilder(
  stores: ReturnType<typeof createMemoryStoreSuite>,
  now: () => string,
  ids: ReturnType<typeof idGenerator>,
  records: Map<string, EvidenceRecord>,
): EvidenceBuilder {
  return Object.freeze({
    async build(input: Parameters<EvidenceBuilder["build"]>[0]): Promise<EvidenceRecord> {
      const workOrder = await stores.acceptedWorkOrderStore.get(
        input.run.tenantId,
        input.run.workOrderId,
      );
      if (workOrder === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
      if (workOrder.dataClass === "highly_restricted") {
        throw new KafError("KAF_STORAGE_SECURITY_PROFILE");
      }
      const at = now();
      const verifierReferences = new Map(
        input.verifications.map((verification) => {
          const reference = verificationResultIdentity(verification);
          return [
            canonicalJsonStringify([
              reference.id,
              reference.version,
              reference.verifierRegistrationDigest,
              reference.rubricVersion,
              reference.rubricDigest,
            ]),
            reference,
          ] as const;
        }),
      );
      const record = buildEvidenceRecord({
        material: {
          schemaVersion: "1",
          evidenceRecordId: ids.generate("evidence"),
          tenantId: input.run.tenantId,
          runId: input.run.runId,
          executionDefinition: input.run.executionDefinition,
          executionDefinitionDigest: input.run.executionDefinitionDigest,
          workOrderBindingDigest: input.run.workOrderBindingDigest,
          claim: {
            statement: "The run produced an artifact that passed its registered local verifiers.",
            claimType: "run_output_verification",
            scope: "this run and exact artifact only",
          },
          supports: ["The exact output artifact passed the registered local verifier set."],
          doesNotProve: [
            "The artifact is factually correct, production-safe, or evidence of a reusable pattern.",
          ],
          context: {
            roleFamily: workOrder.context.roleFamily,
            workflowId: workOrder.context.workflowId,
            riskClass: workOrder.context.riskClass,
            purposeCode: workOrder.purpose.code,
          },
          workSplit: {
            ai: { kind: "unavailable", reason: "not_collected" },
            human: { kind: "unavailable", reason: "not_collected" },
            description: "Work split was not measured by the local runtime.",
          },
          permission: {
            purposeCode: workOrder.purpose.code,
            purposeRegistryVersion: workOrder.purpose.registryVersion,
            visibility: "private",
            dataClass: workOrder.dataClass,
            retention:
              workOrder.retention.mode === "host_policy"
                ? { mode: "policy", policyId: workOrder.retention.policyId }
                : workOrder.retention,
          },
          freshness: { observedAt: at, validAt: at },
          observation: {
            firstObservedAt: at,
            lastObservedAt: at,
            count: 1,
            repetitionStatus: "single",
            independentObservationIds: [],
          },
          createdAt: at,
        },
        artifacts: input.artifacts,
        events: input.events,
        verifications: input.verifications,
        verifierReferences: [...verifierReferences.values()],
      });
      records.set(canonicalJsonStringify([input.run.tenantId, input.run.runId]), record);
      return record;
    },
  });
}

function createFacadeWriteStrategy(
  tool: ReturnType<typeof getAgentRuntimeMetadata>["tools"][number],
  broker: EgressBroker,
  now: () => string,
): RuntimeExecutableEffectStrategy {
  const effect = getToolEffectDefinition(tool);
  if (effect === undefined) throw new TypeError("KAF_TOOL_NOT_COMPILED_BY_FACADE");
  const registration = tool.registration;
  const strategy: RuntimeExecutableEffectStrategy = {
    kind: "none",
    registrationDigest: registration.effectStrategyRegistrationDigest,
    previewRegistrationDigest: effect.previewRegistrationDigest,
    preview: (value: JsonValue) => Promise.resolve(buildFacadeWritePreview(tool, value)),
    validateOutput: (result: unknown) => JsonValueSchema.parse(tool.output.parse(result)),
    async dispatch(value, context) {
      const executionContext: ToolExecutionContext = {
        signal: context.signal,
        run: {
          tenantId: context.tenantId,
          runId: context.runId,
          stepId: context.stepId,
          purposeCode: context.purposeCode,
          dataClass: context.dataClass,
        },
        egress: broker.bind({
          tenantId: context.tenantId,
          runId: context.runId,
          toolRegistrationDigest: registration.toolRegistrationDigest,
        }),
        artifacts: {
          write: () => Promise.reject(new KafError("KAF_RUNTIME_CAPABILITY_MISSING")),
        },
      };
      const result = await effect.execute(value, executionContext);
      const acknowledgementMaterial = {
        schemaVersion: "1" as const,
        acknowledgementId: context.effectId,
        proofKind: "successful_response" as const,
        effectKey: context.effectKey,
        toolRegistrationDigest: registration.toolRegistrationDigest,
        strategyRegistrationDigest: registration.effectStrategyRegistrationDigest,
        normalizedTargetDigest: context.normalizedTargetDigest,
        resultSchemaDigest: registration.outputSchemaDigest,
        resultDigest: digestCanonicalJson(result),
        safeReceiptMetadata: { executor: "pactmark.local-in-process" },
        acknowledgedAt: now(),
      };
      return {
        schemaVersion: "1" as const,
        result,
        acknowledgement: {
          ...acknowledgementMaterial,
          proofDigest: effectProofDigest(acknowledgementMaterial),
        },
      };
    },
  };
  return Object.freeze(strategy);
}

function buildFacadeWritePreview(
  tool: ReturnType<typeof getAgentRuntimeMetadata>["tools"][number],
  value: JsonValue,
) {
  const effect = getToolEffectDefinition(tool);
  if (effect === undefined) throw new TypeError("KAF_TOOL_NOT_COMPILED_BY_FACADE");
  const argumentsDigest = digestCanonicalJson(value);
  const material = {
    schemaVersion: "1" as const,
    normalizedTarget: facadeEffectTarget(tool.registration.toolRegistrationDigest, argumentsDigest),
    operationClass: `${tool.registration.id}.write`,
    contentDigest: argumentsDigest,
    reversibility: effect.reversibility,
    materialConsequence: effect.materialConsequence,
    approvalDisplay: effect.renderApprovalDisplay(value),
  };
  return Object.freeze({ ...material, previewDigest: digestCanonicalJson(material) });
}

/**
 * Development-only authority for the ephemeral local profile: each governed
 * effect receives a one-use capability grant and a reservation bound to the
 * exact effect key. Production hosts own real grant and approval issuance.
 */
function createLocalEffectAuthorization(
  stores: ReturnType<typeof createMemoryStoreSuite>,
  now: () => string,
): RuntimeEffectAuthorizationResolver {
  const issuedTimings = new Map<string, Readonly<{ issuedAt: string; expiresAt: string }>>();
  const resolver: RuntimeEffectAuthorizationResolver = {
    async resolve(request) {
      const grantId = `grant-effect-${request.effectId}`;
      const existing = issuedTimings.get(grantId);
      const issuedAt = existing?.issuedAt ?? now();
      const timing = existing ?? {
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
      };
      issuedTimings.set(grantId, timing);
      await stores.capabilityGrantStore.issue({
        schemaVersion: "1",
        id: grantId,
        issuerId: "pactmark.local-runtime",
        principal: request.workOrder.principal,
        tenant: request.workOrder.tenant,
        workOrderId: request.workOrder.id,
        workOrderBindingDigest: request.workOrder.workOrderBindingDigest,
        executionDefinition: request.workOrder.executionDefinition,
        executionDefinitionDigest: request.workOrder.executionDefinitionDigest,
        capability: request.registration.id,
        action: "write",
        toolId: request.registration.id,
        toolVersion: request.registration.implementationVersion,
        toolRegistrationDigest: request.registration.toolRegistrationDigest,
        normalizedResources: [
          {
            kind: "tenant",
            value: request.workOrder.tenant.id,
            normalizationVersion: "pactmark.policy-normalization@1",
          },
        ],
        purpose: request.workOrder.purpose,
        policyRegistrationDigest: request.policyRegistrationDigest,
        maximumUses: 1,
        issuedAt: timing.issuedAt,
        expiresAt: timing.expiresAt,
      });
      return {
        schemaVersion: "1",
        authorizationReservationId: `authorization-${request.effectId}`,
        authorizationKey: request.authorizationKey,
        tenantId: request.workOrder.tenant.id,
        runId: request.projection.runId,
        stepId: request.stepId,
        toolCallId: request.toolCallId,
        effectKey: request.effectKey,
        workOrderBindingDigest: request.workOrder.workOrderBindingDigest,
        executionDefinition: request.workOrder.executionDefinition,
        executionDefinitionDigest: request.workOrder.executionDefinitionDigest,
        toolId: request.registration.id,
        toolVersion: request.registration.implementationVersion,
        toolRegistrationDigest: request.registration.toolRegistrationDigest,
        policyRegistrationDigest: request.policyRegistrationDigest,
        argumentsDigest: request.argumentsDigest,
        normalizedTargetDigest: request.normalizedTargetDigest,
        grantId,
        ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
        secretRefIds: [],
        purposeCode: request.workOrder.purpose.code,
        purposeRegistryVersion: request.workOrder.purpose.registryVersion,
        state: "reserved",
        createdAt: timing.issuedAt,
        expiresAt: timing.expiresAt,
      };
    },
  };
  return Object.freeze(resolver);
}

function createToolComposition(agents: readonly DefinedAgent[], now: () => string) {
  const tools = new Map<string, ReturnType<typeof getAgentRuntimeMetadata>["tools"][number]>();
  for (const agent of agents) {
    for (const tool of getAgentRuntimeMetadata(agent).tools) {
      const current = tools.get(tool.registration.toolRegistrationDigest);
      if (current !== undefined && current !== tool) {
        throw new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT");
      }
      tools.set(tool.registration.toolRegistrationDigest, tool);
    }
  }
  const denyAllEgress = createDenyAllEgressBroker();
  const brokers = new Map(
    [...tools.values()].map((tool) => {
      const digest = tool.registration.toolRegistrationDigest;
      const egress = tool.security.egress;
      const broker =
        egress.mode === "allowlist"
          ? createDeclaredAllowlistEgressBroker({
              allowedOrigins: egress.destinations,
              allowedMethods: egress.methods,
              authorizeBinding: (binding) => binding.toolRegistrationDigest === digest,
              fetch: globalThis.fetch.bind(globalThis),
            })
          : denyAllEgress;
      return [digest, broker] as const;
    }),
  );
  const brokerFor = (tool: ReturnType<typeof getAgentRuntimeMetadata>["tools"][number]) =>
    brokers.get(tool.registration.toolRegistrationDigest) ?? denyAllEgress;
  const strategies = new Map<string, RuntimeExecutableEffectStrategy>();
  for (const tool of tools.values()) {
    if (getToolEffectDefinition(tool) !== undefined) {
      strategies.set(
        tool.registration.toolRegistrationDigest,
        createFacadeWriteStrategy(tool, brokerFor(tool), now),
      );
    }
  }
  const declared: DeclaredTool[] = [...tools.values()]
    .filter((tool) => getToolEffectDefinition(tool) === undefined)
    .map((tool) => ({
      registration: tool.registration,
      async execute(input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
        const runtimeDefinition = getToolRuntimeDefinition(tool);
        const context: ToolExecutionContext = {
          signal,
          run: {
            tenantId: "local",
            runId: "local-in-process",
            stepId: "local-in-process",
            purposeCode: "service_delivery",
            dataClass: "public",
          },
          egress: brokerFor(tool).bind({
            tenantId: "local",
            runId: "local-in-process",
            toolRegistrationDigest: tool.registration.toolRegistrationDigest,
          }),
          artifacts: {
            write: () => Promise.reject(new KafError("KAF_RUNTIME_CAPABILITY_MISSING")),
          },
        };
        return runtimeDefinition.execute(input, context);
      },
    }));
  const resolver: ToolCallResolver = Object.freeze({
    resolve({
      workOrder,
      registration,
      proposedInput,
    }: Parameters<ToolCallResolver["resolve"]>[0]) {
      const tool = tools.get(registration.toolRegistrationDigest);
      if (tool === undefined || tool.registration.id !== registration.id) {
        return Promise.reject(new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH"));
      }
      const resolved = getToolRuntimeDefinition(tool).resolve(proposedInput, {
        tenantId: workOrder.tenant.id,
        purposeCode: workOrder.purpose.code,
        dataClass: workOrder.dataClass,
      });
      return Promise.resolve(resolved);
    },
  });
  const previewer: DecisionPreviewer = {
    async preview(input) {
      await Promise.resolve();
      const tool = tools.get(input.toolRegistrationDigest);
      if (tool === undefined || digestCanonicalJson(input.value) !== input.argumentsDigest) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "local_decision_preview_binding_changed" },
        });
      }
      if (getToolEffectDefinition(tool) === undefined) {
        const material = {
          schemaVersion: "1" as const,
          operationClass: `${tool.registration.id}.read`,
          toolRegistrationDigest: tool.registration.toolRegistrationDigest,
          argumentsDigest: input.argumentsDigest,
          targetDigest: input.targetDigest,
        };
        return DecisionPreviewReferenceSchema.parse({
          schemaVersion: "1",
          previewDigest: digestCanonicalJson(material),
        });
      }
      const preview = buildFacadeWritePreview(tool, JsonValueSchema.parse(input.value));
      if (digestCanonicalJson(preview.normalizedTarget) !== input.targetDigest) {
        throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
          details: { reason: "local_decision_preview_target_changed" },
        });
      }
      return DecisionPreviewReferenceSchema.parse({
        schemaVersion: "1",
        previewDigest: preview.previewDigest,
        contentDigest: preview.contentDigest,
        approvalDisplay: preview.approvalDisplay,
      });
    },
  };
  return {
    registry: {
      resolve: (digest: string) => tools.get(digest)?.registration,
    },
    executor: createDeclaredToolExecutor(declared),
    resolver,
    strategies,
    previewer: Object.freeze(previewer),
  };
}

function dispatchingModel(agents: readonly DefinedAgent[]) {
  const models = new Map(
    agents.map((agent) => {
      const model = getAgentRuntimeMetadata(agent).model;
      const driver = model.bindAgentContext?.(agentModelContext(agent)) ?? model.driver;
      return [agent.agentDefinitionDigest, driver] as const;
    }),
  );
  return Object.freeze({
    capabilities: LOCAL_CAPABILITIES,
    invoke(
      request: Parameters<
        ReturnType<typeof getAgentRuntimeMetadata>["model"]["driver"]["invoke"]
      >[0],
    ) {
      const driver = models.get(
        request.run.executionDefinition.kind === "agent"
          ? request.run.executionDefinition.agentDefinitionDigest
          : "",
      );
      if (driver === undefined) throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH");
      return driver.invoke(request);
    },
  });
}

function validateAgentStartInput(agent: AgentDefinition, request: WorkOrderRequest): void {
  const inputSchema = getAgentRuntimeMetadata(agent).input;
  if (inputSchema.identity.schemaIdentityDigest !== agent.inputSchemaDigest) {
    throw new KafError("KAF_RUNTIME_AGENT_DEFINITION_MISMATCH", {
      details: { reason: "agent_input_schema_digest_mismatch" },
    });
  }
  void parseWire(inputSchema.schema, request.input);
}

export interface RuntimeFacade {
  start(
    authority: AuthorityContext,
    agent: AgentDefinition,
    request: WorkOrderRequest,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ runId: string; workOrderId: string }>>;
  resume(
    authority: AuthorityContext,
    runId: string,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ runId: string; status: "completed" | "parked" | "failed" | "cancelled" }>>;
  getRun(authority: AuthorityContext, runId: string): Promise<RunProjection>;
  getEvidence(authority: AuthorityContext, runId: string): Promise<EvidenceRecord | undefined>;
  getArtifacts(
    authority: AuthorityContext,
    runId: string,
  ): Promise<readonly Readonly<{ artifact: Artifact; content: Uint8Array }>[]>;
  events(
    authority: AuthorityContext,
    runId: string,
    options?: Readonly<{ afterSequence?: number; signal?: AbortSignal }>,
  ): AsyncIterable<RunEvent>;
  submitInput(
    authority: AuthorityContext,
    runId: string,
    requestId: string,
    value: JsonValue,
    command: CommandContext,
  ): Promise<
    Readonly<{ inputSubmissionRecordId: string; runId: string; automaticResume: boolean }>
  >;
  issueDecisionChallenge(
    authority: AuthorityContext,
    runId: string,
    decisionId: string,
    command: CommandContext,
  ): Promise<Readonly<{ challengeProof: string; expiresAt: string }>>;
  approve(
    authority: AuthorityContext,
    runId: string,
    decision: JsonValue,
    command: CommandContext,
  ): Promise<Readonly<{ approvalId: string; runId: string; automaticResume: boolean }>>;
  reject(
    authority: AuthorityContext,
    runId: string,
    decision: JsonValue,
    command: CommandContext,
  ): Promise<Readonly<{ decisionId: string; runId: string; automaticResume: boolean }>>;
  reconcileEffect(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    resolution: JsonValue,
    command: CommandContext,
  ): Promise<Readonly<{ runId: string; effectId: string; status: "recovered" | "abandoned" }>>;
  requestCompensation(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    request: JsonValue,
    command: CommandContext,
  ): Promise<Readonly<{ compensationRunId: string }>>;
  cancel(
    authority: AuthorityContext,
    runId: string,
    reasonOrCommand: JsonValue | CommandContext,
    command?: CommandContext,
  ): Promise<RunProjection>;
  getCapabilities(): RuntimeCapabilities;
  evaluateReadiness(input: Readonly<{ profile: RuntimeReadinessProfile }>): RuntimeReadinessReport;
}

export interface LocalRunOptions {
  readonly input: JsonValue;
  readonly goal?: string;
  readonly tenantId?: string;
  readonly principalId?: string;
  readonly budget?: WorkBudget;
  /** Required when createLocalRuntime received an external authority issuer. */
  readonly authority?: AuthorityContext;
  readonly signal?: AbortSignal;
}

export interface LocalRunResult {
  readonly runId: string;
  readonly status: RunProjection["status"];
  /** Parsed final artifact content when the run completed; undefined otherwise. */
  readonly output: JsonValue | undefined;
  readonly projection: RunProjection;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly Readonly<{ artifact: Artifact; content: Uint8Array }>[];
  readonly evidence: EvidenceRecord | undefined;
}

export interface LocalRuntimeFacade extends RuntimeFacade {
  wait(authority: AuthorityContext, runId: string): Promise<RunProjection>;
  /**
   * Ephemeral-profile convenience: issues local authority and builds the
   * WorkOrder with conservative defaults (purpose service_delivery, data
   * class public, session retention, assist modes, low risk context, and
   * requested capabilities equal to the agent's declared tool scopes). The
   * production path keeps every one of these explicit.
   */
  run(agent: AgentDefinition, options: LocalRunOptions): Promise<LocalRunResult>;
}

export interface CreateLocalRuntimeInput {
  readonly agents: readonly DefinedAgent[];
  /** Defaults to a development-only local authority issuer. */
  readonly authorityIssuer?: AuthorityIssuer;
  readonly killSwitches?: KillSwitchRegistry;
}

const DEFAULT_LOCAL_RUN_BUDGET: WorkBudget = Object.freeze({
  maxTurns: 8,
  maxModelCalls: 8,
  maxToolCalls: 8,
  maxActiveExecutionMs: 60_000,
});

export function createLocalRuntime(input: CreateLocalRuntimeInput): LocalRuntimeFacade {
  if (input.agents.length === 0) throw new TypeError("At least one compiled agent is required");
  const localAuthority =
    input.authorityIssuer === undefined ? createLocalAuthorityIssuer() : undefined;
  const authorityIssuer =
    input.authorityIssuer ?? (localAuthority as NonNullable<typeof localAuthority>).issuer;
  const localClock = clock();
  const ids = idGenerator();
  const contextProtector = processLocalContextProtector(ids);
  const stores = createMemoryStoreSuite({ now: localClock.now, dataProtector: contextProtector });
  const records = new Map<string, EvidenceRecord>();
  const toolComposition = createToolComposition(input.agents, localClock.now);
  const requiredCapabilities = requiredCapabilitiesForAgents(input.agents);
  const effectServices: RuntimeEffectServices | undefined =
    toolComposition.strategies.size === 0
      ? undefined
      : {
          store: stores.effectLedger,
          strategies: {
            resolve: (digest: string) => toolComposition.strategies.get(digest),
          },
          authorization: createLocalEffectAuthorization(stores, localClock.now),
        };
  const capabilities: RuntimeCapabilities = Object.freeze({
    ...LOCAL_CAPABILITIES,
    effectReconciliation: effectServices !== undefined,
  });
  const decisionChallengeIssuer = createProcessLocalDecisionChallengeIssuer(
    authorityIssuer,
    localClock.now,
    ids,
  );
  const kernel = createKernelRuntime({
    authorityIssuer,
    ...(effectServices === undefined
      ? {}
      : { effectServices, effectResultProtector: contextProtector }),
    agentRegistry: new FacadeAgentRegistry(input.agents),
    purposeRegistry: {
      version: "general@1",
      has: (code) => code === "service_delivery",
    },
    acceptedWorkOrderStore: stores.acceptedWorkOrderStore,
    eventStore: stores.eventStore,
    artifactStore: stores.artifactStore,
    contextStore: stores.contextStore,
    contextProtector,
    contextCheckpointTransactionDomain: stores.runCommandUnitOfWork.transactionDomain,
    leaseStore: stores.leaseStore,
    runCommandUnitOfWork: stores.runCommandUnitOfWork,
    decisionStore: stores.decisionStore,
    decisionChallengeIssuer,
    decisionPreviewer: toolComposition.previewer,
    modelDriver: dispatchingModel(input.agents),
    toolRegistry: toolComposition.registry,
    toolCallResolver: toolComposition.resolver,
    policyEngine: createAgentPolicyPreflightEngine(input.agents, input.killSwitches),
    ...(input.killSwitches === undefined ? {} : { killSwitches: input.killSwitches }),
    toolExecutor: toolComposition.executor,
    verifierRegistry: createVerifierRegistry(input.agents, localClock.now, ids),
    evidenceBuilder: createEvidenceBuilder(stores, localClock.now, ids, records),
    clock: localClock,
    idGenerator: ids,
    leaseHolderId: ids.generate("local-runtime"),
  });
  const executions = new Map<string, Promise<unknown>>();
  const facade: LocalRuntimeFacade = {
    async start(authority, agent, request, command, options) {
      validateAgentStartInput(agent, request);
      const started = await kernel.start(authority, agent, request, command);
      const execution = Promise.resolve().then(() =>
        options === undefined
          ? kernel.execute(authority, started.runId)
          : kernel.execute(authority, started.runId, options),
      );
      executions.set(started.runId, execution);
      void execution.then(
        () => executions.delete(started.runId),
        () => undefined,
      );
      return started;
    },
    resume: (authority, runId, command, options) =>
      kernel.resume(authority, runId, command, options),
    getRun: (authority, runId) => kernel.getRun(authority, runId),
    events: (authority, runId, options) => kernel.events(authority, runId, options),
    submitInput: (authority, runId, requestId, value, command) =>
      kernel.submitInput(authority, runId, requestId, value, command),
    issueDecisionChallenge: (authority, runId, decisionId, command) =>
      kernel.issueDecisionChallenge(authority, runId, decisionId, command),
    approve: (authority, runId, decision, command) =>
      kernel.approve(authority, runId, decision, command),
    reject: (authority, runId, decision, command) =>
      kernel.reject(authority, runId, decision, command),
    reconcileEffect: (authority, runId, effectId, resolution, command) =>
      kernel.reconcileEffect(authority, runId, effectId, resolution, command),
    requestCompensation: (authority, runId, effectId, request, command) =>
      kernel.requestCompensation(authority, runId, effectId, request, command),
    cancel: (authority, runId, reasonOrCommand, command) =>
      command === undefined
        ? kernel.cancel(authority, runId, reasonOrCommand as CommandContext)
        : kernel.cancel(authority, runId, cancellationReason(reasonOrCommand), command),
    getCapabilities: () => capabilities,
    evaluateReadiness: ({ profile }) =>
      evaluateRuntimeReadiness({
        profile,
        capabilities,
        requiredCapabilities,
        evaluatedAt: localClock.now(),
      }),
    async getEvidence(authority, runId) {
      const run = await kernel.getRun(authority, runId);
      return records.get(canonicalJsonStringify([run.tenantId, runId]));
    },
    async getArtifacts(authority, runId) {
      const run = await kernel.getRun(authority, runId);
      const artifacts = await Promise.all(
        run.artifactIds.map((artifactId) => stores.artifactStore.get(run.tenantId, artifactId)),
      );
      return artifacts.filter(
        (artifact): artifact is Readonly<{ artifact: Artifact; content: Uint8Array }> =>
          artifact !== undefined,
      );
    },
    async wait(authority, runId) {
      const execution = executions.get(runId);
      if (execution !== undefined) {
        try {
          await execution;
        } finally {
          executions.delete(runId);
        }
      }
      return kernel.getRun(authority, runId);
    },
    async run(agent, options) {
      const metadata = getAgentRuntimeMetadata(agent);
      const tenantId = options.tenantId ?? "local";
      const authority =
        options.authority ??
        localAuthority?.issue({
          principal: { type: "user", id: options.principalId ?? "local-user" },
          tenant: { id: tenantId },
        });
      if (authority === undefined) {
        throw new TypeError(
          "run() requires options.authority when createLocalRuntime received an external authority issuer",
        );
      }
      const requestedCapabilities = [
        ...new Set(metadata.tools.flatMap((tool) => tool.security.requiredScopes)),
      ].sort();
      const request = createWorkOrderRequest({
        agent: { id: agent.id, version: agent.version },
        goal: options.goal ?? `Run agent ${agent.id}`,
        input: options.input,
        context: {
          roleFamily: "development",
          workflowId: `${agent.id}.local-run`,
          riskClass: "low",
        },
        workMode: "assist",
        autonomyMode: "assist",
        decisionOwner: { mode: "requesting_principal" },
        purpose: { code: "service_delivery", registryVersion: "general@1" },
        dataClass: "public",
        retention: { mode: "session" },
        requestedCapabilities,
        resourceScopeCeiling: [
          {
            kind: "tenant",
            value: tenantId,
            normalizationVersion: "pactmark.policy-normalization@1",
          },
        ],
        budget: options.budget ?? DEFAULT_LOCAL_RUN_BUDGET,
      });
      const command = createCommandContext({
        commandId: createCommandId(),
        operation: "run.start",
        payload: request,
      });
      const { runId } = await facade.start(
        authority,
        agent,
        request,
        command,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      const projection = await facade.wait(authority, runId);
      const events: RunEvent[] = [];
      for await (const event of kernel.events(authority, runId)) events.push(event);
      const artifacts = await facade.getArtifacts(authority, runId);
      const evidence = await facade.getEvidence(authority, runId);
      let output: JsonValue | undefined;
      const finalArtifact = artifacts.at(-1);
      if (projection.status === "completed" && finalArtifact !== undefined) {
        output = parseJsonStrict(new TextDecoder().decode(finalArtifact.content));
      }
      return Object.freeze({
        runId,
        status: projection.status,
        output,
        projection,
        events,
        artifacts,
        evidence,
      });
    },
  };
  return Object.freeze(facade);
}

export interface CreateRuntimeInput extends RuntimeKernelConfig {
  readonly contextStore: ContextStore;
  readonly inputSubmissionStore: InputSubmissionStore;
  /**
   * @deprecated Configure egress inside the tool executor or effect strategy that
   * actually performs network I/O. The runtime kernel does not dispatch HTTP.
   */
  readonly egressBroker?: EgressBroker;
  readonly requiredRuntimeCapabilities?: readonly string[];
  readonly evidenceReader?: Readonly<{
    get(tenantId: string, runId: string): Promise<EvidenceRecord | undefined>;
  }>;
}

function productionCapabilities(input: CreateRuntimeInput): RuntimeCapabilities {
  const stores = [
    input.acceptedWorkOrderStore.capabilities,
    input.eventStore.capabilities,
    input.artifactStore.capabilities,
    input.contextStore.capabilities,
    input.inputSubmissionStore.capabilities,
  ];
  const durableStorage = stores.every((capabilities) => capabilities.durableStorage);
  return RuntimeCapabilitiesSchema.parse({
    schemaVersion: "1",
    executionProfile: durableStorage ? "durable" : "resumable",
    durableStorage,
    protectedContext:
      input.contextStore.capabilities.protectedContext &&
      input.contextProtector !== undefined &&
      input.contextCheckpointTransactionDomain === input.runCommandUnitOfWork.transactionDomain,
    protectedWorkOrders: input.acceptedWorkOrderStore.capabilities.protectedWorkOrders,
    protectedInputSubmissions: input.inputSubmissionStore.capabilities.protectedInputSubmissions,
    streaming: true,
    cancellation: true,
    sandbox: input.toolExecutor.capabilities.sandbox,
    networkPolicy: input.toolExecutor.networkPolicy,
    backgroundWakeup: input.wakeupScheduler?.capabilities.backgroundWakeup ?? false,
    atomicCommandAndWakeup: input.runCommandUnitOfWork.atomicCommandAndWakeup,
    humanDecisions:
      input.decisionStore !== undefined &&
      input.decisionChallengeIssuer !== undefined &&
      input.decisionPreviewer !== undefined,
    typedInput: input.inputSubmissionStore.capabilities.typedInput,
    effectReconciliation: input.effectServices !== undefined,
    compensation:
      input.effectServices !== undefined &&
      input.compensationServices !== undefined &&
      input.compensationServices.transactionDomain === input.runCommandUnitOfWork.transactionDomain,
    modelCredentials:
      input.productionModelServices !== undefined &&
      input.productionModelServices.reservations.durable &&
      input.productionModelServices.reservations.transactionDomain ===
        input.runCommandUnitOfWork.transactionDomain,
    // Tool credentials are adapter-owned today. Do not inherit an executor's
    // claim until the kernel has a bound reservation/claim port for them.
    toolCredentials: false,
    telemetry: "none",
    transactionDomains: [input.runCommandUnitOfWork.transactionDomain],
  });
}

/** Explicit production-shaped constructor. Every runtime dependency remains required. */
export function createRuntime(input: CreateRuntimeInput): RuntimeFacade {
  const capabilities = productionCapabilities(input);
  const requiredCapabilities = [...(input.requiredRuntimeCapabilities ?? [])];
  const kernel = createKernelRuntime({ ...input, requireProductionModelBoundary: true });
  const facade: RuntimeFacade = {
    async start(authority, agent, request, command) {
      validateAgentStartInput(agent, request);
      return kernel.start(authority, agent, request, command);
    },
    resume: (authority, runId, command, options) =>
      kernel.resume(authority, runId, command, options),
    getRun: (authority, runId) => kernel.getRun(authority, runId),
    async getEvidence(authority, runId) {
      const run = await kernel.getRun(authority, runId);
      return input.evidenceReader?.get(run.tenantId, runId);
    },
    async getArtifacts(authority, runId) {
      const run = await kernel.getRun(authority, runId);
      const artifacts = await Promise.all(
        run.artifactIds.map((artifactId) => input.artifactStore.get(run.tenantId, artifactId)),
      );
      return artifacts.filter(
        (artifact): artifact is Readonly<{ artifact: Artifact; content: Uint8Array }> =>
          artifact !== undefined,
      );
    },
    events: (authority, runId, options) => kernel.events(authority, runId, options),
    submitInput: (authority, runId, requestId, value, command) =>
      kernel.submitInput(authority, runId, requestId, value, command),
    issueDecisionChallenge: (authority, runId, decisionId, command) =>
      kernel.issueDecisionChallenge(authority, runId, decisionId, command),
    approve: (authority, runId, decision, command) =>
      kernel.approve(authority, runId, decision, command),
    reject: (authority, runId, decision, command) =>
      kernel.reject(authority, runId, decision, command),
    reconcileEffect: (authority, runId, effectId, resolution, command) =>
      kernel.reconcileEffect(authority, runId, effectId, resolution, command),
    requestCompensation: (authority, runId, effectId, request, command) =>
      kernel.requestCompensation(authority, runId, effectId, request, command),
    cancel: (authority, runId, reasonOrCommand, command) =>
      command === undefined
        ? kernel.cancel(authority, runId, reasonOrCommand as CommandContext)
        : kernel.cancel(authority, runId, cancellationReason(reasonOrCommand), command),
    getCapabilities: () => capabilities,
    evaluateReadiness: ({ profile }) =>
      evaluateRuntimeReadiness({
        profile,
        capabilities,
        requiredCapabilities,
        evaluatedAt: input.clock.now(),
        admissionConfigured: input.admissionController !== undefined,
        activeExecutionConfigured:
          input.activeExecutionServices?.durable === true &&
          input.activeExecutionServices.transactionDomain ===
            input.runCommandUnitOfWork.transactionDomain,
      }),
  };
  return Object.freeze(facade);
}

function cancellationReason(value: JsonValue | CommandContext): string {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  if (typeof record?.["reason"] === "string") {
    return record["reason"];
  }
  throw new KafError("KAF_SCHEMA_INVALID", {
    details: { path: "reason", issue: "required_string" },
  });
}
