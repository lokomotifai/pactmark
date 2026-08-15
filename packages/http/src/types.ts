import type {
  AgentDefinition,
  Artifact,
  AuthorityContext,
  CommandContext,
  EvidenceRecord,
  JsonValue,
  Principal,
  RunEvent,
  RuntimeCapabilities,
  RuntimeReadinessProfile,
  RuntimeReadinessReport,
  Tenant,
  WorkOrderRequest,
} from "@pactmark/core";

export interface AgentRuntimeContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  waitUntil(promise: Promise<unknown>): void;
  readonly capabilities: RuntimeCapabilities;
}

export type AgentFetchHandler = (
  request: Request,
  context: AgentRuntimeContext,
) => Promise<Response>;

export interface AuthenticatedRequest {
  readonly authority: AuthorityContext;
  readonly principal: Principal;
  readonly tenant: Tenant;
  readonly credentialMode: "bearer" | "cookie" | "mtls_or_host";
  readonly allowedOrigins?: readonly string[];
  /** Host-verified token expected in X-CSRF-Token for cookie mutations. */
  readonly csrfToken?: string;
}

export interface HttpRuntimeSurface {
  start(
    authority: AuthorityContext,
    agent: AgentDefinition,
    request: WorkOrderRequest,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ runId: string; workOrderId?: string }>>;
  resume(
    authority: AuthorityContext,
    runId: string,
    command: CommandContext,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
  getRun(authority: AuthorityContext, runId: string): Promise<JsonValue | undefined>;
  getEvidence(authority: AuthorityContext, runId: string): Promise<EvidenceRecord | undefined>;
  getArtifacts(
    authority: AuthorityContext,
    runId: string,
  ): Promise<readonly Readonly<{ artifact: Artifact; content: Uint8Array }>[]>;
  events(
    authority: AuthorityContext,
    runId: string,
    options?: Readonly<{ afterSequence?: number }>,
  ): AsyncIterable<RunEvent>;
  submitInput(
    authority: AuthorityContext,
    runId: string,
    requestId: string,
    value: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  issueDecisionChallenge(
    authority: AuthorityContext,
    runId: string,
    decisionId: string,
    command: CommandContext,
  ): Promise<unknown>;
  approve(
    authority: AuthorityContext,
    runId: string,
    decision: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  reject(
    authority: AuthorityContext,
    runId: string,
    decision: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  reconcileEffect(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    resolution: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  requestCompensation(
    authority: AuthorityContext,
    runId: string,
    effectId: string,
    request: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  cancel(
    authority: AuthorityContext,
    runId: string,
    reason: JsonValue,
    command: CommandContext,
  ): Promise<unknown>;
  getCapabilities(): RuntimeCapabilities;
  evaluateReadiness(input: Readonly<{ profile: RuntimeReadinessProfile }>): RuntimeReadinessReport;
}

export interface AgentFetchHandlerConfig {
  readonly basePath?: string;
  readonly runtime: HttpRuntimeSurface;
  readonly authenticate?: (
    request: Request,
    context: AgentRuntimeContext,
  ) => Promise<AuthenticatedRequest | undefined>;
  readonly authorize: (
    authentication: AuthenticatedRequest,
    request: Readonly<{ operation: string; runId?: string; resourceId?: string }>,
  ) => Promise<boolean>;
  readonly resolveAgent: (
    reference: Readonly<{ id: string; version: string }>,
    authentication: AuthenticatedRequest,
  ) => Promise<AgentDefinition | undefined>;
  readonly allowAnonymousDevelopment?: boolean;
  readonly anonymousAuthentication?: AuthenticatedRequest;
  readonly onSecurityWarning?: (warning: Readonly<{ code: string; message: string }>) => void;
  readonly allowedOrigins?: readonly string[];
  readonly maximumBodyBytes?: number;
  readonly maximumArtifactResponseBytes?: number;
  readonly maximumEvidenceResponseBytes?: number;
  /** Detailed capability checks can expose deployment internals; disabled by default. */
  readonly exposeDetailedReadiness?: boolean;
  /**
   * Host attestation that every tool call uses Pactmark's complete policy preflight contract.
   * Omission fails the production readiness check closed.
   */
  readonly policyEnforcement?: "complete";
  readonly documentationBaseUrl?: string;
}
