import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPostgresDatabase,
  createPostgresStorageSecurityProfile,
  PostgresEventStore,
  PostgresMigrationManager,
  toPgPoolConfig,
  validatePostgresConnectionConfig,
  type PostgresConnectionConfig,
} from "../src/index.js";
import { runAccepted } from "../tests/fixtures.js";
import { assertNoCanary, PostgresTlsHarness, RealTlsToolRunner } from "./harness.js";

describe("real PostgreSQL 17 verify-full TLS gate", () => {
  it("accepts only the trusted CA and exact hostname without leaking certificate canaries", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const canary = `PACTMARK_TLS_CA_CANARY_${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "pactmark-postgres-tls-"));
    const containerName = `pactmark-postgres-tls-${suffix.slice(0, 20)}`;
    const password = `tls-${suffix}`;
    const runner = new RealTlsToolRunner();
    const harness = new PostgresTlsHarness(runner, {
      certificateDirectory: directory,
      containerName,
      canary,
      databasePassword: password,
    });
    const observations: string[] = [];
    const originalDnsOrder = getDefaultResultOrder();
    let containerRequested = false;
    try {
      setDefaultResultOrder("ipv4first");
      await harness.assertPrerequisites();
      const certificates = await harness.generateCertificates();
      containerRequested = true;
      const port = await harness.start();
      const ca = await readFile(certificates.ca, "utf8");
      const untrustedCa = await readFile(certificates.untrustedCa, "utf8");
      const exact = productionConfig("localhost", port, password, ca);
      const exactResult = await querySsl(exact);
      observations.push(JSON.stringify(exactResult));
      expect(exactResult.ssl).toBe("on");
      expect(exactResult.transportSsl).toBe(true);
      observations.push(await persistAndReadSafeEvent(exact, suffix));

      await expectRejectedHandshake(
        productionConfig("127.0.0.1", port, password, ca),
        observations,
        /hostname\/ip does not match|not in the cert/iu,
      );
      await expectRejectedHandshake(
        productionConfig("localhost", port, password, untrustedCa),
        observations,
        /self-signed|unable to verify|certificate/iu,
      );
      await expectRejectedHandshake(
        productionConfig("localhost", port, password),
        observations,
        /self-signed|unable to verify|certificate/iu,
      );

      for (const unsafe of unsafeProductionConfigs(port, password, ca)) {
        expect(() => {
          validatePostgresConnectionConfig(unsafe);
        }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
      }

      await runner.run("docker", ["logs", containerName]);

      for (const output of runner.outputs) {
        assertNoCanary(output.stdout, canary, "process-stdout");
        assertNoCanary(output.stderr, canary, "process-stderr");
      }
      assertNoCanary(observations.join("\n"), canary, "query-and-error-observations");
      await assertPackageArtifactsDoNotContain(canary);
    } finally {
      setDefaultResultOrder(originalDnsOrder);
      try {
        if (containerRequested) await harness.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

function productionConfig(
  hostname: string,
  port: number,
  password: string,
  ca?: string,
): PostgresConnectionConfig {
  return {
    profile: "production",
    connectionString: `postgresql://postgres:${password}@${hostname}:${String(port)}/pactmark_tls`,
    ssl: { mode: "verify-full", ...(ca === undefined ? {} : { ca }) },
    maxConnections: 1,
    applicationName: "pactmark-postgres-tls-gate",
  };
}

async function persistAndReadSafeEvent(
  config: PostgresConnectionConfig,
  suffix: string,
): Promise<string> {
  const database = createPostgresDatabase(toPgPoolConfig(config));
  try {
    await new PostgresMigrationManager(database).migrate();
    const event = runAccepted({
      tenantId: `tenant-tls-${suffix}`,
      runId: `run-tls-${suffix}`,
      eventId: `event-tls-${suffix}`,
      correlationId: `correlation-tls-${suffix}`,
    });
    const store = new PostgresEventStore(
      database,
      createPostgresStorageSecurityProfile({
        transportMode: "verify-full",
        allowedTenants: [event.tenantId],
        allowedPurposes: ["support"],
      }),
    );
    await store.append(event, 0);
    const stored = await database.query<{ event: string }>(
      `SELECT event_json::text AS event FROM pactmark_run_events
       WHERE tenant_id=$1 AND run_id=$2 AND sequence=1`,
      [event.tenantId, event.runId],
    );
    const row = stored.rows[0];
    if (row === undefined) throw new Error("TLS_POSTGRES_EVENT_NOT_FOUND");
    return row.event;
  } finally {
    await database.end?.();
  }
}

async function querySsl(
  config: PostgresConnectionConfig,
): Promise<{ ssl: string; transportSsl: boolean }> {
  const database = createPostgresDatabase(toPgPoolConfig(config));
  try {
    const result = await database.query<{ ssl: string; transportSsl: boolean }>(
      `SELECT current_setting('ssl') AS ssl, ssl AS "transportSsl"
       FROM pg_stat_ssl WHERE pid=pg_backend_pid()`,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("TLS_POSTGRES_QUERY_RETURNED_NO_ROW");
    return row;
  } finally {
    await database.end?.();
  }
}

async function expectRejectedHandshake(
  config: PostgresConnectionConfig,
  observations: string[],
  expected: RegExp,
): Promise<void> {
  try {
    await querySsl(config);
    throw new Error("TLS_UNVERIFIED_CONNECTION_WAS_ACCEPTED");
  } catch (error) {
    if (error instanceof Error && error.message === "TLS_UNVERIFIED_CONNECTION_WAS_ACCEPTED") {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    observations.push(message);
    expect(message).toMatch(expected);
  }
}

function unsafeProductionConfigs(port: number, password: string, ca: string): unknown[] {
  const connectionString = `postgresql://postgres:${password}@localhost:${String(port)}/pactmark_tls`;
  return [
    { profile: "production", connectionString, ssl: { mode: "disable" } },
    { profile: "production", connectionString, ssl: { mode: "require" } },
    { profile: "production", connectionString, ssl: { mode: "verify-ca", ca } },
    {
      profile: "production",
      connectionString,
      ssl: { mode: "verify-full", ca, rejectUnauthorized: false },
    },
  ];
}

async function assertPackageArtifactsDoNotContain(canary: string): Promise<void> {
  const packageRoot = resolve(import.meta.dirname, "..");
  for (const path of [
    join(packageRoot, "dist"),
    join(packageRoot, "migrations"),
    join(packageRoot, "README.md"),
    join(packageRoot, "package.json"),
  ]) {
    await scanPath(path, canary, packageRoot);
  }
}

async function scanPath(path: string, canary: string, packageRoot: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (entries !== undefined) {
    for (const entry of entries) {
      await scanPath(join(path, entry.name), canary, packageRoot);
    }
    return;
  }
  const content = await readFile(path);
  assertNoCanary(content.toString("utf8"), canary, path.slice(packageRoot.length + 1));
}
