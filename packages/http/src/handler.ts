import {
  AgentDefinitionSchema,
  ArtifactSchema,
  CommandIdSchema,
  EvidenceRecordSchema,
  JsonValueSchema,
  KafError,
  RuntimeCapabilitiesSchema,
  WorkOrderRequestSchema,
  createCommandContext,
  digestBytes,
  digestCanonicalJson,
  type JsonValue,
} from "@pactmark/core";
import {
  exportEvidenceJson,
  exportEvidenceMarkdown,
  verifyEvidenceDigest,
} from "@pactmark/evidence";

import { createOpenApiDocument } from "./openapi.js";
import type {
  AgentFetchHandler,
  AgentFetchHandlerConfig,
  AgentRuntimeContext,
  AuthenticatedRequest,
} from "./types.js";

const sensitiveHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0, no-transform",
  "Surrogate-Control": "no-store",
  "CDN-Cache-Control": "no-store",
  Vary: "Authorization, Cookie, Origin, Accept, Last-Event-ID",
});

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

function normalizeBasePath(value: string | undefined): string {
  if (value === undefined || value === "" || value === "/") return "";
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("..")) {
    throw new TypeError("KAF_HTTP_BASE_PATH_INVALID");
  }
  return value;
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const body =
    value === undefined ? ({ ok: true } satisfies JsonValue) : JsonValueSchema.parse(value);
  const responseHeaders = new Headers(sensitiveHeaders);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  if (headers !== undefined) {
    new Headers(headers).forEach((headerValue, headerName) => {
      responseHeaders.set(headerName, headerValue);
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function problem(error: unknown, requestId: string, documentationBaseUrl: string): Response {
  let status = 500;
  let code = "KAF_HTTP_INTERNAL";
  let retryable = false;
  let remediation = "internal-error";
  let retryAfter: number | undefined;
  if (error instanceof KafError) {
    status = error.httpStatus;
    code = error.code;
    retryable = error.retryable;
    remediation = error.documentationSlug;
  } else if (error instanceof HttpFailure) {
    status = error.status;
    code = error.code;
    retryable = error.retryable;
    remediation = code.toLowerCase().replaceAll("_", "-");
    retryAfter = error.retryAfter;
  }
  return new Response(
    JSON.stringify({
      type: `${documentationBaseUrl}/${remediation}`,
      title: code,
      status,
      code,
      retryable,
      requestId,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json; charset=utf-8",
        ...sensitiveHeaders,
        ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="pactmark"' } : {}),
        ...(retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) }),
      },
    },
  );
}

async function readJson(request: Request, maximumBytes: number): Promise<JsonValue> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new HttpFailure(415, "KAF_HTTP_JSON_REQUIRED");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new HttpFailure(413, "KAF_HTTP_BODY_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (reader === undefined) throw new HttpFailure(400, "KAF_HTTP_BODY_REQUIRED");
  const chunks: Uint8Array[] = [];
  let length = 0;
  let item = await reader.read();
  while (!item.done) {
    length += item.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new HttpFailure(413, "KAF_HTTP_BODY_TOO_LARGE");
    }
    chunks.push(item.value);
    item = await reader.read();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpFailure(400, "KAF_HTTP_JSON_INVALID");
  }
  return JsonValueSchema.parse(parsed);
}

function assertCookieBoundary(request: Request, authentication: AuthenticatedRequest): void {
  if (authentication.credentialMode !== "cookie") return;
  const origin = request.headers.get("origin");
  const allowed = authentication.allowedOrigins ?? [];
  if (origin === null || !allowed.includes(origin)) {
    throw new HttpFailure(403, "KAF_HTTP_ORIGIN_DENIED");
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    throw new HttpFailure(403, "KAF_HTTP_FETCH_METADATA_DENIED");
  }
  if (
    authentication.csrfToken === undefined ||
    request.headers.get("x-csrf-token") !== authentication.csrfToken
  ) {
    throw new HttpFailure(403, "KAF_HTTP_CSRF_INVALID");
  }
}

function commandFor(request: Request, operation: string, payload: JsonValue, scope: string[]) {
  const raw = request.headers.get("idempotency-key");
  const parsed = CommandIdSchema.safeParse(raw);
  if (!parsed.success) throw new HttpFailure(400, "KAF_COMMAND_ID_MALFORMED");
  return createCommandContext({
    commandId: parsed.data,
    operation,
    payload,
    normalizedResourceScope: scope.map((value) => ({
      kind: "opaque" as const,
      value,
      normalizationVersion: "pactmark.http-route@1",
    })),
  });
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEmptyCommandBody(payload: JsonValue): void {
  if (!isJsonObject(payload) || Object.keys(payload).length !== 0) {
    throw new HttpFailure(400, "KAF_HTTP_COMMAND_BODY_INVALID");
  }
}

function safeIdentifier(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpFailure(400, "KAF_HTTP_ROUTE_INVALID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(decoded)) {
    throw new HttpFailure(400, "KAF_HTTP_ROUTE_INVALID");
  }
  return decoded;
}

function parseAfter(request: Request, url: URL): number {
  const value = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new HttpFailure(400, "KAF_HTTP_EVENT_CURSOR_INVALID");
  }
  return number;
}

function sseResponse(events: AsyncIterable<unknown>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const rawEvent of events) {
          if (signal.aborted) break;
          const event = JsonValueSchema.parse(rawEvent) as Readonly<{
            sequence?: number;
            eventType?: string;
          }>;
          const id = event.sequence === undefined ? "" : `id: ${String(event.sequence)}\n`;
          const name = event.eventType === undefined ? "message" : event.eventType;
          controller.enqueue(
            encoder.encode(`${id}event: ${name}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...sensitiveHeaders,
    },
  });
}

async function authenticate(
  config: AgentFetchHandlerConfig,
  request: Request,
  context: AgentRuntimeContext,
): Promise<AuthenticatedRequest> {
  const result = await config.authenticate?.(request, context);
  if (result !== undefined) return result;
  if (config.allowAnonymousDevelopment === true && config.anonymousAuthentication !== undefined) {
    return config.anonymousAuthentication;
  }
  throw new HttpFailure(401, "KAF_HTTP_AUTHENTICATION_REQUIRED");
}

async function authorize(
  config: AgentFetchHandlerConfig,
  authentication: AuthenticatedRequest,
  operation: string,
  runId?: string,
  resourceId?: string,
  concealResource = false,
): Promise<void> {
  const allowed = await config.authorize(authentication, {
    operation,
    ...(runId === undefined ? {} : { runId }),
    ...(resourceId === undefined ? {} : { resourceId }),
  });
  if (!allowed) {
    throw new HttpFailure(
      concealResource ? 404 : 403,
      concealResource ? "KAF_HTTP_NOT_FOUND" : "KAF_HTTP_AUTHORIZATION_DENIED",
    );
  }
}

function responseLimit(value: number | undefined, fallback: number, code: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError(code);
  return limit;
}

function attachmentResponse(
  content: Uint8Array,
  mediaType: string,
  filename: string,
  maximumBytes: number,
  headers: Readonly<Record<string, string>> = {},
): Response {
  if (content.byteLength > maximumBytes) {
    throw new HttpFailure(413, "KAF_HTTP_RESPONSE_TOO_LARGE");
  }
  return new Response(Uint8Array.from(content).buffer, {
    headers: {
      ...sensitiveHeaders,
      "Content-Type": mediaType,
      "Content-Length": String(content.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function evidenceFormat(request: Request, url: URL): "json" | "markdown" {
  const explicit = url.searchParams.get("format");
  if (explicit !== null) {
    if (explicit === "json" || explicit === "markdown") return explicit;
    throw new HttpFailure(400, "KAF_HTTP_EVIDENCE_FORMAT_INVALID");
  }
  const accept = request.headers.get("accept");
  if (accept === null || accept.includes("*/*") || accept.includes("application/json")) {
    return "json";
  }
  if (accept.includes("text/markdown")) return "markdown";
  throw new HttpFailure(406, "KAF_HTTP_NOT_ACCEPTABLE");
}

function preflight(request: Request, allowedOrigins: readonly string[]): Response {
  const origin = request.headers.get("origin");
  if (origin === null || !allowedOrigins.includes(origin)) {
    throw new HttpFailure(403, "KAF_HTTP_ORIGIN_DENIED");
  }
  const method = request.headers.get("access-control-request-method");
  if (method !== "GET" && method !== "POST") {
    throw new HttpFailure(403, "KAF_HTTP_CORS_DENIED");
  }
  const requested = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = ["authorization", "content-type", "idempotency-key", "x-csrf-token"];
  if (requested.some((header) => !allowedHeaders.includes(header))) {
    throw new HttpFailure(403, "KAF_HTTP_CORS_DENIED");
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": method,
      "Access-Control-Allow-Headers": requested.join(", "),
      "Access-Control-Max-Age": "600",
      Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      "Cache-Control": "private, no-store",
    },
  });
}

export function createAgentFetchHandler(config: AgentFetchHandlerConfig): AgentFetchHandler {
  const basePath = normalizeBasePath(config.basePath);
  const maximumBodyBytes = config.maximumBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes <= 0) {
    throw new TypeError("KAF_HTTP_BODY_LIMIT_INVALID");
  }
  const maximumArtifactResponseBytes = responseLimit(
    config.maximumArtifactResponseBytes,
    8 * 1024 * 1024,
    "KAF_HTTP_ARTIFACT_RESPONSE_LIMIT_INVALID",
  );
  const maximumEvidenceResponseBytes = responseLimit(
    config.maximumEvidenceResponseBytes,
    1024 * 1024,
    "KAF_HTTP_EVIDENCE_RESPONSE_LIMIT_INVALID",
  );
  if (
    config.authenticate === undefined &&
    !(config.allowAnonymousDevelopment === true && config.anonymousAuthentication !== undefined)
  ) {
    throw new TypeError("KAF_HTTP_AUTHENTICATION_REQUIRED");
  }
  RuntimeCapabilitiesSchema.parse(config.runtime.getCapabilities());
  const openapi = createOpenApiDocument(basePath);
  const documentationBaseUrl = config.documentationBaseUrl ?? "https://pactmark.dev/errors";

  return async (request, context) => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
        throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
      }
      const path = url.pathname.slice(basePath.length) || "/";
      if (request.method === "OPTIONS") return preflight(request, config.allowedOrigins ?? []);
      if (request.method === "GET" && path === "/healthz") {
        return jsonResponse({ status: "ok" });
      }
      if (request.method === "GET" && path === "/readyz") {
        const report = config.runtime.evaluateReadiness({ profile: "production" });
        return jsonResponse(report, report.ready ? 200 : 503);
      }
      if (request.method === "GET" && path === "/openapi.json") {
        if (request.headers.get("if-none-match") === openapi.etag) {
          return new Response(null, { status: 304, headers: { ETag: openapi.etag } });
        }
        return new Response(JSON.stringify(openapi.document), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300, must-revalidate",
            ETag: openapi.etag,
          },
        });
      }

      const authentication = await authenticate(config, request, context);
      if (request.method === "POST") assertCookieBoundary(request, authentication);

      if (request.method === "POST" && path === "/v1/runs") {
        await authorize(config, authentication, "run.start");
        const capabilities = config.runtime.getCapabilities();
        const respondAsync = request.headers.get("prefer") === "respond-async";
        const hasAtomicScheduler =
          capabilities.backgroundWakeup && capabilities.atomicCommandAndWakeup;
        if (
          (respondAsync && !hasAtomicScheduler) ||
          (!respondAsync && capabilities.executionProfile !== "ephemeral" && !hasAtomicScheduler)
        ) {
          throw new HttpFailure(503, "KAF_RUNTIME_SCHEDULER_REQUIRED");
        }
        const payload = await readJson(request, maximumBodyBytes);
        const workOrder = WorkOrderRequestSchema.parse(payload);
        const agent = await config.resolveAgent(workOrder.agent, authentication);
        if (agent === undefined) throw new HttpFailure(404, "KAF_HTTP_AGENT_NOT_FOUND");
        AgentDefinitionSchema.parse(agent);
        const definition = agent;
        const command = commandFor(request, "run.start", payload, [definition.id]);
        const result = await config.runtime.start(
          authentication.authority,
          definition,
          workOrder,
          command,
          { signal: request.signal },
        );
        if (respondAsync) {
          return jsonResponse({ runId: result.runId }, 202, {
            Location: `${basePath}/v1/runs/${result.runId}`,
          });
        }
        return sseResponse(
          config.runtime.events(authentication.authority, result.runId),
          request.signal,
        );
      }

      const runMatch = /^\/v1\/runs\/([^/]+)$/u.exec(path);
      if (request.method === "GET" && runMatch !== null) {
        const runId = safeIdentifier(runMatch[1] ?? "");
        await authorize(config, authentication, "run.get", runId);
        const run = await config.runtime.getRun(authentication.authority, runId);
        if (run === undefined) throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
        return jsonResponse(run);
      }

      const artifactVerificationMatch =
        /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)\/verification$/u.exec(path);
      if (request.method === "GET" && artifactVerificationMatch !== null) {
        const runId = safeIdentifier(artifactVerificationMatch[1] ?? "");
        const artifactId = safeIdentifier(artifactVerificationMatch[2] ?? "");
        await authorize(
          config,
          authentication,
          "run.artifact.verification",
          runId,
          artifactId,
          true,
        );
        const artifacts = await config.runtime.getArtifacts(authentication.authority, runId);
        const stored = artifacts.find((candidate) => candidate.artifact.artifactId === artifactId);
        if (stored === undefined || stored.artifact.producingRunId !== runId) {
          throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
        }
        const artifact = ArtifactSchema.parse(stored.artifact);
        const { artifactDigest, ...artifactMaterial } = artifact;
        if (
          artifactDigest !== digestCanonicalJson(artifactMaterial) ||
          artifact.contentDigest !== digestBytes(stored.content) ||
          artifact.byteSize !== stored.content.byteLength
        ) {
          throw new HttpFailure(500, "KAF_HTTP_ARTIFACT_INTEGRITY_INVALID");
        }
        const evidenceValue = await config.runtime.getEvidence(authentication.authority, runId);
        const evidence =
          evidenceValue === undefined ? undefined : EvidenceRecordSchema.parse(evidenceValue);
        if (evidence !== undefined && !verifyEvidenceDigest(evidence)) {
          throw new HttpFailure(500, "KAF_HTTP_EVIDENCE_INTEGRITY_INVALID");
        }
        const referencesArtifact =
          evidence?.artifactRefs.some(
            (reference) =>
              reference.artifactId === artifactId &&
              reference.artifactDigest === artifact.artifactDigest,
          ) ?? false;
        const metadata = {
          artifactId: artifact.artifactId,
          artifactDigest: artifact.artifactDigest,
          contentDigest: artifact.contentDigest,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          producingRunId: artifact.producingRunId,
          producingStepId: artifact.producingStepId,
          executionDefinitionDigest: artifact.provenance.executionDefinitionDigest,
          workOrderBindingDigest: artifact.provenance.workOrderBindingDigest,
          createdAt: artifact.createdAt,
          evidence:
            evidence === undefined || !referencesArtifact
              ? null
              : {
                  evidenceRecordId: evidence.evidenceRecordId,
                  evidenceDigest: evidence.evidenceDigest,
                  verificationRefs: evidence.verificationRefs,
                  verificationExceptionRefs: evidence.verificationExceptionRefs,
                },
        } satisfies JsonValue;
        const encoded = new TextEncoder().encode(JSON.stringify(metadata));
        return attachmentResponse(
          encoded,
          "application/json; charset=utf-8",
          `${artifactId}.verification.json`,
          maximumEvidenceResponseBytes,
        );
      }

      const artifactMatch = /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/u.exec(path);
      if (request.method === "GET" && artifactMatch !== null) {
        const runId = safeIdentifier(artifactMatch[1] ?? "");
        const artifactId = safeIdentifier(artifactMatch[2] ?? "");
        await authorize(config, authentication, "run.artifact.get", runId, artifactId, true);
        const artifacts = await config.runtime.getArtifacts(authentication.authority, runId);
        const stored = artifacts.find((candidate) => candidate.artifact.artifactId === artifactId);
        if (stored === undefined || stored.artifact.producingRunId !== runId) {
          throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
        }
        const artifact = ArtifactSchema.parse(stored.artifact);
        const { artifactDigest, ...artifactMaterial } = artifact;
        if (
          artifactDigest !== digestCanonicalJson(artifactMaterial) ||
          artifact.contentDigest !== digestBytes(stored.content) ||
          artifact.byteSize !== stored.content.byteLength
        ) {
          throw new HttpFailure(500, "KAF_HTTP_ARTIFACT_INTEGRITY_INVALID");
        }
        const mediaType = artifact.mediaType.split(";", 1)[0] ?? "application/octet-stream";
        return attachmentResponse(
          stored.content,
          mediaType,
          `${artifactId}.artifact`,
          maximumArtifactResponseBytes,
          {
            "X-Pactmark-Artifact-Digest": artifact.artifactDigest,
            "X-Pactmark-Content-Digest": artifact.contentDigest,
          },
        );
      }

      const evidenceMatch = /^\/v1\/runs\/([^/]+)\/evidence$/u.exec(path);
      if (request.method === "GET" && evidenceMatch !== null) {
        const runId = safeIdentifier(evidenceMatch[1] ?? "");
        await authorize(config, authentication, "run.evidence.export", runId, undefined, true);
        const evidenceValue = await config.runtime.getEvidence(authentication.authority, runId);
        if (evidenceValue === undefined) throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
        const evidence = EvidenceRecordSchema.parse(evidenceValue);
        if (evidence.runId !== runId || !verifyEvidenceDigest(evidence)) {
          throw new HttpFailure(500, "KAF_HTTP_EVIDENCE_INTEGRITY_INVALID");
        }
        const format = evidenceFormat(request, url);
        const content = new TextEncoder().encode(
          format === "json" ? exportEvidenceJson(evidence) : exportEvidenceMarkdown(evidence),
        );
        return attachmentResponse(
          content,
          format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
          `evidence-${runId}.${format === "json" ? "json" : "md"}`,
          maximumEvidenceResponseBytes,
          { "X-Pactmark-Evidence-Digest": evidence.evidenceDigest },
        );
      }

      const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/u.exec(path);
      if (request.method === "GET" && eventsMatch !== null) {
        const runId = safeIdentifier(eventsMatch[1] ?? "");
        await authorize(config, authentication, "run.events", runId);
        const afterSequence = parseAfter(request, url);
        const events = config.runtime.events(authentication.authority, runId, { afterSequence });
        if (request.headers.get("accept")?.includes("text/event-stream") === true) {
          return sseResponse(events, request.signal);
        }
        const collected: JsonValue[] = [];
        for await (const event of events) collected.push(JsonValueSchema.parse(event));
        return jsonResponse(collected);
      }

      if (request.method !== "POST") throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
      const payload = await readJson(request, maximumBodyBytes);

      const resume = /^\/v1\/runs\/([^/]+)\/resume$/u.exec(path);
      if (resume !== null) {
        const runId = safeIdentifier(resume[1] ?? "");
        await authorize(config, authentication, "run.resume", runId);
        assertEmptyCommandBody(payload);
        const command = commandFor(request, "run.resume", { runId }, [runId]);
        return jsonResponse(
          await config.runtime.resume(authentication.authority, runId, command, {
            signal: request.signal,
          }),
        );
      }
      const input = /^\/v1\/runs\/([^/]+)\/inputs\/([^/]+)$/u.exec(path);
      if (input !== null) {
        const runId = safeIdentifier(input[1] ?? "");
        const requestId = safeIdentifier(input[2] ?? "");
        await authorize(config, authentication, "run.submit_input", runId, requestId);
        const command = commandFor(request, "run.submit_input", payload, [runId, requestId]);
        return jsonResponse(
          await config.runtime.submitInput(
            authentication.authority,
            runId,
            requestId,
            payload,
            command,
          ),
        );
      }
      const challenge = /^\/v1\/runs\/([^/]+)\/decisions\/([^/]+)\/challenge$/u.exec(path);
      if (challenge !== null) {
        const runId = safeIdentifier(challenge[1] ?? "");
        const decisionId = safeIdentifier(challenge[2] ?? "");
        await authorize(config, authentication, "run.issue_decision_challenge", runId, decisionId);
        assertEmptyCommandBody(payload);
        const command = commandFor(request, "run.issue_decision_challenge", {}, [
          runId,
          decisionId,
        ]);
        return jsonResponse(
          await config.runtime.issueDecisionChallenge(
            authentication.authority,
            runId,
            decisionId,
            command,
          ),
        );
      }
      const decision = /^\/v1\/runs\/([^/]+)\/decisions\/([^/]+)$/u.exec(path);
      if (decision !== null) {
        const runId = safeIdentifier(decision[1] ?? "");
        const decisionId = safeIdentifier(decision[2] ?? "");
        await authorize(config, authentication, "run.decide", runId, decisionId);
        const action =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? (payload as Readonly<Record<string, JsonValue>>)["decision"]
            : undefined;
        if (action !== "approve" && action !== "reject") {
          throw new HttpFailure(400, "KAF_HTTP_DECISION_INVALID");
        }
        const command = commandFor(request, `run.${action}`, payload, [runId, decisionId]);
        return jsonResponse(
          action === "approve"
            ? await config.runtime.approve(authentication.authority, runId, payload, command)
            : await config.runtime.reject(authentication.authority, runId, payload, command),
        );
      }
      const effect = /^\/v1\/runs\/([^/]+)\/effects\/([^/]+)\/(reconcile|compensate)$/u.exec(path);
      if (effect !== null) {
        const runId = safeIdentifier(effect[1] ?? "");
        const effectId = safeIdentifier(effect[2] ?? "");
        const action = effect[3];
        const operation =
          action === "reconcile" ? "run.reconcile_effect" : "run.request_compensation";
        await authorize(config, authentication, operation, runId, effectId);
        const command = commandFor(request, operation, payload, [runId, effectId]);
        return jsonResponse(
          action === "reconcile"
            ? await config.runtime.reconcileEffect(
                authentication.authority,
                runId,
                effectId,
                payload,
                command,
              )
            : await config.runtime.requestCompensation(
                authentication.authority,
                runId,
                effectId,
                payload,
                command,
              ),
        );
      }
      const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/u.exec(path);
      if (cancel !== null) {
        const runId = safeIdentifier(cancel[1] ?? "");
        await authorize(config, authentication, "run.cancel", runId);
        const reason =
          isJsonObject(payload) && typeof payload["reason"] === "string"
            ? payload["reason"]
            : undefined;
        if (reason === undefined) throw new HttpFailure(400, "KAF_HTTP_CANCEL_REASON_INVALID");
        const command = commandFor(request, "run.cancel", { runId, reason }, [runId]);
        return jsonResponse(
          await config.runtime.cancel(authentication.authority, runId, payload, command),
        );
      }
      throw new HttpFailure(404, "KAF_HTTP_NOT_FOUND");
    } catch (error) {
      return problem(error, requestId, documentationBaseUrl);
    }
  };
}
