import {
  JsonValueSchema,
  ToolRegistrationContractSchema,
  type EgressBroker,
  type EgressHttpClient,
  type JsonValue,
  type RuntimeCapabilities,
  type ToolExecutor,
  type ToolRegistrationContract,
} from "@pactmark/core";
import executorPackage from "../package.json" with { type: "json" };

export const EXECUTOR_IN_PROCESS_VERSION = executorPackage.version;

export interface DeclaredTool {
  readonly registration: ToolRegistrationContract;
  execute(input: JsonValue, signal: AbortSignal): Promise<JsonValue>;
}

export interface DeclaredAllowlistEgressOptions {
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods?: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly allowLoopbackHttpForDevelopment?: boolean;
  readonly authorizeBinding?: (binding: Parameters<EgressBroker["bind"]>[0]) => boolean;
}

type EgressBinding = Parameters<EgressBroker["bind"]>[0];

const baseCapabilities: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: false,
  cancellation: true,
  sandbox: "unsafe_local",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: [],
});

function capabilities(networkPolicy: "none" | "declared"): RuntimeCapabilities {
  return Object.freeze({ ...baseCapabilities, networkPolicy });
}

export function createDeclaredToolExecutor(tools: readonly DeclaredTool[]): ToolExecutor {
  const registrations = new Map<string, DeclaredTool>();
  for (const tool of tools) {
    const registration = ToolRegistrationContractSchema.parse(tool.registration);
    const current = registrations.get(registration.id);
    if (current !== undefined) {
      throw new TypeError("KAF_REGISTRATION_SAME_VERSION_DRIFT");
    }
    registrations.set(registration.id, Object.freeze({ ...tool, registration }));
  }
  const executor: ToolExecutor = {
    capabilities: capabilities("declared"),
    networkPolicy: "declared" as const,
    async execute(request: Parameters<ToolExecutor["execute"]>[0]) {
      if (request.signal.aborted) throw request.signal.reason;
      const input = JsonValueSchema.parse(request.input);
      const declared = registrations.get(request.registration.id);
      if (
        declared === undefined ||
        declared.registration.implementationVersion !==
          request.registration.implementationVersion ||
        declared.registration.toolRegistrationDigest !== request.registration.toolRegistrationDigest
      ) {
        throw new TypeError("KAF_TOOL_NOT_DECLARED");
      }
      return JsonValueSchema.parse(await declared.execute(input, request.signal));
    },
  };
  return Object.freeze(executor);
}

class DeniedEgressClient implements EgressHttpClient {
  fetch(): Promise<Response> {
    return Promise.reject(new TypeError("KAF_EGRESS_DENIED"));
  }
}

export function createDenyAllEgressBroker(): EgressBroker {
  const client = Object.freeze(new DeniedEgressClient());
  return Object.freeze({
    capabilities: capabilities("none"),
    bind: () => client,
  });
}

function normalizeOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("KAF_EGRESS_ORIGIN_INVALID");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) {
    throw new TypeError("KAF_EGRESS_ORIGIN_INVALID");
  }
  return url.origin;
}

export function createDeclaredAllowlistEgressBroker(
  options: DeclaredAllowlistEgressOptions,
): EgressBroker {
  const allowLoopback = options.allowLoopbackHttpForDevelopment === true;
  const origins = new Set(
    options.allowedOrigins.map((origin) => normalizeOrigin(origin, allowLoopback)),
  );
  if (origins.size === 0) throw new TypeError("KAF_EGRESS_ALLOWLIST_EMPTY");
  const methods = new Set(
    (options.allowedMethods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()),
  );
  if (methods.size === 0) throw new TypeError("KAF_EGRESS_METHOD_ALLOWLIST_EMPTY");
  const client: EgressHttpClient = Object.freeze({
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      if (request.signal.aborted) throw request.signal.reason;
      const url = new URL(request.url);
      if (
        url.username ||
        url.password ||
        !origins.has(url.origin) ||
        !methods.has(request.method)
      ) {
        throw new TypeError("KAF_EGRESS_DENIED");
      }
      return options.fetch(request, { redirect: "manual", signal: request.signal });
    },
  });
  const deniedClient = Object.freeze(new DeniedEgressClient());
  return Object.freeze({
    capabilities: capabilities("declared"),
    bind: (binding: EgressBinding) => {
      return options.authorizeBinding?.(binding) === true ? client : deniedClient;
    },
  });
}
