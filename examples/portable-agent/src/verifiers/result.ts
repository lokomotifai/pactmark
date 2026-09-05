import type { PortableSuccess } from "../contract.js";
export function verifyPortableResult(result: PortableSuccess): boolean {
  const eventTypes = new Set(result.events.map(({ type }) => type));
  return (
    result.events.every(({ sequence }, index) => sequence === index + 1) &&
    [
      "RunAccepted",
      "ToolCallRequested",
      "ToolCallCompleted",
      "ArtifactProduced",
      "VerificationRecorded",
      "RunCompleted",
    ].every((type) => eventTypes.has(type)) &&
    result.artifactContentDigest.startsWith("sha256:") &&
    result.evidenceProduced
  );
}
