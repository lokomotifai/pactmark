import { describe, expect, it } from "vitest";

import {
  KafError,
  RunEventSchema,
  RuntimeReadinessReportSchema,
  createRunProjection,
  digestCanonicalJson,
  rebuildRunProjection,
  type AuthorityContext,
  type EvidenceRecord,
  type RunEvent,
} from "@pactmark/core";
import { buildEvidenceRecord } from "@pactmark/evidence";

import {
  CliError,
  runCli,
  safeCanonicalJson,
  safeMultiline,
  toCliPublicError,
  visibleText,
  type CliIo,
  type PactmarkCliHost,
} from "../src/index.js";

const d = (value: unknown) => digestCanonicalJson(value);
const definition = {
  kind: "agent" as const,
  id: "fixture-agent",
  version: "1.0.0",
  agentDefinitionDigest: d("agent"),
};
const projection = createRunProjection({
  schemaVersion: "1",
  runId: "run-1",
  tenantId: "tenant-1",
  workOrderId: "work-order-1",
  workOrderBindingDigest: d("work-order"),
  executionDefinition: definition,
  executionDefinitionDigest: d(definition),
  status: "completed",
  createdAt: "2026-08-03T12:00:00Z",
  updatedAt: "2026-08-03T12:01:00Z",
  dataClass: "internal",
  correlationId: "correlation-1",
});
const event = RunEventSchema.parse({
  schemaVersion: "1",
  eventId: "event-1",
  runId: "run-1",
  sequence: 1,
  occurredAt: "2026-08-03T12:00:00Z",
  correlationId: "correlation-1",
  tenantId: "tenant-1",
  dataClass: "internal",
  executionDefinition: definition,
  executionDefinitionDigest: d(definition),
  eventType: "RunAccepted",
  payload: {
    workOrderId: "work-order-1",
    workOrderBindingDigest: d("work-order"),
    requiredVerifierIds: [],
  },
});
const failedEvent = RunEventSchema.parse({
  schemaVersion: "1",
  eventId: "event-2",
  runId: "run-1",
  sequence: 2,
  occurredAt: "2026-08-03T12:01:00Z",
  correlationId: "correlation-1",
  tenantId: "tenant-1",
  dataClass: "internal",
  executionDefinition: definition,
  executionDefinitionDigest: d(definition),
  prevHash: d(event),
  eventType: "RunFailed",
  payload: { errorCode: "KAF_TEST_FAILURE" },
});

const readiness = RuntimeReadinessReportSchema.parse({
  schemaVersion: "1",
  ready: false,
  profile: "production",
  capabilities: {
    schemaVersion: "1",
    executionProfile: "ephemeral",
    durableStorage: false,
    protectedContext: false,
    protectedWorkOrders: false,
    protectedInputSubmissions: false,
    streaming: true,
    cancellation: true,
    sandbox: "unsafe_local",
    networkPolicy: "declared",
    backgroundWakeup: false,
    atomicCommandAndWakeup: false,
    humanDecisions: false,
    typedInput: false,
    effectReconciliation: false,
    compensation: false,
    modelCredentials: false,
    toolCredentials: false,
    telemetry: "none",
    transactionDomains: ["memory"],
  },
  checks: [
    {
      schemaVersion: "1",
      id: "durability",
      status: "fail",
      code: "KAF_READINESS_DURABLE_REQUIRED",
      safeMessage: "Durability is required.\u001b]52;c;bad\u0007",
      remediationSlug: "configure-durability",
    },
  ],
  evaluatedAt: "2026-08-03T12:00:00Z",
  rulesVersion: "fixture@1",
});

function evidence(): EvidenceRecord {
  return buildEvidenceRecord({
    material: {
      schemaVersion: "1",
      evidenceRecordId: "evidence-1",
      tenantId: "tenant-1",
      runId: "run-1",
      executionDefinition: definition,
      executionDefinitionDigest: d(definition),
      workOrderBindingDigest: d("work-order"),
      claim: { statement: "Safe\u001b[31m claim", claimType: "quality", scope: "run-1" },
      supports: ["The recorded run completed"],
      doesNotProve: ["External factual correctness"],
      context: {
        roleFamily: "testing",
        workflowId: "fixture",
        riskClass: "low",
        purposeCode: "service_delivery",
      },
      workSplit: {
        ai: { kind: "unavailable", reason: "not_collected" },
        human: { kind: "unavailable", reason: "not_collected" },
        description: "Not measured",
      },
      permission: {
        purposeCode: "service_delivery",
        purposeRegistryVersion: "general@1",
        visibility: "private",
        dataClass: "internal",
        retention: { mode: "session" },
      },
      freshness: {
        observedAt: "2026-08-03T12:00:00Z",
        validAt: "2026-08-03T12:00:00Z",
      },
      observation: {
        firstObservedAt: "2026-08-03T12:00:00Z",
        lastObservedAt: "2026-08-03T12:00:00Z",
        count: 1,
        repetitionStatus: "single",
        independentObservationIds: ["observation-1"],
      },
      createdAt: "2026-08-03T12:00:00Z",
    },
    artifacts: [],
    events: [event],
    verifications: [],
    verifierReferences: [],
  });
}

interface Harness {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly files: Map<string, string>;
}

function host(overrides: Partial<PactmarkCliHost> = {}): PactmarkCliHost {
  const base: PactmarkCliHost = {
    authority: {} as AuthorityContext,
    runtime: {
      getRun: () => Promise.resolve(projection),
      async *events(_authority, _runId, options): AsyncIterable<RunEvent> {
        await Promise.resolve();
        if ((options?.afterSequence ?? 0) < 1) yield event;
      },
      evaluateReadiness: ({ profile }) => ({ ...readiness, profile }),
    },
    getEvidence: () => Promise.resolve(evidence()),
    migrationManager: {
      status: () => Promise.resolve({ currentVersion: "1", pending: ["2"] }),
      migrate: () => Promise.resolve(),
    },
    operate: (request) =>
      Promise.resolve({
        schemaVersion: "1",
        status: request.name === "audit.verify" ? "verified" : "completed",
        summary: `completed ${request.name}`,
        data: { argumentCount: request.arguments.length },
      }),
  };
  return { ...base, ...overrides };
}

function harness(configured: PactmarkCliHost | false = host(), isTty = false): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files = new Map<string, string>();
  return {
    stdout,
    stderr,
    files,
    io: {
      isTty,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      readTextFile: (path) => {
        const value = files.get(path);
        return value === undefined
          ? Promise.reject(new Error("missing secret=canary"))
          : Promise.resolve(value);
      },
      resolvePath: (path) => `/fixture/${path}`,
      loadHost: () => Promise.resolve(configured === false ? undefined : configured),
      compileAgentPackage: () =>
        Promise.resolve({
          schemaVersion: "1",
          command: "compile",
          manifestPath: ".pactmark/generated/agent-manifest.json",
          sourceDigest: d("source"),
          instructionBundleDigest: d("instructions"),
          skillManifestDigests: [],
          requiredCapabilities: [],
          fileCount: 1,
          summary: "Compiled 1 Pactmark instruction source(s).",
        }),
    },
  };
}

describe("CLI routing and safe output", () => {
  it("renders root and command help and version without loading a host", async () => {
    const test = harness(false);
    expect((await runCli([], test.io)).exitCode).toBe(0);
    expect((await runCli(["doctor", "--help"], test.io)).exitCode).toBe(0);
    expect((await runCli(["--version"], test.io)).exitCode).toBe(0);
    expect(test.stdout.join("")).toContain("Pactmark 0.1.0");
    expect(test.stdout.join("")).toContain("doctor");
  });

  it("returns stable redacted host and argument errors", async () => {
    const missing = harness(false);
    expect((await runCli(["doctor", "--json", "--debug"], missing.io)).exitCode).toBe(1);
    expect(missing.stderr.join("")).toContain("KAF_CLI_HOST_NOT_CONFIGURED");
    expect(missing.stderr.join("")).not.toContain("stack");
    const invalid = harness();
    await runCli(["unknown", "--json"], invalid.io);
    await runCli(["doctor", "--bogus"], invalid.io);
    await runCli(["doctor", "--json", "--json"], invalid.io);
    await runCli(["doctor", "--profile"], invalid.io);
    await runCli(["doctor", "--json=true"], invalid.io);
    await runCli(["--"], invalid.io);
    await runCli(["unknown", "--help"], invalid.io);
    expect(invalid.stderr.join("")).toContain("KAF_CLI_ARGUMENT_INVALID");
  });

  it("delegates doctor and cannot turn failed readiness into ready", async () => {
    const test = harness();
    await runCli(["doctor", "--production", "--json"], test.io);
    await runCli(["doctor", "--profile", "preview"], test.io);
    await runCli(["doctor", "--profile", "invalid"], test.io);
    const output = test.stdout.join("");
    expect(output).toContain('"ready":false');
    expect(output).toContain("Pactmark readiness: not ready (preview)");
    expect(output).toContain("\\u001b");
    expect(test.stderr.join("")).toContain("KAF_CLI_ARGUMENT_INVALID");
  });

  it("inspects projections and streams finite event snapshots", async () => {
    const test = harness();
    await runCli(["inspect", "run-1", "--json"], test.io);
    await runCli(["events", "run-1", "--after", "0", "--json"], test.io);
    await runCli(["events", "run-1", "--after", "-1"], test.io);
    await runCli(["inspect"], test.io);
    expect(test.stdout.join("")).toContain('"command":"inspect"');
    expect(test.stdout.join("")).toContain('"eventType":"RunAccepted"');
    expect(test.stderr.join("")).toContain("KAF_CLI_ARGUMENT_INVALID");
  });

  it("exports and verifies deterministic evidence", async () => {
    const record = evidence();
    const test = harness();
    test.files.set("/fixture/evidence.json", `${safeCanonicalJson(record)}\n`);
    test.files.set("/fixture/tampered.json", safeCanonicalJson({ ...record, runId: "other" }));
    test.files.set("/fixture/bad.json", "not json");
    await runCli(["evidence", "export", "run-1", "--format", "json"], test.io);
    await runCli(["evidence", "export", "run-1", "--format", "md"], test.io);
    await runCli(["evidence", "verify", "evidence.json", "--json"], test.io);
    await runCli(["evidence", "verify", "tampered.json"], test.io);
    await runCli(["evidence", "verify", "bad.json"], test.io);
    await runCli(["evidence", "verify", "missing.json"], test.io);
    await runCli(["evidence", "export", "run-1", "--format", "xml"], test.io);
    await runCli(["evidence", "bogus", "run-1"], test.io);
    expect(test.stdout.join("")).toContain('"valid":true');
    expect(test.stdout.join("")).toContain("# Evidence:");
    expect(test.stderr.join("").match(/KAF_CLI_EVIDENCE_INVALID/gu)?.length).toBe(3);
  });

  it("sanitizes evidence on a TTY and reports missing records and ports", async () => {
    const tty = harness(host(), true);
    await runCli(["evidence", "export", "run-1", "--format", "md"], tty.io);
    expect(tty.stdout.join("")).not.toContain("\u001b");
    expect(tty.stdout.join("")).toContain("\\u001b");
    const missing = harness(host({ getEvidence: () => Promise.resolve(undefined) }));
    await runCli(["evidence", "export", "run-1"], missing.io);
    const unsupported = harness(host({ getEvidence: undefined }));
    await runCli(["evidence", "export", "run-1"], unsupported.io);
    expect(missing.stderr.join("")).toContain("KAF_CLI_RESOURCE_NOT_FOUND");
    expect(unsupported.stderr.join("")).toContain("KAF_CLI_COMMAND_UNSUPPORTED");
  });

  it("delegates migrations only to the injected manager", async () => {
    const test = harness();
    await runCli(["migrate", "status", "--json"], test.io);
    await runCli(["migrate", "up"], test.io);
    await runCli(["migrate", "sideways"], test.io);
    const unsupported = harness(host({ migrationManager: undefined }));
    await runCli(["migrate", "status"], unsupported.io);
    expect(test.stdout.join("")).toContain('"pending":["2"]');
    expect(test.stdout.join("")).toContain("Migrations completed.");
    expect(unsupported.stderr.join("")).toContain("KAF_CLI_COMMAND_UNSUPPORTED");
  });

  it("routes host operations with parsed, non-authority inputs", async () => {
    const requests: unknown[] = [];
    const configured = host({
      operate: (request) => {
        requests.push(request);
        return Promise.resolve({
          schemaVersion: "1",
          status: "completed",
          summary: `ok ${request.name}`,
        });
      },
    });
    const test = harness(configured);
    test.files.set("/fixture/input.json", '{"value":2}');
    test.files.set("/fixture/resolution.json", '{"resolution":"abandon_uncertain"}');
    await runCli(["dev"], test.io);
    await runCli(["compile", "--json"], test.io);
    await runCli(["run", "agent-1", "--input", '{"value":1}'], test.io);
    await runCli(["run", "agent-1", "--input", "input.json"], test.io);
    await runCli(["test", "scenario-1"], test.io);
    await runCli(["eval", "suite-1"], test.io);
    await runCli(["audit", "verify", "run-1"], test.io);
    await runCli(["policy", "explain", "fixture.json"], test.io);
    await runCli(
      ["effects", "reconcile", "run-1", "effect-1", "--resolution", "resolution.json"],
      test.io,
    );
    await runCli(
      ["effects", "compensate", "run-1", "effect-1", "--request", '{"reason":"repair"}'],
      test.io,
    );
    expect(requests).toHaveLength(9);
    expect(requests).toContainEqual(
      expect.objectContaining({ name: "effects.reconcile", runId: "run-1", effectId: "effect-1" }),
    );
  });

  it("compiles without a configured host and replays without invoking operations", async () => {
    const compile = harness(false);
    expect((await runCli(["compile", "--json"], compile.io)).exitCode).toBe(0);
    expect(compile.stdout.join("")).toContain('"command":"compile"');

    if (event.eventType !== "RunAccepted") throw new Error("invalid test fixture");
    const replayInitial = createRunProjection({
      schemaVersion: "1",
      runId: event.runId,
      tenantId: event.tenantId,
      workOrderId: event.payload.workOrderId,
      workOrderBindingDigest: event.payload.workOrderBindingDigest,
      executionDefinition: event.executionDefinition,
      executionDefinitionDigest: event.executionDefinitionDigest,
      status: "created",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      dataClass: event.dataClass,
      correlationId: event.correlationId,
    });
    const replayProjection = rebuildRunProjection(replayInitial, [event, failedEvent]);
    let operations = 0;
    const replayHost = host({
      runtime: {
        getRun: () => Promise.resolve(replayProjection),
        async *events(): AsyncIterable<RunEvent> {
          await Promise.resolve();
          yield event;
          yield failedEvent;
        },
        evaluateReadiness: ({ profile }) => ({ ...readiness, profile }),
      },
      operate: () => {
        operations += 1;
        return Promise.resolve({ schemaVersion: "1", status: "completed", summary: "unsafe" });
      },
    });
    const replay = harness(replayHost);
    expect((await runCli(["replay", "run-1", "--json"], replay.io)).exitCode).toBe(0);
    expect(replay.stdout.join("")).toContain('"mode":"read_only"');
    expect(replay.stdout.join("")).toContain('"valid":true');
    expect(replay.stdout.join("")).toContain('"status":"verified"');
    expect(operations).toBe(0);
  });

  it("fails closed without opening an event tail for an active run", async () => {
    if (event.eventType !== "RunAccepted") throw new Error("invalid test fixture");
    const activeInitial = createRunProjection({
      schemaVersion: "1",
      runId: event.runId,
      tenantId: event.tenantId,
      workOrderId: event.payload.workOrderId,
      workOrderBindingDigest: event.payload.workOrderBindingDigest,
      executionDefinition: event.executionDefinition,
      executionDefinitionDigest: event.executionDefinitionDigest,
      status: "created",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      dataClass: event.dataClass,
      correlationId: event.correlationId,
    });
    const active = rebuildRunProjection(activeInitial, [event]);
    let streamsOpened = 0;
    let operations = 0;
    const test = harness(
      host({
        runtime: {
          getRun: () => Promise.resolve(active),
          async *events(): AsyncIterable<RunEvent> {
            streamsOpened += 1;
            await Promise.resolve();
            yield event;
          },
          evaluateReadiness: ({ profile }) => ({ ...readiness, profile }),
        },
        operate: () => {
          operations += 1;
          return Promise.resolve({ schemaVersion: "1", status: "completed", summary: "unsafe" });
        },
      }),
    );
    expect((await runCli(["replay", "run-1", "--json"], test.io)).exitCode).toBe(1);
    expect(test.stderr.join("")).toContain("KAF_CLI_REPLAY_INTEGRITY_FAILED");
    expect(streamsOpened).toBe(0);
    expect(operations).toBe(0);
  });

  it("combines typed host probes without overriding a core readiness failure", async () => {
    const test = harness(
      host({
        probeReadiness: () =>
          Promise.resolve([
            {
              schemaVersion: "1",
              id: "host.database",
              status: "pass",
              code: "KAF_CLI_DATABASE_READY",
              safeMessage: "The configured database probe passed.",
              remediationSlug: "configure-database",
              evidence: { latencyMs: 3 },
            },
          ]),
      }),
    );
    await runCli(["doctor", "--production", "--json"], test.io);
    expect(test.stdout.join("")).toContain('"hostProbes"');
    expect(test.stdout.join("")).toContain('"ready":false');
    expect(test.stdout.join("")).toContain('"id":"host.database"');
  });

  it("fails closed for malformed or unavailable operations", async () => {
    const test = harness(host({ operate: undefined }));
    await runCli(["dev"], test.io);
    const malformed = harness();
    await runCli(["run", "agent"], malformed.io);
    await runCli(["run", "agent", "--input", "missing.json"], malformed.io);
    await runCli(["audit", "wrong", "run-1"], malformed.io);
    await runCli(["policy", "wrong", "fixture"], malformed.io);
    await runCli(["effects", "wrong", "run", "effect"], malformed.io);
    await runCli(["effects", "reconcile", "run", "effect"], malformed.io);
    expect(test.stderr.join("")).toContain("KAF_CLI_COMMAND_UNSUPPORTED");
    expect(malformed.stderr.join("")).not.toContain("secret=canary");
  });

  it("schema-rejects host output with undeclared secret-bearing fields", async () => {
    const unsafe = harness(
      host({
        operate: () =>
          Promise.resolve({
            schemaVersion: "1",
            status: "completed",
            summary: "safe",
            secret: "credential-canary",
          }),
      }),
    );
    await runCli(["dev", "--json", "--debug"], unsafe.io);
    expect(unsafe.stderr.join("")).toContain("KAF_CLI_IO_FAILURE");
    expect(unsafe.stderr.join("")).not.toContain("credential-canary");
  });
});

describe("rendering and public errors", () => {
  it("escapes terminal controls, bidi, zero width and combining floods with bounds", () => {
    const malicious = `ok\u001b]0;title\u0007\rOVER\u202etarget\u2066\u200b${"\u0301".repeat(5000)}`;
    const rendered = visibleText(malicious);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u001b");
    expect(rendered).toContain("[truncated]");
    expect(safeMultiline("one\ntwo\nthree")).toBe("one\ntwo\nthree");
    expect(safeCanonicalJson({ malicious })).toContain("\\u202e");
  });

  it("serializes only safe KAF and redacted diagnostics", () => {
    expect(
      toCliPublicError(
        new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: "fixture" } }),
        true,
      ),
    ).toMatchObject({
      code: "KAF_CLI_ARGUMENT_INVALID",
      diagnostic: { kind: "redacted", errorType: "CliError" },
    });
    expect(
      JSON.stringify(
        toCliPublicError(
          new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: "secret-canary" } }),
          false,
        ),
      ),
    ).not.toContain("secret-canary");
    expect(
      toCliPublicError(
        new KafError("KAF_RUNTIME_NOT_READY", { causeCode: "KAF_POLICY_DENIED" }),
        true,
      ),
    ).toMatchObject({
      code: "KAF_RUNTIME_NOT_READY",
      causeCode: "KAF_POLICY_DENIED",
    });
    expect(toCliPublicError(new Error("Bearer secret"), true)).toMatchObject({
      code: "KAF_CLI_IO_FAILURE",
      diagnostic: { kind: "redacted", errorType: "Error" },
    });
    expect(
      JSON.stringify(
        toCliPublicError(
          new KafError("KAF_RUNTIME_NOT_READY", { details: { reason: "secret-canary" } }),
          false,
        ),
      ),
    ).not.toContain("secret-canary");
    expect(toCliPublicError("Bearer secret", true)).toMatchObject({
      diagnostic: { errorType: "UnknownError" },
    });
    expect(JSON.stringify(toCliPublicError("Bearer secret", false))).not.toContain("secret");
  });

  it("escapes unsafe astral combining code points", () => {
    expect(visibleText("\u{1d167}")).toBe("\\u{1d167}");
  });
});
