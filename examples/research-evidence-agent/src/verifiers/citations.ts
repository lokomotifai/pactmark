import { createCitationShapeVerifier, createArtifactIntegrityVerifier } from "@pactmark/evidence";
import { digestCanonicalJson } from "@pactmark/core";
export const integrityVerifier = createArtifactIntegrityVerifier({
  id: "research.integrity",
  version: "1",
  verifierRegistrationDigest: digestCanonicalJson({ id: "research.integrity", version: "1" }),
  rubricDigest: digestCanonicalJson({ rubric: "exact-bytes@1" }),
});
export const citationVerifier = createCitationShapeVerifier({
  id: "research.citations",
  version: "1",
  verifierRegistrationDigest: digestCanonicalJson({ id: "research.citations", version: "1" }),
  rubricDigest: digestCanonicalJson({ rubric: "https-title-shape@1" }),
});
