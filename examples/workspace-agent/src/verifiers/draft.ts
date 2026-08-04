import { digestBytes } from "@pactmark/core";
import type { DraftArtifact } from "../contract.js";
export function createDraftArtifact(path: string, content: string): DraftArtifact {
  const bytes = new TextEncoder().encode(content);
  return Object.freeze({
    path,
    contentDigest: digestBytes(bytes),
    byteSize: bytes.byteLength,
    status: "draft",
  });
}
