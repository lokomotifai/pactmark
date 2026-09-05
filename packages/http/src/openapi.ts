import { digestCanonicalJson, type JsonValue } from "@pactmark/core";
import httpPackage from "../package.json" with { type: "json" };

const mutatingHeaders = [
  { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
];

export function createOpenApiDocument(basePath: string): Readonly<{
  document: JsonValue;
  etag: string;
}> {
  const operation = (operationId: string): JsonValue => ({
    operationId,
    parameters: mutatingHeaders,
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object" } } },
    },
    responses: {
      "200": { description: "Success" },
      "400": { description: "Invalid request" },
      "401": { description: "Authentication required" },
      "403": { description: "Forbidden" },
      "409": { description: "Conflict" },
    },
  });
  const authenticatedRead = (
    operationId: string,
    content: Readonly<Record<string, JsonValue>>,
  ): JsonValue => ({
    operationId,
    responses: {
      "200": { description: "Success", content },
      "401": { description: "Authentication required" },
      "404": { description: "Not found" },
      "413": { description: "Response exceeds the configured bound" },
    },
  });
  const document: JsonValue = {
    openapi: "3.1.0",
    info: { title: "Pactmark Agent HTTP API", version: httpPackage.version },
    servers: [{ url: basePath.length === 0 ? "/" : basePath }],
    paths: {
      "/healthz": {
        get: { operationId: "health", responses: { "200": { description: "Healthy" } } },
      },
      "/readyz": {
        get: {
          operationId: "readiness",
          responses: { "200": { description: "Ready" }, "503": { description: "Not ready" } },
        },
      },
      "/v1/runs": { post: operation("startRun") },
      "/v1/runs/{runId}": {
        get: { operationId: "getRun", responses: { "200": { description: "Run" } } },
      },
      "/v1/runs/{runId}/events": {
        get: { operationId: "getRunEvents", responses: { "200": { description: "Events" } } },
      },
      "/v1/runs/{runId}/artifacts/{artifactId}": {
        get: authenticatedRead("getRunArtifact", {
          "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } },
        }),
      },
      "/v1/runs/{runId}/artifacts/{artifactId}/verification": {
        get: authenticatedRead("getRunArtifactVerification", {
          "application/json": { schema: { type: "object" } },
        }),
      },
      "/v1/runs/{runId}/evidence": {
        get: authenticatedRead("exportRunEvidence", {
          "application/json": { schema: { type: "object" } },
          "text/markdown": { schema: { type: "string" } },
        }),
      },
      "/v1/runs/{runId}/resume": { post: operation("resumeRun") },
      "/v1/runs/{runId}/inputs/{requestId}": { post: operation("submitInput") },
      "/v1/runs/{runId}/decisions/{decisionId}/challenge": {
        post: operation("issueDecisionChallenge"),
      },
      "/v1/runs/{runId}/decisions/{decisionId}": { post: operation("submitDecision") },
      "/v1/runs/{runId}/effects/{effectId}/reconcile": { post: operation("reconcileEffect") },
      "/v1/runs/{runId}/effects/{effectId}/compensate": { post: operation("requestCompensation") },
      "/v1/runs/{runId}/cancel": { post: operation("cancelRun") },
    },
  };
  return Object.freeze({ document, etag: `"${digestCanonicalJson(document)}"` });
}
