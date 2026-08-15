import type { AuthorityContext } from "@pactmark/agent";
import { constantTimeTextEqual } from "@pactmark/http";
import type { VercelRouteHandlerConfig } from "@pactmark/vercel";

export interface ProductionAuthConfig {
  readonly authority: AuthorityContext;
  readonly principal: { readonly type: "service"; readonly id: string };
  readonly tenant: { readonly id: string };
  readEnvironment(): Readonly<Record<string, string | undefined>>;
}

export function createProductionAuthHook(config: ProductionAuthConfig) {
  const authenticate: NonNullable<VercelRouteHandlerConfig["authenticate"]> = (request) => {
    const expected = config.readEnvironment()["PACTMARK_BEARER_TOKEN"];
    const supplied = request.headers.get("authorization");
    if (
      expected === undefined ||
      expected.length < 16 ||
      !constantTimeTextEqual(supplied, `Bearer ${expected}`)
    )
      return Promise.resolve(undefined);
    return Promise.resolve({
      authority: config.authority,
      principal: config.principal,
      tenant: config.tenant,
      credentialMode: "bearer",
    });
  };
  return authenticate;
}
