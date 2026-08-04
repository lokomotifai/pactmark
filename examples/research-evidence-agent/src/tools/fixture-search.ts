import type { ResearchSource } from "../contract.js";
const sources: readonly ResearchSource[] = Object.freeze([
  Object.freeze({
    id: "fixture-release-note",
    title: "Fixture release note",
    url: "https://example.invalid/releases/fixture",
    publishedAt: "2025-12-15T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:00.000Z",
    body: "The fixture package supports deterministic offline verification.",
  }),
]);
export function searchFixture(query: string): readonly ResearchSource[] {
  if (query.trim() === "") throw new TypeError("KAF_RESEARCH_QUERY_INVALID");
  return sources.filter((source) => source.body.toLowerCase().includes(query.toLowerCase()));
}
export function createExternalSearchAdapter(options: Readonly<{ allowNetwork: boolean }>): never {
  if (!options.allowNetwork) throw new TypeError("KAF_RESEARCH_NETWORK_DISABLED");
  throw new TypeError("KAF_RESEARCH_EXTERNAL_ADAPTER_NOT_CONFIGURED");
}
