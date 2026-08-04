import { createAgentFetchHandler, type AgentFetchHandlerConfig } from "@pactmark/http";

export interface VercelRouteHandlerConfig extends AgentFetchHandlerConfig {
  /** Read at request time inside the host adapter; never serialized. */
  readonly readEnvironment?: () => Readonly<Record<string, string | undefined>>;
  /** Reserved for non-critical work such as configured telemetry flushes. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export type VercelRouteHandler = (request: Request, routeContext?: unknown) => Promise<Response>;

export function createVercelRouteHandler(config: VercelRouteHandlerConfig): VercelRouteHandler {
  const handler = createAgentFetchHandler(config);
  return (request: Request) =>
    handler(request, {
      env: config.readEnvironment?.() ?? {},
      signal: request.signal,
      waitUntil: config.waitUntil ?? (() => undefined),
      capabilities: config.runtime.getCapabilities(),
    });
}
