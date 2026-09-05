import {
  createLocalAuthorityIssuer,
  createLocalRuntime,
  createRuntime,
  type CreateRuntimeInput,
} from "@pactmark/agent";
import { createDeclaredToolExecutor } from "@pactmark/executor-in-process";
import { createVercelRouteHandler } from "@pactmark/vercel";

import { nextAgent } from "./agent";
import { createProductionAuthHook } from "./auth";

export type HostProfile = "preview" | "production";
type EnvironmentReader = () => Readonly<Record<string, string | undefined>>;

export function selectHostProfile(value: string | undefined): HostProfile {
  return value === "preview" ? "preview" : "production";
}

const localAuthority = createLocalAuthorityIssuer();
const previewPrincipal = { type: "service" as const, id: "nextjs-vercel-preview" };
const previewTenant = { id: "nextjs-vercel-preview" };
const productionPrincipal = { type: "service" as const, id: "nextjs-vercel-production" };
const productionTenant = { id: "nextjs-vercel-production" };

const previewAuthority = localAuthority.issue({
  principal: previewPrincipal,
  tenant: previewTenant,
  authenticationStrength: "phishing_resistant",
});
const productionAuthority = localAuthority.issue({
  principal: productionPrincipal,
  tenant: productionTenant,
  // A static bearer secret is single-factor. Hosts that need R4/R5 approvals
  // must replace this fixture hook with an authority backed by stronger auth.
  authenticationStrength: "single_factor",
});

/**
 * Explicit public executor composition required by a production host.
 * The preview runtime below remains intentionally local/ephemeral and does not conceal these ports.
 */
const declaredToolExecutor = createDeclaredToolExecutor([]);

/** @public Explicit production composition hook; callers must inject every durable host port. */
export function createProductionHost(ports: Omit<CreateRuntimeInput, "toolExecutor">) {
  return createRuntime({
    ...ports,
    toolExecutor: declaredToolExecutor,
  });
}

export const nextRuntime = createLocalRuntime({
  agents: [nextAgent],
  authorityIssuer: localAuthority.issuer,
});

function defaultEnvironment(): Readonly<Record<string, string | undefined>> {
  return {
    PACTMARK_PROFILE: process.env["PACTMARK_PROFILE"],
    PACTMARK_BEARER_TOKEN: process.env["PACTMARK_BEARER_TOKEN"],
  };
}

export function createNextVercelHandler(
  options: Readonly<{
    profile: HostProfile;
    readEnvironment?: EnvironmentReader;
  }>,
) {
  const readEnvironment = options.readEnvironment ?? defaultEnvironment;
  const preview = options.profile === "preview";
  return createVercelRouteHandler({
    basePath: "/api/agent",
    runtime: nextRuntime,
    policyEnforcement: "complete",
    readEnvironment,
    ...(preview
      ? {
          allowAnonymousDevelopment: true,
          anonymousAuthentication: {
            authority: previewAuthority,
            principal: previewPrincipal,
            tenant: previewTenant,
            credentialMode: "mtls_or_host" as const,
          },
        }
      : {
          authenticate: createProductionAuthHook({
            authority: productionAuthority,
            principal: productionPrincipal,
            tenant: productionTenant,
            readEnvironment,
          }),
        }),
    authorize: (authentication) =>
      Promise.resolve(
        preview
          ? authentication.tenant.id === previewTenant.id &&
              authentication.principal.id === previewPrincipal.id
          : authentication.tenant.id === productionTenant.id &&
              authentication.principal.id === productionPrincipal.id,
      ),
    resolveAgent: (reference) =>
      Promise.resolve(
        reference.id === nextAgent.id && reference.version === nextAgent.version
          ? nextAgent
          : undefined,
      ),
    allowedOrigins: ["http://localhost:3000"],
  });
}

export const nextVercelHandler = createNextVercelHandler({
  profile: selectHostProfile(process.env["PACTMARK_PROFILE"]),
});
