import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface LoopbackRegistryAvailability {
  readonly available: boolean;
  readonly code: "KAF_LOOPBACK_REGISTRY_READY" | "KAF_LOOPBACK_REGISTRY_DEPENDENCY_MISSING";
  readonly packageName: "verdaccio";
  readonly mutationPerformed: false;
}

export function inspectLoopbackRegistryAvailability(): LoopbackRegistryAvailability {
  try {
    require.resolve("verdaccio/package.json");
    return {
      available: true,
      code: "KAF_LOOPBACK_REGISTRY_READY",
      packageName: "verdaccio",
      mutationPerformed: false,
    };
  } catch {
    return {
      available: false,
      code: "KAF_LOOPBACK_REGISTRY_DEPENDENCY_MISSING",
      packageName: "verdaccio",
      mutationPerformed: false,
    };
  }
}
