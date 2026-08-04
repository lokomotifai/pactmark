import { describe, expect, it } from "vitest";

import { inspectLoopbackRegistryAvailability } from "../../tooling/loopback-registry/availability.mjs";

describe("loopback registry dependency", () => {
  it("reports Verdaccio as installed without mutating registry state", () => {
    expect(inspectLoopbackRegistryAvailability()).toEqual({
      available: true,
      code: "KAF_LOOPBACK_REGISTRY_READY",
      packageName: "verdaccio",
      mutationPerformed: false,
    });
  });
});
