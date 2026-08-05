import { createLocalAuthorityIssuer, createLocalRuntime } from "@pactmark/agent";
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  createCloudflareWorker,
  type CloudflareExecutionContext,
} from "@pactmark/cloudflare";

import { cloudflareAgent } from "./agent.js";

export interface Env {
  readonly PACTMARK_PROFILE: "preview";
}

const principal = { type: "service" as const, id: "cloudflare-preview" };
const tenant = { id: "cloudflare-preview" };

type LocalRuntime = ReturnType<typeof createLocalRuntime>;
type Worker = ReturnType<typeof createCloudflareWorker>;

interface WorkerInstance {
  readonly runtime: LocalRuntime;
  readonly worker: Worker;
}

let workerInstance: WorkerInstance | undefined;

function getWorkerInstance(): WorkerInstance {
  if (workerInstance) return workerInstance;

  // Cloudflare forbids random-value generation while evaluating module global scope.
  // Initialize the development authority and its runtime inside the first request instead.
  const authorityIssuer = createLocalAuthorityIssuer();
  const authority = authorityIssuer.issue({ principal, tenant });
  const runtime = createLocalRuntime({
    agents: [cloudflareAgent],
    authorityIssuer: authorityIssuer.issuer,
  });
  const worker = createCloudflareWorker({
    basePath: "/api/agent",
    runtime,
    allowAnonymousDevelopment: true,
    anonymousAuthentication: { authority, principal, tenant, credentialMode: "mtls_or_host" },
    authorize: (authentication) =>
      Promise.resolve(
        authentication.tenant.id === tenant.id && authentication.principal.id === principal.id,
      ),
    resolveAgent: (reference) =>
      Promise.resolve(
        reference.id === cloudflareAgent.id && reference.version === cloudflareAgent.version
          ? cloudflareAgent
          : undefined,
      ),
    selectEnvironment: (bindings) => ({
      PACTMARK_PROFILE: bindings["PACTMARK_PROFILE"] === "preview" ? "preview" : undefined,
    }),
  });
  workerInstance = Object.freeze({ runtime, worker });
  return workerInstance;
}

export function getCloudflareRuntime(): LocalRuntime {
  return getWorkerInstance().runtime;
}

export const cloudflareWorker = Object.freeze({
  fetch(
    request: Request,
    bindings: Readonly<Record<string, unknown>>,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response> {
    return getWorkerInstance().worker.fetch(request, bindings, executionContext);
  },
});

export { CLOUDFLARE_COMPATIBILITY_DATE };
export default cloudflareWorker;
