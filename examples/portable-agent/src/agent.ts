import { digestCanonicalJson } from "@pactmark/core";
import type { PortableRequest, PortableResult } from "./contract.js";
import { portableCapabilities } from "./policy.js";
import { lookupCatalog } from "./tools/catalog.js";

export function runPortableAgent(request: PortableRequest): PortableResult {
  if (typeof request.sku !== "string" || request.sku.trim() === "")
    return { ok: false, errorCode: "KAF_EXAMPLE_INPUT_INVALID" };
  const item = lookupCatalog(request.sku);
  if (item === undefined) return { ok: false, errorCode: "KAF_EXAMPLE_SKU_NOT_FOUND" };
  const summary = `${item.name} is ${item.available ? "available" : "unavailable"}.`;
  return Object.freeze({
    ok: true as const,
    events: Object.freeze([
      { sequence: 1, type: "RunAccepted" as const },
      { sequence: 2, type: "ToolCompleted" as const },
      { sequence: 3, type: "ArtifactCreated" as const },
      { sequence: 4, type: "RunCompleted" as const },
    ]),
    toolOutput: Object.freeze({ ...item }),
    artifactDigest: digestCanonicalJson({
      mediaType: "application/json",
      content: { summary, item },
      capabilities: portableCapabilities,
    }),
    summary,
  });
}
