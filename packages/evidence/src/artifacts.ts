import {
  ArtifactSchema,
  digestBytes,
  digestCanonicalJson,
  type Artifact,
  type Digest,
  type JsonValue,
} from "@pactmark/core";

export type CreateArtifactInput = Omit<Artifact, "artifactDigest" | "contentDigest" | "byteSize">;

export function createArtifact(input: CreateArtifactInput, content: Uint8Array): Artifact {
  const contentDigest = digestBytes(content);
  const material = {
    ...input,
    contentDigest,
    byteSize: content.byteLength,
  };
  return ArtifactSchema.parse({
    ...material,
    artifactDigest: digestCanonicalJson(material),
  });
}

export function verifyArtifactContent(artifact: Artifact, content: Uint8Array): boolean {
  return (
    content.byteLength === artifact.byteSize && digestBytes(content) === artifact.contentDigest
  );
}

export function artifactReference(artifact: Artifact): Readonly<{
  artifactId: string;
  artifactDigest: Digest;
}> {
  return { artifactId: artifact.artifactId, artifactDigest: artifact.artifactDigest };
}

export function artifactProvenanceSummary(artifact: Artifact): JsonValue {
  return {
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    contentDigest: artifact.contentDigest,
    producingRunId: artifact.producingRunId,
    producingStepId: artifact.producingStepId,
    executionDefinitionDigest: artifact.provenance.executionDefinitionDigest,
    workOrderBindingDigest: artifact.provenance.workOrderBindingDigest,
    sourceArtifactDigests: artifact.provenance.sourceArtifactDigests,
    toolRegistrationDigests: artifact.provenance.toolRegistrationDigests,
  };
}
