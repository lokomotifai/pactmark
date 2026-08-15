import {
  createLocalAuthorityIssuer,
  createLocalRuntime,
  type AuthorityContext,
} from "@pactmark/agent";
import { createAgentFetchHandler } from "@pactmark/http";

import { nodeQuickstartAgent } from "./agent.js";

const principal = { type: "service" as const, id: "node-quickstart-local" };
const tenant = { id: "node-quickstart" };
const authorityIssuer = createLocalAuthorityIssuer();
export const nodeQuickstartAuthority: AuthorityContext = authorityIssuer.issue({
  principal,
  tenant,
});

export const nodeQuickstartRuntime = createLocalRuntime({
  agents: [nodeQuickstartAgent],
  authorityIssuer: authorityIssuer.issuer,
});

export const nodeQuickstartHandler = createAgentFetchHandler({
  runtime: nodeQuickstartRuntime,
  policyEnforcement: "complete",
  allowAnonymousDevelopment: true,
  anonymousAuthentication: {
    authority: nodeQuickstartAuthority,
    principal,
    tenant,
    credentialMode: "mtls_or_host",
  },
  authorize: (authentication) =>
    Promise.resolve(
      authentication.tenant.id === tenant.id && authentication.principal.id === principal.id,
    ),
  resolveAgent: (reference) =>
    Promise.resolve(
      reference.id === nodeQuickstartAgent.id && reference.version === nodeQuickstartAgent.version
        ? nodeQuickstartAgent
        : undefined,
    ),
});
