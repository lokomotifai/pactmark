import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { verifyEvidenceDigest } from "../../packages/evidence/src/index.js";
import { createPostgresDatabase, toPgPoolConfig } from "../../packages/store-postgres/src/index.js";
import { repositoryRoot } from "../lib/repository.mjs";

const connectionString = process.env["PACTMARK_TEST_POSTGRES_URL"];
if (connectionString === undefined || connectionString.length === 0)
  throw new Error("KAF_DURABLE_POSTGRES_URL_REQUIRED");
const scenarioId = randomBytes(6).toString("hex");
const tenantA = `Bearer tenant-a-${scenarioId}`;
const tenantB = `Bearer tenant-b-${scenarioId}`;
const serverScript = new URL("./server.mts", import.meta.url).pathname;
const database = createPostgresDatabase(
  toPgPoolConfig({
    profile: "development",
    connectionString,
    ssl: { mode: "disable" },
    maxConnections: 4,
    applicationName: "pactmark-durable-gate",
  }),
);

type ChildMessage = Readonly<Record<string, unknown>>;
type ManagedChild = Readonly<{
  child: ChildProcess;
  messages: AsyncIterable<ChildMessage>;
}>;

function startProcess(phase: "A" | "B"): ManagedChild {
  const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env["PATH"],
      PACTMARK_TEST_POSTGRES_URL: connectionString,
      PACTMARK_DURABLE_PHASE: phase,
      PACTMARK_DURABLE_SCENARIO_ID: scenarioId,
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const queue: ChildMessage[] = [];
  const waiters: ((message: ChildMessage) => void)[] = [];
  // Node's IPC overload is currently unresolved by typescript-eslint, while tsc validates it.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  child.on("message", (value: unknown) => {
    const message = isRecord(value)
      ? value
      : ({ type: "CHILD_PROTOCOL_INVALID" } satisfies ChildMessage);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(message);
    else waiter(message);
  });
  async function* messages(): AsyncIterable<ChildMessage> {
    for (;;) {
      const queued = queue.shift();
      if (queued !== undefined) yield queued;
      else
        yield await new Promise<ChildMessage>((resolve) => {
          waiters.push(resolve);
        });
    }
  }
  return { child, messages: messages() };
}

async function nextMessage(
  iterator: AsyncIterator<ChildMessage>,
  expectedType: string,
  timeoutMs = 20_000,
): Promise<ChildMessage> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`KAF_DURABLE_CHILD_TIMEOUT:${expectedType}`));
    }, timeoutMs);
    timer.unref();
  });
  for (;;) {
    const item = await Promise.race([iterator.next(), timeout]);
    if (item.done) throw new Error(`KAF_DURABLE_CHILD_EXITED:${expectedType}`);
    if (item.value["type"] === expectedType) return item.value;
  }
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (hasExited(child)) return;
  const exited = onceExit(child);
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
    }),
  ]);
  if (!hasExited(child)) {
    child.kill("SIGKILL");
    await onceExit(child);
  }
}

function onceExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function commandId(suffix: string): string {
  return `kafcmd_${String(Date.now())}_${suffix.repeat(32).slice(0, 32)}`;
}

function headers(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

let processA: ManagedChild | undefined;
let processB: ManagedChild | undefined;
try {
  processA = startProcess("A");
  const iteratorA = processA.messages[Symbol.asyncIterator]();
  const readyA = await nextMessage(iteratorA, "READY");
  if (typeof readyA["port"] !== "number") throw new Error("KAF_DURABLE_PORT_INVALID");
  const originA = `http://127.0.0.1:${String(readyA["port"])}`;
  const startedResponse = await fetch(`${originA}/v1/runs`, {
    method: "POST",
    headers: { ...headers(tenantA, commandId("a")), Prefer: "respond-async" },
    body: JSON.stringify({
      schemaVersion: "1",
      agent: { id: "durable-resume-agent", version: "1.0.0" },
      goal: "Prove one acknowledged effect survives a process crash.",
      input: { scenarioId },
      context: { roleFamily: "testing", workflowId: "durable-resume", riskClass: "medium" },
      workMode: "automate",
      autonomyMode: "delegate_review",
      decisionOwner: { mode: "requesting_principal" },
      purpose: { code: "service_delivery", registryVersion: "general@1" },
      dataClass: "internal",
      retention: { mode: "session" },
      requestedCapabilities: ["durable:write"],
      resourceScopeCeiling: [
        {
          kind: "urn",
          value: `urn:pactmark:durable-receiver:${scenarioId}`,
          normalizationVersion: "durable-fixture@1",
        },
      ],
      budget: {
        maxTurns: 4,
        maxModelCalls: 3,
        maxToolCalls: 1,
        maxActiveExecutionMs: 10_000,
        maxToolResultContextBytesPerCall: 8_192,
        maxContextSnapshotBytes: 65_536,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (startedResponse.status !== 202)
    throw new Error(
      `KAF_DURABLE_START_FAILED:${String(startedResponse.status)}:${await startedResponse.text()}`,
    );
  const started = await readJson(startedResponse);
  if (!isRecord(started) || typeof started["runId"] !== "string")
    throw new Error("KAF_DURABLE_RUN_ID_MISSING");
  const runId = started["runId"];
  await nextMessage(iteratorA, "ACK_COMMITTED");
  await stop(processA.child, "SIGKILL");

  await new Promise<void>((resolve) => setTimeout(resolve, 2_300));
  processB = startProcess("B");
  const iteratorB = processB.messages[Symbol.asyncIterator]();
  const readyB = await nextMessage(iteratorB, "READY");
  if (typeof readyB["port"] !== "number") throw new Error("KAF_DURABLE_PORT_INVALID");
  const originB = `http://127.0.0.1:${String(readyB["port"])}`;
  const resumePromise = fetch(`${originB}/v1/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    headers: headers(tenantA, commandId("b")),
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  await nextMessage(iteratorB, "PROTECTED_RESULT_LOADED");
  const resumedResponse = await resumePromise;
  if (resumedResponse.status !== 200)
    throw new Error(`KAF_DURABLE_RESUME_FAILED:${String(resumedResponse.status)}`);
  const resumed = await readJson(resumedResponse);
  if (!isRecord(resumed) || resumed["status"] !== "completed") {
    const diagnosticResponse = await fetch(
      `${originB}/v1/runs/${encodeURIComponent(runId)}/events`,
      { headers: headers(tenantA) },
    );
    const diagnosticEvents = diagnosticResponse.ok ? await readJson(diagnosticResponse) : null;
    throw new Error(
      `KAF_DURABLE_RUN_NOT_COMPLETED:${JSON.stringify({ resumed, diagnosticEvents })}`,
    );
  }

  const unauthenticated = await fetch(`${originB}/v1/runs/${encodeURIComponent(runId)}`);
  if (unauthenticated.status !== 401) throw new Error("KAF_DURABLE_AUTH_REQUIRED");
  const crossTenant = await fetch(`${originB}/v1/runs/${encodeURIComponent(runId)}`, {
    headers: headers(tenantB),
  });
  if (crossTenant.status !== 404) throw new Error("KAF_DURABLE_CROSS_TENANT_VISIBLE");

  const runResponse = await fetch(`${originB}/v1/runs/${encodeURIComponent(runId)}`, {
    headers: headers(tenantA),
  });
  if (!runResponse.ok) throw new Error("KAF_DURABLE_RUN_READ_FAILED");
  const projection = await readJson(runResponse);
  if (
    !isRecord(projection) ||
    projection["status"] !== "completed" ||
    !Array.isArray(projection["artifactIds"]) ||
    projection["artifactIds"].length !== 1 ||
    typeof projection["artifactIds"][0] !== "string"
  )
    throw new Error("KAF_DURABLE_PROJECTION_INVALID");
  const artifactId = projection["artifactIds"][0];

  const eventsResponse = await fetch(`${originB}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers(tenantA),
  });
  if (!eventsResponse.ok) throw new Error("KAF_DURABLE_EVENTS_READ_FAILED");
  const events = await readJson(eventsResponse);
  const lastEvent = isUnknownArray(events) ? events.at(-1) : undefined;
  if (
    !isUnknownArray(events) ||
    events.some((event, index) => !isRecord(event) || event["sequence"] !== index + 1) ||
    events.filter((event) => isRecord(event) && event["eventType"] === "EffectAcknowledged")
      .length !== 1 ||
    !isRecord(lastEvent) ||
    lastEvent["eventType"] !== "RunCompleted"
  )
    throw new Error("KAF_DURABLE_EVENT_ORDER_INVALID");

  const verificationResponse = await fetch(
    `${originB}/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/verification`,
    { headers: headers(tenantA) },
  );
  if (!verificationResponse.ok) throw new Error("KAF_DURABLE_ARTIFACT_NOT_VERIFIED");
  const verification = await readJson(verificationResponse);
  if (
    !isRecord(verification) ||
    verification["artifactId"] !== artifactId ||
    verification["evidence"] === null ||
    verification["evidence"] === undefined
  )
    throw new Error("KAF_DURABLE_ARTIFACT_VERIFICATION_INVALID");

  const evidenceResponse = await fetch(
    `${originB}/v1/runs/${encodeURIComponent(runId)}/evidence?format=json`,
    { headers: headers(tenantA) },
  );
  if (!evidenceResponse.ok) throw new Error("KAF_DURABLE_EVIDENCE_EXPORT_FAILED");
  const evidence = (await readJson(evidenceResponse)) as Parameters<typeof verifyEvidenceDigest>[0];
  if (!verifyEvidenceDigest(evidence) || evidence.runId !== runId)
    throw new Error("KAF_DURABLE_EVIDENCE_INVALID");

  const receiver = await database.query<{ call_count: number }>(
    "SELECT call_count FROM pactmark_test_effect_receiver WHERE scenario_id=$1",
    [scenarioId],
  );
  if (receiver.rows[0]?.call_count !== 1) throw new Error("KAF_DURABLE_EFFECT_COUNT_INVALID");
  const protectedScan = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pactmark_acknowledged_effect_results
     WHERE tenant_id=$1 AND record_json::text LIKE $2`,
    [`durable-tenant-${scenarioId}`, `%receipt-${scenarioId}%`],
  );
  if (protectedScan.rows[0]?.count !== "0")
    throw new Error("KAF_DURABLE_PROTECTED_RESULT_PLAINTEXT");

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: "1",
      gate: "durable-resume",
      postgresMajor: 17,
      processes: ["A", "B"],
      runId,
      terminalStatus: "completed",
      orderedEventCount: events.length,
      effectAcknowledgedCount: 1,
      receiverCallCount: 1,
      protectedResultReloaded: true,
      artifactVerified: true,
      evidenceDigest: evidence.evidenceDigest,
      unauthenticatedStatus: 401,
      crossTenantStatus: 404,
    })}\n`,
  );
} finally {
  if (processA !== undefined) await stop(processA.child);
  if (processB !== undefined) await stop(processB.child);
  await database.end?.();
}
