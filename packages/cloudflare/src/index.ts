import { createAgentFetchHandler, type AgentFetchHandlerConfig } from "@pactmark/http";

export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-03" as const;

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CloudflareWorkerAdapterConfig extends AgentFetchHandlerConfig {
  readonly selectEnvironment?: (
    bindings: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, string | undefined>>;
}

export function createCloudflareWorker(config: CloudflareWorkerAdapterConfig): Readonly<{
  fetch(
    request: Request,
    bindings: Readonly<Record<string, unknown>>,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response>;
}> {
  const handler = createAgentFetchHandler(config);
  return Object.freeze({
    fetch(
      request: Request,
      bindings: Readonly<Record<string, unknown>>,
      executionContext: CloudflareExecutionContext,
    ) {
      return handler(request, {
        env: config.selectEnvironment?.(bindings) ?? {},
        signal: request.signal,
        waitUntil: (promise) => {
          executionContext.waitUntil(promise);
        },
        capabilities: config.runtime.getCapabilities(),
      });
    },
  });
}
