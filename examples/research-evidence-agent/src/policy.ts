export const researchPolicy = Object.freeze({
  default: "deny" as const,
  allowedRiskClasses: ["R1"] as const,
  tools: ["fixture.search@1"],
  networkDefault: "none" as const,
});
