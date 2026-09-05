import {
  VerificationResultSchema,
  digestBytes,
  digestCanonicalJson,
  parseJsonStrict,
  type Artifact,
  type Digest,
  type JsonValue,
  type VerificationResult,
} from "@pactmark/core";
import { z } from "zod";

export type VerificationMethod = VerificationResult["method"];
export type VerificationFinding = VerificationResult["findings"][number];

export interface VerifierDefinition {
  readonly id: string;
  readonly version: string;
  readonly verifierRegistrationDigest: Digest;
  readonly rubricVersion: string;
  readonly rubricDigest: Digest;
  readonly method: VerificationMethod;
  readonly highRiskSufficient: boolean;
  verify(artifact: Artifact, content: Uint8Array): readonly VerificationFinding[];
}

export type VerifierReferenceIdentity = Readonly<
  Pick<
    VerifierDefinition,
    "id" | "version" | "verifierRegistrationDigest" | "rubricVersion" | "rubricDigest"
  >
>;

function verifierVersionKey(id: string, version: string): string {
  return digestCanonicalJson([id, version]);
}

function result(
  definition: VerifierDefinition,
  artifact: Artifact,
  findings: readonly VerificationFinding[],
  verifiedAt: string,
  verificationId: string,
  reviewerId?: string,
): VerificationResult {
  if (definition.method === "human" && reviewerId === undefined) {
    throw new TypeError("KAF_HUMAN_REVIEWER_REQUIRED");
  }
  const status = findings.some((finding) => finding.severity === "error")
    ? "fail"
    : definition.method === "model" && !definition.highRiskSufficient
      ? "needs_review"
      : "pass";
  const material = {
    schemaVersion: "1" as const,
    status,
    verificationId,
    verifierId: definition.id,
    verifierVersion: definition.version,
    verifierRegistrationDigest: definition.verifierRegistrationDigest,
    method: definition.method,
    artifactDigest: artifact.artifactDigest,
    findings: [...findings],
    rubricVersion: definition.rubricVersion,
    rubricDigest: definition.rubricDigest,
    verifiedAt,
    ...(reviewerId === undefined ? {} : { reviewerId }),
  };
  return VerificationResultSchema.parse({
    ...material,
    verificationDigest: digestCanonicalJson(material),
  });
}

export class VerifierRegistry {
  readonly #definitions = new Map<string, VerifierDefinition>();

  register(definition: VerifierDefinition): void {
    const key = verifierVersionKey(definition.id, definition.version);
    const current = this.#definitions.get(key);
    if (
      current !== undefined &&
      (current.verifierRegistrationDigest !== definition.verifierRegistrationDigest ||
        current.rubricDigest !== definition.rubricDigest)
    ) {
      throw new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT");
    }
    if (current === undefined) this.#definitions.set(key, Object.freeze(definition));
  }

  has(id: string, version: string): boolean {
    return this.#definitions.has(verifierVersionKey(id, version));
  }

  verify(
    id: string,
    version: string,
    artifact: Artifact,
    content: Uint8Array,
    context: Readonly<{ verifiedAt: string; verificationId: string; reviewerId?: string }>,
  ): VerificationResult {
    const definition = this.#definitions.get(verifierVersionKey(id, version));
    if (definition === undefined) throw new TypeError("KAF_VERIFIER_NOT_REGISTERED");
    return result(
      definition,
      artifact,
      definition.verify(artifact, content),
      context.verifiedAt,
      context.verificationId,
      context.reviewerId,
    );
  }
}

function finding(
  code: string,
  severity: "info" | "warning" | "error",
  safeMessage: string,
  path?: string,
): VerificationFinding {
  return {
    schemaVersion: "1",
    code,
    severity,
    safeMessage,
    ...(path === undefined ? {} : { path }),
  };
}

export function createArtifactIntegrityVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricDigest: Digest;
}): VerifierDefinition {
  return {
    ...identity,
    rubricVersion: "1",
    method: "deterministic",
    highRiskSufficient: true,
    verify: (artifact, content) =>
      digestBytes(content) === artifact.contentDigest && content.byteLength === artifact.byteSize
        ? []
        : [finding("KAF_VERIFY_ARTIFACT_INTEGRITY", "error", "Artifact integrity check failed")],
  };
}

export function createSchemaConformanceVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricDigest: Digest;
  schema: z.ZodType;
}): VerifierDefinition {
  return {
    ...identity,
    rubricVersion: "1",
    method: "deterministic",
    highRiskSufficient: true,
    verify: (_artifact, content) => {
      try {
        const parsed = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(content));
        const outcome = identity.schema.safeParse(parsed);
        return outcome.success
          ? []
          : [
              finding(
                "KAF_VERIFY_SCHEMA",
                "error",
                "Artifact does not match the declared schema",
                outcome.error.issues[0]?.path.join(".") ?? "$",
              ),
            ];
      } catch {
        return [finding("KAF_VERIFY_SCHEMA", "error", "Artifact is not valid UTF-8 JSON")];
      }
    },
  };
}

export function createRuleVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricVersion: string;
  rubricDigest: Digest;
  check(artifact: Artifact, content: Uint8Array): readonly VerificationFinding[];
}): VerifierDefinition {
  return {
    ...identity,
    method: "deterministic",
    highRiskSufficient: true,
    verify: (artifact, content) => identity.check(artifact, content),
  };
}

export function createCitationShapeVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricDigest: Digest;
}): VerifierDefinition {
  const CitationSchema = z.object({ title: z.string().min(1), url: z.url() }).strict();
  const DocumentSchema = z.object({ citations: z.array(CitationSchema).min(1) }).loose();
  return createRuleVerifier({
    ...identity,
    rubricVersion: "1",
    check: (_artifact, content) => {
      try {
        const parsed = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(content));
        const outcome = DocumentSchema.safeParse(parsed);
        if (!outcome.success)
          return [
            finding(
              "KAF_VERIFY_CITATION_SHAPE",
              "error",
              "At least one title and URL citation is required",
              "citations",
            ),
          ];
        return outcome.data.citations.some(
          (citation) => new URL(citation.url).protocol !== "https:",
        )
          ? [
              finding(
                "KAF_VERIFY_CITATION_PROTOCOL",
                "error",
                "Citation URLs must use HTTPS",
                "citations",
              ),
            ]
          : [
              finding(
                "KAF_VERIFY_CITATION_LIMIT",
                "info",
                "Citation shape is valid; source existence and truth were not verified",
              ),
            ];
      } catch {
        return [finding("KAF_VERIFY_CITATION_SHAPE", "error", "Citation artifact is invalid")];
      }
    },
  });
}

export function createModelAssessmentVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricVersion: string;
  rubricDigest: Digest;
  assess(artifact: Artifact, content: Uint8Array): readonly VerificationFinding[];
}): VerifierDefinition {
  return {
    ...identity,
    method: "model",
    highRiskSufficient: false,
    verify: (artifact, content) => [
      finding(
        "KAF_VERIFY_MODEL_ASSESSMENT_LIMIT",
        "info",
        "Model-assisted assessment is non-deterministic and not sufficient alone for high-risk completion",
      ),
      ...identity.assess(artifact, content),
    ],
  };
}

export function createHumanReviewVerifier(identity: {
  id: string;
  version: string;
  verifierRegistrationDigest: Digest;
  rubricVersion: string;
  rubricDigest: Digest;
  review(artifact: Artifact, content: Uint8Array): readonly VerificationFinding[];
}): VerifierDefinition {
  return {
    ...identity,
    method: "human",
    highRiskSufficient: true,
    verify: (artifact, content) => identity.review(artifact, content),
  };
}

export function verifierReferenceIdentity(
  definition: VerifierDefinition,
): VerifierReferenceIdentity {
  return Object.freeze({
    id: definition.id,
    version: definition.version,
    verifierRegistrationDigest: definition.verifierRegistrationDigest,
    rubricVersion: definition.rubricVersion,
    rubricDigest: definition.rubricDigest,
  });
}

export function verificationResultIdentity(
  resultValue: VerificationResult,
): VerifierReferenceIdentity {
  const result = VerificationResultSchema.parse(resultValue);
  return Object.freeze({
    id: result.verifierId,
    version: result.verifierVersion,
    verifierRegistrationDigest: result.verifierRegistrationDigest,
    rubricVersion: result.rubricVersion,
    rubricDigest: result.rubricDigest,
  });
}

export function verificationReference(resultValue: VerificationResult): JsonValue {
  return {
    verificationId: resultValue.verificationId,
    verificationDigest: resultValue.verificationDigest,
    verifierId: resultValue.verifierId,
    verifierVersion: resultValue.verifierVersion,
    verifierRegistrationDigest: resultValue.verifierRegistrationDigest,
    rubricVersion: resultValue.rubricVersion,
    rubricDigest: resultValue.rubricDigest,
    artifactDigest: resultValue.artifactDigest,
    status: resultValue.status,
    method: resultValue.method,
  };
}
