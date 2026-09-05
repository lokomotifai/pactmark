import { describe, expect, it, vi } from "vitest";
import { runRunCommandUnitOfWorkContract } from "@pactmark/testing";
import {
  createCommandContext,
  createRunProjection,
  digestCanonicalJson,
  reduceRunEvent,
  type AuthorizationReservation,
  type CapabilityGrant,
  type Approval,
  type CommandRecord,
  type CommandScope,
  type DataProtector,
  type EffectRecord,
  type JsonValue,
  type ProposedEffectBinding,
  type DecisionSubmissionChallenge,
  type DecisionGate,
  type RunCommandTransaction,
} from "@pactmark/core";

import {
  PostgresRunCommandUnitOfWork,
  PostgresEffectLedger,
  type PostgresClient,
  type PostgresDatabase,
  type SqlResult,
} from "../src/index.js";
import {
  acceptedWorkOrder,
  digest,
  executionDefinition,
  executionDefinitionDigest,
  instant,
  inputSubmission,
  postgresSecurityProfile as createPostgresStorageSecurityProfile,
  protectedValue,
  runAccepted,
} from "./fixtures.js";

const commandId = "kafcmd_1722680000000_00000000000000000000000000000001";

function scope(overrides: Partial<CommandScope> = {}): CommandScope {
  return {
    issuerId: "issuer-a",
    tenant: { id: "tenant-a" },
    principal: { type: "user", id: "user-1" },
    operation: "start",
    normalizedResourceScope: [],
    commandId,
    ...overrides,
  };
}

function record(commandScope: CommandScope, requestDigest: string): CommandRecord {
  return {
    schemaVersion: "1",
    scope: commandScope,
    requestDigest,
    status: "committed",
    resultReference: { kind: "run", runId: "run-1" },
    safeResponseDigest: digest("safe-response"),
    firstSeenAt: instant,
    committedAt: instant,
    detailRetentionExpiresAt: "2026-08-04T00:00:00.000Z",
    idempotencyExpiresAt: "2026-08-05T00:00:00.000Z",
  };
}

function authorizationReservation(
  overrides: Partial<AuthorizationReservation> = {},
): AuthorizationReservation {
  return {
    schemaVersion: "1",
    authorizationReservationId: "authorization-1",
    authorizationKey: "effect-key-1",
    tenantId: "tenant-a",
    runId: "run-1",
    stepId: "step-1",
    toolCallId: "tool-call-1",
    effectKey: "effect-key-1",
    workOrderBindingDigest: acceptedWorkOrder().workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    toolId: "demo.mutate@1",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    policyRegistrationDigest: digest("policy-registration"),
    argumentsDigest: digest("arguments"),
    normalizedTargetDigest: digest("target"),
    grantId: "grant-1",
    secretRefIds: [],
    purposeCode: "support",
    purposeRegistryVersion: "1",
    state: "consumed",
    createdAt: instant,
    expiresAt: "2026-08-03T11:00:00.000Z",
    consumedAt: instant,
    ...overrides,
  };
}

function legacyReservedAuthorization(): AuthorizationReservation {
  const { consumedAt, ...reservation } = authorizationReservation({
    state: "reserved",
  });
  void consumedAt;
  return reservation;
}

function preparedEffect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  const authorization = authorizationReservation();
  const identity = {
    schemaVersion: "1" as const,
    effectId: "effect-1",
    tenantId: authorization.tenantId,
    runId: authorization.runId,
    stepId: authorization.stepId,
    toolCallId: authorization.toolCallId,
    effectKey: authorization.effectKey!,
    operationKey: "operation-1",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: authorization.workOrderBindingDigest,
    toolId: authorization.toolId,
    toolVersion: authorization.toolVersion,
    toolRegistrationDigest: authorization.toolRegistrationDigest,
    strategy: "native" as const,
    strategyRegistrationDigest: digest("effect-strategy"),
    authorizationReservationId: authorization.authorizationReservationId,
    argumentsDigest: authorization.argumentsDigest,
    normalizedTargetDigest: authorization.normalizedTargetDigest,
    createdAt: instant,
  };
  return {
    ...identity,
    effectDigest: digestCanonicalJson(identity),
    state: "prepared",
    updatedAt: instant,
    ...overrides,
  } as EffectRecord;
}

function acceptedProjection() {
  const event = runAccepted();
  const workOrder = acceptedWorkOrder();
  return reduceRunEvent(
    createRunProjection({
      schemaVersion: "1",
      runId: event.runId,
      tenantId: event.tenantId,
      workOrderId: workOrder.id,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      executionDefinition,
      executionDefinitionDigest,
      status: "created",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      dataClass: event.dataClass,
      correlationId: event.correlationId,
    }),
    event,
  );
}

function capabilityGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  const workOrder = acceptedWorkOrder();
  return {
    schemaVersion: "1",
    id: "grant-1",
    issuerId: "issuer-a",
    principal: workOrder.principal,
    tenant: workOrder.tenant,
    workOrderId: workOrder.id,
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    capability: "artifact:write",
    action: "write",
    toolId: "artifact.write",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    normalizedResources: [{ kind: "artifact", value: "run-1/output", normalizationVersion: "1" }],
    purpose: workOrder.purpose,
    policyRegistrationDigest: digest("policy-registration"),
    maximumUses: 1,
    issuedAt: instant,
    expiresAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  };
}

function proposedEffectBinding(
  overrides: Partial<ProposedEffectBinding> = {},
): ProposedEffectBinding {
  const workOrder = acceptedWorkOrder();
  return {
    schemaVersion: "1",
    tenant: workOrder.tenant,
    principal: workOrder.principal,
    runId: "run-1",
    stepId: "step-1",
    decisionId: "decision-1",
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    toolId: "artifact.write",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    argumentsDigest: digest("arguments"),
    targetDigest: digest("target"),
    previewDigest: digest("preview"),
    purpose: workOrder.purpose,
    policyRegistrationDigest: digest("policy-registration"),
    ...overrides,
  };
}

function decisionChallenge(
  overrides: Partial<DecisionSubmissionChallenge> = {},
): DecisionSubmissionChallenge {
  return {
    schemaVersion: "1",
    id: "challenge-1",
    issuerId: "issuer-a",
    proofDigest: digest("challenge-proof"),
    binding: proposedEffectBinding(),
    requiredAuthenticationStrength: "user_presence",
    issuedAt: instant,
    expiresAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  const challenge = decisionChallenge();
  return {
    schemaVersion: "1",
    id: "approval-1",
    issuerId: "issuer-a",
    challengeId: challenge.id,
    challengeProofDigest: challenge.proofDigest,
    binding: challenge.binding,
    approvedBy: { type: "user", id: "user-1" },
    authenticationStrength: "user_presence",
    createdAt: instant,
    expiresAt: "2026-08-03T10:30:00.000Z",
    maximumUses: 1,
    ...overrides,
  };
}

function decisionGate(overrides: Partial<DecisionGate> = {}): DecisionGate {
  const binding = proposedEffectBinding();
  return {
    schemaVersion: "1",
    decisionId: binding.decisionId,
    tenantId: binding.tenant.id,
    runId: binding.runId,
    requestingEventId: "event-approval-requested",
    binding,
    decisionGateDigest: digestCanonicalJson(binding),
    requiredAuthenticationStrength: "user_presence",
    createdAt: instant,
    ...overrides,
  };
}

type AuthorizationDoubleRow = Readonly<{
  reservationId: string;
  authorizationKey: string;
  reservation: unknown;
}>;
type EffectDoubleRow = Readonly<{
  effectId: string;
  runId: string;
  effectKey: string;
  operationKey: string | null;
  effect: unknown;
}>;

function sqlString(value: unknown): string {
  if (typeof value !== "string") throw new Error("KAF_TEST_SQL_STRING_EXPECTED");
  return value;
}

function nullableSqlString(value: unknown): string | null {
  if (value === null) return null;
  return sqlString(value);
}

class TransactionDouble implements PostgresClient, PostgresDatabase {
  readonly statements: string[] = [];
  readonly parameterBatches: unknown[][] = [];
  readonly advisoryLockValues: string[] = [];
  durableWrites: string[] = [];
  mutationAttempts = 0;
  commandRows = new Map<string, readonly unknown[]>();
  authorizationRows = new Map<string, AuthorizationDoubleRow>();
  effectRows = new Map<string, EffectDoubleRow>();
  challengeRows = new Map<string, DecisionSubmissionChallenge>();
  approvalRows = new Map<string, Approval>();
  grantRows = new Map<string, Readonly<{ grant: CapabilityGrant; remainingUses: number }>>();
  releases = 0;
  projectionRow: ReturnType<typeof acceptedProjection> | undefined;
  leaseActive = true;
  transitions = new Set<string>();
  runBindings = new Map<string, string>([["tenant-a:run-1", "work-order-1"]]);
  #snapshot:
    | Readonly<{
        commandRows: Map<string, readonly unknown[]>;
        authorizationRows: Map<string, AuthorizationDoubleRow>;
        effectRows: Map<string, EffectDoubleRow>;
        challengeRows: Map<string, DecisionSubmissionChallenge>;
        approvalRows: Map<string, Approval>;
        grantRows: Map<string, Readonly<{ grant: CapabilityGrant; remainingUses: number }>>;
        transitions: Set<string>;
        runBindings: Map<string, string>;
        durableWrites: string[];
      }>
    | undefined;

  constructor(readonly failMutationAt?: number) {}

  connect(): Promise<PostgresClient> {
    return Promise.resolve(this);
  }
  release(): void {
    this.releases += 1;
  }
  query<Row>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const normalized = text.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    this.parameterBatches.push(structuredClone([...values]));
    if (text.includes("pg_advisory_xact_lock")) {
      this.advisoryLockValues.push(sqlString(values[0]));
    }
    if (text === "BEGIN") {
      this.#snapshot = {
        commandRows: structuredClone(this.commandRows),
        authorizationRows: structuredClone(this.authorizationRows),
        effectRows: structuredClone(this.effectRows),
        challengeRows: structuredClone(this.challengeRows),
        approvalRows: structuredClone(this.approvalRows),
        grantRows: structuredClone(this.grantRows),
        transitions: structuredClone(this.transitions),
        runBindings: structuredClone(this.runBindings),
        durableWrites: structuredClone(this.durableWrites),
      };
    }
    if (text === "COMMIT") this.#snapshot = undefined;
    if (text === "ROLLBACK" && this.#snapshot !== undefined) {
      this.commandRows = this.#snapshot.commandRows;
      this.authorizationRows = this.#snapshot.authorizationRows;
      this.effectRows = this.#snapshot.effectRows;
      this.challengeRows = this.#snapshot.challengeRows;
      this.approvalRows = this.#snapshot.approvalRows;
      this.grantRows = this.#snapshot.grantRows;
      this.transitions = this.#snapshot.transitions;
      this.runBindings = this.#snapshot.runBindings;
      this.durableWrites = this.#snapshot.durableWrites;
      this.#snapshot = undefined;
    }
    if (/^(?:INSERT|UPDATE|DELETE)\b/u.test(normalized)) {
      this.mutationAttempts += 1;
      if (this.mutationAttempts === this.failMutationAt) {
        throw new Error(`KAF_TEST_CRASH_AT_WRITE_${String(this.mutationAttempts)}`);
      }
      this.durableWrites.push(normalized);
    }
    if (text.includes("FROM pactmark_commands")) {
      const stored = this.commandRows.get(
        `${String(values[0])}:${String(values[1])}:${String(values[2])}`,
      );
      return Promise.resolve({
        rows:
          stored === undefined
            ? []
            : ([
                {
                  scope_json: stored[6],
                  request_digest: stored[7],
                  command_record_json: stored[8],
                  value_json: stored[9],
                },
              ] as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("FROM pactmark_decision_challenges")) {
      const tenantId = String(values[0]);
      const challengeId = String(values.length === 3 ? values[2] : values[1]);
      const stored = this.challengeRows.get(`${tenantId}:${challengeId}`);
      return Promise.resolve({
        rows: stored === undefined ? [] : ([{ challenge_json: stored }] as unknown as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("FROM pactmark_capability_grant_use_claims")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("FROM pactmark_capability_grants")) {
      const stored = this.grantRows.get(`${String(values[0])}:${String(values[1])}`);
      return Promise.resolve({
        rows:
          stored === undefined
            ? []
            : ([
                { grant_json: stored.grant, remaining_uses: stored.remainingUses },
              ] as unknown as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("INSERT INTO pactmark_capability_grants")) {
      this.grantRows.set(`${String(values[0])}:${String(values[1])}`, {
        grant: JSON.parse(sqlString(values[14])) as CapabilityGrant,
        remainingUses: Number(values[10]),
      });
    }
    if (text.includes("UPDATE pactmark_capability_grants")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const stored = this.grantRows.get(key);
      if (stored !== undefined) {
        this.grantRows.set(key, { ...stored, remainingUses: stored.remainingUses - 1 });
      }
    }
    if (text.includes("INSERT INTO pactmark_decision_challenges")) {
      this.challengeRows.set(
        `${String(values[0])}:${String(values[2])}`,
        JSON.parse(sqlString(values[6])) as DecisionSubmissionChallenge,
      );
    }
    if (text.includes("UPDATE pactmark_decision_challenges")) {
      this.challengeRows.set(
        `${String(values[4])}:${String(values[6])}`,
        JSON.parse(sqlString(values[3])) as DecisionSubmissionChallenge,
      );
    }
    if (text.includes("FROM pactmark_approvals")) {
      const stored = this.approvalRows.get(`${String(values[0])}:${String(values[1])}`);
      return Promise.resolve({
        rows: stored === undefined ? [] : ([{ approval_json: stored }] as unknown as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("INSERT INTO pactmark_approvals")) {
      this.approvalRows.set(
        `${String(values[0])}:${String(values[2])}`,
        JSON.parse(sqlString(values[8])) as Approval,
      );
    }
    if (text.includes("INSERT INTO pactmark_commands")) {
      this.commandRows.set(
        `${String(values[0])}:${String(values[1])}:${String(values[2])}`,
        values,
      );
    }
    if (text.includes("FROM pactmark_authorization_reservations")) {
      const tenantId = String(values[0]);
      const reservationId = String(values[1]);
      const authorizationKey = values[2] === undefined ? undefined : sqlString(values[2]);
      const stored = [...this.authorizationRows.entries()].find(
        ([key, row]) =>
          key.startsWith(`${tenantId}:`) &&
          (row.reservationId === reservationId || row.authorizationKey === authorizationKey),
      )?.[1];
      return Promise.resolve({
        rows:
          stored === undefined
            ? []
            : ([{ reservation_json: stored.reservation }] as unknown as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("INSERT INTO pactmark_authorization_reservations")) {
      this.authorizationRows.set(`${String(values[0])}:${String(values[1])}`, {
        reservationId: String(values[1]),
        authorizationKey: String(values[2]),
        reservation: values[8],
      });
    }
    if (text.includes("FROM pactmark_effects")) {
      const tenantId = String(values[0]);
      const runId = String(values[1]);
      if (values.length === 3) {
        const lookup = String(values[2]);
        const stored = [...this.effectRows.entries()].find(
          ([key, row]) =>
            key.startsWith(`${tenantId}:`) &&
            row.runId === runId &&
            (text.includes("effect_key=$3") ? row.effectKey === lookup : row.effectId === lookup),
        )?.[1];
        return Promise.resolve({
          rows:
            stored === undefined
              ? []
              : ([
                  {
                    effect_id: stored.effectId,
                    run_id: stored.runId,
                    effect_json: stored.effect,
                  },
                ] as unknown as Row[]),
          rowCount: stored === undefined ? 0 : 1,
        });
      }
      const effectId = String(values[2]);
      const effectKey = String(values[3]);
      const operationKey = nullableSqlString(values[4]);
      const stored = [...this.effectRows.entries()].find(
        ([key, row]) =>
          key.startsWith(`${tenantId}:`) &&
          ((row.runId === runId && (row.effectId === effectId || row.effectKey === effectKey)) ||
            (operationKey !== null && row.operationKey === operationKey)),
      )?.[1];
      return Promise.resolve({
        rows:
          stored === undefined
            ? []
            : ([
                {
                  effect_id: stored.effectId,
                  run_id: stored.runId,
                  effect_json: stored.effect,
                },
              ] as unknown as Row[]),
        rowCount: stored === undefined ? 0 : 1,
      });
    }
    if (text.includes("INSERT INTO pactmark_effects")) {
      this.effectRows.set(`${String(values[0])}:${String(values[1])}:${String(values[2])}`, {
        effectId: String(values[2]),
        runId: String(values[1]),
        operationKey: nullableSqlString(values[3]),
        effect: values[6],
        effectKey: String(values[7]),
      });
    }
    if (text.includes("UPDATE pactmark_effects SET")) {
      const key = `${String(values[3])}:${String(values[4])}:${String(values[5])}`;
      const existing = this.effectRows.get(key);
      if (existing !== undefined) this.effectRows.set(key, { ...existing, effect: values[1] });
    }
    if (text.includes("FROM pactmark_work_orders")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("INSERT INTO pactmark_run_work_orders")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const existing = this.runBindings.get(key);
      if (existing !== undefined) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.runBindings.set(key, String(values[2]));
      return Promise.resolve({
        rows: [{ work_order_binding_digest: values[3] }] as Row[],
        rowCount: 1,
      });
    }
    if (text.includes("FROM pactmark_run_work_orders")) {
      const workOrderId = this.runBindings.get(`${String(values[0])}:${String(values[1])}`);
      return Promise.resolve({
        rows:
          workOrderId === undefined
            ? []
            : ([
                {
                  work_order_id: workOrderId,
                  work_order_binding_digest: acceptedWorkOrder().workOrderBindingDigest,
                  execution_definition_digest: executionDefinitionDigest,
                },
              ] as Row[]),
        rowCount: workOrderId === undefined ? 0 : 1,
      });
    }
    if (text.includes("FROM pactmark_run_events")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("FROM pactmark_run_projections")) {
      return Promise.resolve({
        rows:
          this.projectionRow === undefined
            ? []
            : ([
                {
                  projection_json: this.projectionRow,
                  last_sequence: this.projectionRow.lastSequence,
                },
              ] as Row[]),
        rowCount: this.projectionRow === undefined ? 0 : 1,
      });
    }
    if (text.includes("FROM pactmark_run_transitions")) {
      const found = this.transitions.has(String(values[1]));
      return Promise.resolve({
        rows: found ? ([{ present: 1 }] as Row[]) : [],
        rowCount: found ? 1 : 0,
      });
    }
    if (text.includes("INSERT INTO pactmark_run_transitions")) {
      this.transitions.add(String(values[2]));
    }
    if (text.includes("FROM pactmark_run_leases")) {
      return Promise.resolve({
        rows: this.leaseActive ? ([{ present: 1 }] as Row[]) : [],
        rowCount: this.leaseActive ? 1 : 0,
      });
    }
    if (text.includes("INSERT INTO pactmark_wakeups")) {
      return Promise.resolve({
        rows: [{ request_digest: values[6], wakeup_id: values[2] }] as Row[],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: text.startsWith("INSERT") ? 1 : 0 });
  }
}

const protector: DataProtector = {
  protect: (_binding, plaintext) =>
    Promise.resolve({
      ...protectedValue("work-order"),
      ciphertextDigest: digest(new TextDecoder().decode(plaintext)),
    }),
  unprotect: () => Promise.reject(new Error("not used")),
};

describe("PostgresRunCommandUnitOfWork", () => {
  it("passes the reusable @pactmark/testing command UOW contract", async () => {
    const database = new TransactionDouble();
    const unitOfWork = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const commandScope = scope();
    const context = createCommandContext({
      commandId,
      operation: commandScope.operation,
      payload: { contract: true },
    });
    await expect(
      runRunCommandUnitOfWorkContract(() => ({
        unitOfWork,
        scope: commandScope,
        context,
        expectedValue: { runId: "contract-run" },
        sensitiveErrorMarker: "postgres-uow-sensitive-marker",
        errorSurface: (error: unknown) => ({
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "KAF_TESTING_COMMAND_FAILED",
          message: "Command rejected",
        }),
        observeAtomicCommandAndWakeup: () => Promise.resolve(true),
      })),
    ).resolves.toMatchObject({ suite: "RunCommandUnitOfWork" });
  });

  it("commits work order, event/projection, command, and wakeup in one transaction and replays", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
      dataProtector: protector,
      now: () => instant,
      generateWakeupId: () => "wakeup-1",
    });
    const commandScope = scope();
    const context = createCommandContext({
      commandId,
      operation: "start",
      payload: { a: 1 },
    });
    const callback = vi.fn(async (transaction: RunCommandTransaction) => {
      await transaction.putAcceptedWorkOrder(acceptedWorkOrder());
      await transaction.appendRunEvent(runAccepted());
      await transaction.putRunProjection(acceptedProjection());
      await transaction.enqueueWakeup({
        schemaVersion: "1",
        tenantId: "tenant-a",
        runId: "run-1",
        reason: "run_accepted",
        notBefore: instant,
        deduplicationKey: "run-1:accepted",
        payload: {},
      });
      await transaction.putCommandRecord(record(commandScope, context.requestDigest));
      return { runId: "run-1" } satisfies JsonValue;
    });
    const first = await unit.transactCommand(commandScope, context, callback);
    expect(first.replayed).toBe(false);
    expect(first.value).toEqual({ runId: "run-1" });
    const replay = await unit.transactCommand(commandScope, context, callback);
    expect(replay).toMatchObject({ replayed: true, value: { runId: "run-1" } });
    expect(callback).toHaveBeenCalledOnce();
    expect(database.statements.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(database.statements.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(database.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO pactmark_work_orders"),
        expect.stringContaining("INSERT INTO pactmark_run_events"),
        expect.stringContaining("INSERT INTO pactmark_run_projections"),
        expect.stringContaining("INSERT INTO pactmark_wakeups"),
        expect.stringContaining("INSERT INTO pactmark_commands"),
      ]),
    );
    expect(database.advisoryLockValues).not.toHaveLength(0);
    expect(database.advisoryLockValues).toEqual(
      expect.not.arrayContaining([expect.stringContaining("\u0000")]),
    );
  });

  it("commits a protected input submission through the same command transaction", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
      dataProtector: protector,
    });
    const commandScope = scope({ operation: "submit_input" });
    const context = createCommandContext({
      commandId,
      operation: commandScope.operation,
      payload: { runId: "run-1", requestId: "request-1" },
    });
    await unit.transactCommand(commandScope, context, async (transaction) => {
      await transaction.putInputSubmission({ ...inputSubmission(), consumingCommandId: commandId });
      await transaction.putCommandRecord(record(commandScope, context.requestDigest));
      return { runId: "run-1", requestId: "request-1" };
    });
    expect(database.statements).toEqual(
      expect.arrayContaining([expect.stringContaining("INSERT INTO pactmark_input_submissions")]),
    );
  });

  it("rolls back accepted work, grant, event, projection, wakeup, and command at every SQL write boundary", async () => {
    const execute = async (database: TransactionDouble) => {
      const unit = new PostgresRunCommandUnitOfWork(database, {
        securityProfile: createPostgresStorageSecurityProfile(),
        dataProtector: protector,
        now: () => instant,
        generateWakeupId: () => "wakeup-crash-test",
      });
      const commandScope = scope();
      const context = createCommandContext({
        commandId,
        operation: commandScope.operation,
        payload: { crashBoundary: true },
      });
      return unit.transactCommand(commandScope, context, async (transaction) => {
        await transaction.putAcceptedWorkOrder(acceptedWorkOrder());
        await transaction.issueCapabilityGrant(capabilityGrant());
        await transaction.reserveCapabilityGrantUse(
          "tenant-a",
          "grant-1",
          "authorization-key-1",
          instant,
        );
        await transaction.appendRunEvent(runAccepted());
        await transaction.putRunProjection(acceptedProjection());
        await transaction.enqueueWakeup({
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId: "run-1",
          reason: "run_accepted",
          notBefore: instant,
          deduplicationKey: "run-1:crash-boundary",
          payload: {},
        });
        await transaction.putCommandRecord(record(commandScope, context.requestDigest));
        return { runId: "run-1" };
      });
    };

    const successful = new TransactionDouble();
    await execute(successful);
    expect(successful.mutationAttempts).toBeGreaterThanOrEqual(6);
    for (let boundary = 1; boundary <= successful.mutationAttempts; boundary += 1) {
      const crashing = new TransactionDouble(boundary);
      await expect(execute(crashing)).rejects.toThrow(
        `KAF_TEST_CRASH_AT_WRITE_${String(boundary)}`,
      );
      expect(crashing.durableWrites, `write boundary ${String(boundary)}`).toEqual([]);
      expect(crashing.commandRows.size, `command boundary ${String(boundary)}`).toBe(0);
      expect(crashing.statements).toContain("ROLLBACK");
    }
  });

  it("persists input by reference only and rolls its transaction back at every SQL write boundary", async () => {
    const rawMarker = "KAF_RAW_INPUT_MUST_NEVER_PERSIST_7d2d0a";
    const inputEvent = {
      ...runAccepted(),
      eventId: "event-input-submitted",
      eventType: "InputSubmitted" as const,
      payload: {
        stepId: "step-1",
        requestId: "request-1",
        inputSubmissionRecordId: "submission-1",
        inputSchemaDigest: inputSubmission().inputSchemaDigest,
        valueDigest: inputSubmission().valueDigest,
      },
    };
    const inputProjection = {
      ...acceptedProjection(),
      status: "planning" as const,
      updatedAt: instant,
    };
    const execute = async (database: TransactionDouble) => {
      const unit = new PostgresRunCommandUnitOfWork(database, {
        securityProfile: createPostgresStorageSecurityProfile(),
        dataProtector: protector,
        now: () => instant,
      });
      const commandScope = scope({ operation: "submit_input" });
      const context = createCommandContext({
        commandId,
        operation: commandScope.operation,
        payload: { value: rawMarker },
      });
      return unit.transactCommand(commandScope, context, async (transaction) => {
        await transaction.putInputSubmission({
          ...inputSubmission(),
          consumingCommandId: commandId,
        });
        await transaction.appendRunEvent(inputEvent);
        await transaction.putRunProjection(inputProjection);
        await transaction.enqueueWakeup({
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId: "run-1",
          reason: "input_submitted",
          notBefore: instant,
          deduplicationKey: "run-1:input-submitted",
          payload: { inputSubmissionRecordId: "submission-1" },
        });
        await transaction.putCommandRecord(record(commandScope, context.requestDigest));
        return { inputSubmissionRecordId: "submission-1" };
      });
    };

    const successful = new TransactionDouble();
    await execute(successful);
    expect(JSON.stringify(successful.parameterBatches)).not.toContain(rawMarker);
    const eventParameters = successful.parameterBatches.find((batch) =>
      batch.includes("event-input-submitted"),
    );
    expect(eventParameters).toBeDefined();
    expect(JSON.stringify(eventParameters)).toContain("inputSubmissionRecordId");
    expect(JSON.stringify(eventParameters)).not.toContain("protectedValue");

    for (let boundary = 1; boundary <= successful.mutationAttempts; boundary += 1) {
      const crashing = new TransactionDouble(boundary);
      await expect(execute(crashing)).rejects.toThrow(
        `KAF_TEST_CRASH_AT_WRITE_${String(boundary)}`,
      );
      expect(crashing.durableWrites, `input boundary ${String(boundary)}`).toEqual([]);
      expect(crashing.commandRows.size).toBe(0);
    }
  });

  it("consumes one challenge with its bound approval atomically at every SQL write boundary", async () => {
    const originalChallenge = decisionChallenge();
    const approvalEvent = {
      ...runAccepted(),
      eventId: "event-approval-recorded",
      eventType: "ApprovalRecorded" as const,
      payload: {
        stepId: "step-1",
        decisionId: "decision-1",
        approvalId: "approval-1",
        resumeTarget: "running" as const,
      },
    };
    const approvalProjection = {
      ...acceptedProjection(),
      status: "running" as const,
      updatedAt: instant,
    };
    const execute = async (database: TransactionDouble, approvalValue: Approval = approval()) => {
      const unit = new PostgresRunCommandUnitOfWork(database, {
        securityProfile: createPostgresStorageSecurityProfile(),
        now: () => instant,
      });
      const commandScope = scope({ operation: "submit_decision" });
      const context = createCommandContext({
        commandId,
        operation: commandScope.operation,
        payload: { decisionId: "decision-1", challengeProof: "reference-only" },
      });
      return unit.transactCommand(commandScope, context, async (transaction) => {
        await transaction.consumeDecisionChallenge("tenant-a", "challenge-1", commandId, instant);
        await transaction.putApproval(approvalValue);
        await transaction.claimApproval(
          "tenant-a",
          "approval-1",
          "authorization-key-approval-1",
          instant,
        );
        await transaction.appendRunEvent(approvalEvent);
        await transaction.putRunProjection(approvalProjection);
        await transaction.enqueueWakeup({
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId: "run-1",
          reason: "decision_recorded",
          notBefore: instant,
          deduplicationKey: "run-1:approval-recorded",
          payload: { approvalId: "approval-1" },
        });
        await transaction.putCommandRecord(record(commandScope, context.requestDigest));
        return { approvalId: "approval-1" };
      });
    };
    const seeded = (failMutationAt?: number) => {
      const database = new TransactionDouble(failMutationAt);
      database.challengeRows.set("tenant-a:challenge-1", structuredClone(originalChallenge));
      return database;
    };

    const successful = seeded();
    await expect(execute(successful)).resolves.toMatchObject({ replayed: false });
    expect(successful.challengeRows.get("tenant-a:challenge-1")).toMatchObject({
      consumingCommandId: commandId,
      consumedAt: instant,
    });
    expect(successful.approvalRows.get("tenant-a:approval-1")).toEqual(approval());

    for (let boundary = 1; boundary <= successful.mutationAttempts; boundary += 1) {
      const crashing = seeded(boundary);
      await expect(execute(crashing)).rejects.toThrow(
        `KAF_TEST_CRASH_AT_WRITE_${String(boundary)}`,
      );
      expect(
        crashing.challengeRows.get("tenant-a:challenge-1"),
        `challenge boundary ${String(boundary)}`,
      ).toEqual(originalChallenge);
      expect(crashing.approvalRows.size).toBe(0);
      expect(crashing.commandRows.size).toBe(0);
      expect(crashing.durableWrites).toEqual([]);
    }

    const drifted = seeded();
    await expect(
      execute(
        drifted,
        approval({ binding: proposedEffectBinding({ previewDigest: digest("drifted-preview") }) }),
      ),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    expect(drifted.challengeRows.get("tenant-a:challenge-1")).toEqual(originalChallenge);
    expect(drifted.approvalRows.size).toBe(0);

    const otherCommandId = `${commandId.slice(0, -1)}2`;
    const otherScope = scope({ commandId: otherCommandId, operation: "submit_decision" });
    const otherContext = createCommandContext({
      commandId: otherCommandId,
      operation: otherScope.operation,
      payload: { decisionId: "decision-1" },
    });
    const unit = new PostgresRunCommandUnitOfWork(successful, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    await expect(
      unit.transactCommand(otherScope, otherContext, async (transaction) => {
        await transaction.consumeDecisionChallenge(
          "tenant-a",
          "challenge-1",
          otherCommandId,
          instant,
        );
        await transaction.putCommandRecord(record(otherScope, otherContext.requestDigest));
        return null;
      }),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("writes a decision gate and reference-only challenge once and rejects binding drift", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const commandScope = scope({ operation: "request_decision" });
    const context = createCommandContext({
      commandId,
      operation: commandScope.operation,
      payload: { decisionId: "decision-1" },
    });
    const callback = vi.fn(async (transaction: RunCommandTransaction) => {
      await transaction.putDecisionGate(decisionGate());
      await transaction.putDecisionChallenge(decisionChallenge());
      await transaction.putCommandRecord(record(commandScope, context.requestDigest));
      return { challengeId: "challenge-1" };
    });
    await expect(unit.transactCommand(commandScope, context, callback)).resolves.toMatchObject({
      replayed: false,
    });
    await expect(unit.transactCommand(commandScope, context, callback)).resolves.toMatchObject({
      replayed: true,
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(JSON.stringify(database.parameterBatches)).not.toContain("challengeProof");

    const driftedDatabase = new TransactionDouble();
    const driftedUnit = new PostgresRunCommandUnitOfWork(driftedDatabase, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    await expect(
      driftedUnit.transactCommand(commandScope, context, async (transaction) => {
        await transaction.putDecisionChallenge(decisionChallenge());
        await transaction.putDecisionChallenge(
          decisionChallenge({
            binding: proposedEffectBinding({ previewDigest: digest("changed-preview") }),
          }),
        );
        await transaction.putCommandRecord(record(commandScope, context.requestDigest));
        return null;
      }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    expect(driftedDatabase.challengeRows.size).toBe(0);
  });

  it("scopes idempotency by full CommandScope and rejects changed request digests", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const firstScope = scope();
    const firstContext = createCommandContext({
      commandId,
      operation: "start",
      payload: { a: 1 },
    });
    const write =
      (boundScope: CommandScope, requestDigest: string) =>
      async (transaction: RunCommandTransaction) => {
        await transaction.putCommandRecord(record(boundScope, requestDigest));
        return { ok: true };
      };
    await unit.transactCommand(
      firstScope,
      firstContext,
      write(firstScope, firstContext.requestDigest),
    );
    const changed = createCommandContext({
      commandId,
      operation: "start",
      payload: { a: 2 },
    });
    await expect(
      unit.transactCommand(firstScope, changed, write(firstScope, changed.requestDigest)),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
    const otherScope = scope({ principal: { type: "user", id: "user-2" } });
    await expect(
      unit.transactCommand(otherScope, firstContext, write(otherScope, firstContext.requestDigest)),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("fails closed for cross-tenant records", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const commandScope = scope();
    const context = createCommandContext({
      commandId,
      operation: "start",
      payload: {},
    });
    await expect(
      unit.transactCommand(commandScope, context, async (transaction) => {
        await transaction.appendRunEvent(runAccepted({ tenantId: "tenant-b" }));
        return null;
      }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    expect(database.statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
  });

  it("rejects a cross-tenant identifier-only operation before resource SQL", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const commandScope = scope();
    const context = createCommandContext({
      commandId,
      operation: "start",
      payload: {},
    });
    const attempts: Array<(transaction: RunCommandTransaction) => Promise<unknown>> = [
      (transaction: Parameters<Parameters<typeof unit.transactCommand>[2]>[0]) =>
        transaction.reserveCapabilityGrantUse("tenant-b", "grant-1", "authorization-1", instant),
      (transaction: Parameters<Parameters<typeof unit.transactCommand>[2]>[0]) =>
        transaction.consumeDecisionChallenge("tenant-b", "challenge-1", commandId, instant),
      (transaction: Parameters<Parameters<typeof unit.transactCommand>[2]>[0]) =>
        transaction.claimApproval("tenant-b", "approval-1", "authorization-1", instant),
    ];
    for (const attempt of attempts) {
      const statementCount = database.statements.length;
      await expect(unit.transactCommand(commandScope, context, attempt)).rejects.toMatchObject({
        code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
      });
      const statements = database.statements.slice(statementCount);
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(
        statements.some((statement) =>
          /pactmark_(?:capability_grant_use_claims|decision_challenges|approval_use_claims)/u.test(
            statement,
          ),
        ),
      ).toBe(false);
    }
  });

  it("serializes transitions against the bound run and active fencing token", async () => {
    const database = new TransactionDouble();
    database.projectionRow = acceptedProjection();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const key = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind: "resume",
      transitionKey: "resume-1",
      workOrderBindingDigest: database.projectionRow.workOrderBindingDigest,
      executionDefinitionDigest,
      leaseId: "lease-1",
      fencingToken: 4,
    };
    await expect(
      unit.transactTransition(key, () => Promise.resolve({ resumed: true })),
    ).resolves.toEqual({ resumed: true });
    await expect(
      unit.transactTransition(key, () => Promise.resolve({ resumed: true })),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      unit.transactTransition({ ...key, transitionKey: "resume-void" }, () => Promise.resolve()),
    ).resolves.toBeUndefined();

    const staleDatabase = new TransactionDouble();
    staleDatabase.projectionRow = acceptedProjection();
    staleDatabase.leaseActive = false;
    const staleUnit = new PostgresRunCommandUnitOfWork(staleDatabase, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    await expect(
      staleUnit.transactTransition(key, () => Promise.resolve(null)),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("commits authorization and prepared effect with command replay in one transaction", async () => {
    const database = new TransactionDouble();
    database.projectionRow = acceptedProjection();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const commandScope = scope({ operation: "prepare_effect" });
    const context = createCommandContext({
      commandId,
      operation: commandScope.operation,
      payload: { effectId: "effect-1" },
    });
    const callback = vi.fn(async (transaction: RunCommandTransaction) => {
      await transaction.putAuthorizationReservation(authorizationReservation());
      await transaction.putEffectRecord(preparedEffect());
      await transaction.putCommandRecord(record(commandScope, context.requestDigest));
      return { effectId: "effect-1" };
    });
    await expect(unit.transactCommand(commandScope, context, callback)).resolves.toMatchObject({
      replayed: false,
      value: { effectId: "effect-1" },
    });
    await expect(unit.transactCommand(commandScope, context, callback)).resolves.toMatchObject({
      replayed: true,
      value: { effectId: "effect-1" },
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(database.authorizationRows.size).toBe(1);
    expect(database.effectRows.size).toBe(1);
    expect(database.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO pactmark_authorization_reservations"),
        expect.stringContaining("INSERT INTO pactmark_effects"),
        expect.stringContaining("INSERT INTO pactmark_commands"),
      ]),
    );
    const ledger = new PostgresEffectLedger(database, createPostgresStorageSecurityProfile());
    await expect(ledger.getByEffectId("tenant-a", "run-1", "effect-1")).resolves.toMatchObject({
      state: "prepared",
      effectKey: "effect-key-1",
    });
    const prepared = preparedEffect();
    const dispatched = {
      ...prepared,
      state: "dispatched" as const,
      dispatchedAt: "2026-08-03T10:00:01.000Z",
      updatedAt: "2026-08-03T10:00:01.000Z",
    };
    await unit.transactTransition(
      {
        schemaVersion: "1",
        tenantId: "tenant-a",
        runId: "run-1",
        transitionKind: "EffectDispatched",
        transitionKey: "effect-1:dispatched",
        workOrderBindingDigest: database.projectionRow.workOrderBindingDigest,
        executionDefinitionDigest,
        leaseId: "lease-1",
        fencingToken: 9,
      },
      async (transaction) => {
        await transaction.putEffectRecord(dispatched);
        return null;
      },
    );
    await expect(ledger.getByEffectKey("tenant-a", "run-1", "effect-key-1")).resolves.toMatchObject(
      { state: "dispatched", dispatchedAt: "2026-08-03T10:00:01.000Z" },
    );
  });

  it("resumes a v0.2 prepared effect whose authorization is still reserved", async () => {
    const database = new TransactionDouble();
    database.projectionRow = acceptedProjection();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const transition = (transitionKind: "EffectPrepared" | "EffectDispatched") => ({
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind,
      transitionKey: `effect-1:${transitionKind}`,
      workOrderBindingDigest: database.projectionRow!.workOrderBindingDigest,
      executionDefinitionDigest,
      leaseId: "lease-1",
      fencingToken: 9,
    });
    await unit.transactTransition(transition("EffectPrepared"), async (transaction) => {
      await transaction.putAuthorizationReservation(legacyReservedAuthorization());
      await transaction.putEffectRecord(preparedEffect());
      return null;
    });
    await unit.transactTransition(transition("EffectDispatched"), async (transaction) => {
      await transaction.putEffectRecord({
        ...preparedEffect(),
        state: "dispatched",
        dispatchedAt: "2026-08-03T10:00:01.000Z",
        updatedAt: "2026-08-03T10:00:01.000Z",
      });
      return null;
    });
    const ledger = new PostgresEffectLedger(database, createPostgresStorageSecurityProfile());
    await expect(ledger.getByEffectId("tenant-a", "run-1", "effect-1")).resolves.toMatchObject({
      state: "dispatched",
    });
  });

  it("rolls back crash-boundary effect writes and rejects digest, tenant, and key drift", async () => {
    const database = new TransactionDouble();
    const unit = new PostgresRunCommandUnitOfWork(database, {
      securityProfile: createPostgresStorageSecurityProfile(),
    });
    const attempt = (
      suffix: string,
      callback: (transaction: RunCommandTransaction) => Promise<unknown>,
    ) => {
      const commandScope = scope({ commandId: `${commandId.slice(0, -2)}${suffix}` });
      const context = createCommandContext({
        commandId: commandScope.commandId,
        operation: commandScope.operation,
        payload: { suffix },
      });
      return unit.transactCommand(commandScope, context, callback);
    };
    await expect(
      attempt("02", async (transaction) => {
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(preparedEffect());
        throw new Error("crash-after-effect-write");
      }),
    ).rejects.toThrow("crash-after-effect-write");
    expect(database.authorizationRows.size).toBe(0);
    expect(database.effectRows.size).toBe(0);

    await expect(
      attempt("03", async (transaction) => {
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(preparedEffect());
        const commandScope = scope({ commandId: `${commandId.slice(0, -2)}03` });
        const context = createCommandContext({
          commandId: commandScope.commandId,
          operation: commandScope.operation,
          payload: { suffix: "03" },
        });
        await transaction.putCommandRecord(record(commandScope, context.requestDigest));
        return null;
      }),
    ).resolves.toMatchObject({ replayed: false });

    await expect(
      attempt("04", (transaction) =>
        transaction.putAuthorizationReservation(
          authorizationReservation({ argumentsDigest: digest("changed") }),
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      attempt("05", (transaction) =>
        transaction.putAuthorizationReservation(
          authorizationReservation({ tenantId: "tenant-b", authorizationReservationId: "other" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      attempt("06", async (transaction) => {
        await transaction.putAuthorizationReservation(
          authorizationReservation({
            authorizationReservationId: "authorization-2",
            authorizationKey: "effect-key-2",
            effectKey: "effect-key-2",
          }),
        );
        await transaction.putEffectRecord(
          preparedEffect({ effectId: "effect-2", effectKey: "effect-key-2" }),
        );
        return null;
      }),
    ).rejects.toMatchObject({ code: "KAF_AUTHORIZATION_BINDING_MISMATCH" });
    expect(database.statements.filter((sql) => sql === "ROLLBACK").length).toBeGreaterThanOrEqual(
      4,
    );
  });
});
