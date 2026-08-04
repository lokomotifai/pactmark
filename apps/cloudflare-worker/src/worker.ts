import { createLocalAuthorityIssuer, createLocalRuntime } from "@pactmark/agent";
import { CLOUDFLARE_COMPATIBILITY_DATE, createCloudflareWorker } from "@pactmark/cloudflare";

import { cloudflareAgent } from "./agent.js";

export interface Env {
  readonly PACTMARK_PROFILE: "preview";
}

const authorityIssuer = createLocalAuthorityIssuer();
const principal = { type: "service" as const, id: "cloudflare-preview" };
const tenant = { id: "cloudflare-preview" };
const authority = authorityIssuer.issue({ principal, tenant });
export const cloudflareRuntime = createLocalRuntime({
  agents: [cloudflareAgent],
  authorityIssuer: authorityIssuer.issuer,
});

export const cloudflareWorker = createCloudflareWorker({
  basePath: "/api/agent",
  runtime: cloudflareRuntime,
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

export { CLOUDFLARE_COMPATIBILITY_DATE };
export default cloudflareWorker;
