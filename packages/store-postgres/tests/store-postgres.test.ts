import {
  digestBytes,
  digestCanonicalJson,
  type AcceptedAgentWorkOrder,
  type DataProtector,
  type ProtectedValueRef,
} from "@pactmark/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assertPostgresStorageSecurityProfile,
  createPostgresStorageSecurityProfile,
  PostgresStorageGuard,
  toPgPoolConfig,
  validatePostgresConnectionConfig,
} from "../src/config.js";
import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import {
  POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL,
  POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL,
  POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL,
  POSTGRES_INITIAL_SCHEMA_SQL,
  POSTGRES_MIGRATIONS,
  POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL,
  POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL,
  POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL,
} from "../src/migrations.js";
import {
  computeAcceptedWorkOrderBindingDigest,
  PostgresAcceptedWorkOrderStore,
} from "../src/record-stores.js";
import { createPostgresStoreSuite, createPostgresStoreSuiteFromConfig } from "../src/index.js";

const instant = "2026-08-03T10:00:00.000Z";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));
const executionDefinition = {
  kind: "agent" as const,
  id: "support-agent",
  version: "1.0.0",
  agentDefinitionDigest: digest("agent-definition"),
};

describe("PostgreSQL connection security", () => {
  it("constructs hostname-verifying TLS and does not permit a driver override", () => {
    const config = toPgPoolConfig({
      profile: "production",
      connectionString: "postgresql://app:secret@db.example.test/pactmark",
      ssl: { mode: "verify-full", ca: "test-ca" },
      maxConnections: 7,
      applicationName: "worker",
    });
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: "db.example.test",
      ca: "test-ca",
    });
    expect(config.max).toBe(7);
    expect(config.application_name).toBe("worker");
    expect(() => {
      validatePostgresConnectionConfig({
        profile: "production",
        connectionString: "postgresql://db.example.test/pactmark?SSLMode=require",
        ssl: { mode: "verify-full" },
      });
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
    expect(() => {
      validatePostgresConnectionConfig({
        profile: "production",
        connectionString: "postgresql://db.example.test/pactmark",
        ssl: { mode: "verify-full", rejectUnauthorized: false },
      });
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
  });

  it("fails closed for production plaintext and non-loopback development plaintext", () => {
    expect(() => {
      validatePostgresConnectionConfig({
        profile: "production",
        connectionString: "postgresql://db.example.test/pactmark",
        ssl: { mode: "disable" },
      });
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
    expect(() => {
      validatePostgresConnectionConfig({
        profile: "development",
        connectionString: "postgresql://db.example.test/pactmark",
        ssl: { mode: "disable" },
      });
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
    expect(() => {
      validatePostgresConnectionConfig({
        profile: "development",
        connectionString: "postgresql://localhost/pactmark",
        ssl: { mode: "disable" },
      });
    }).not.toThrow();
  });

  it("binds transport configuration to an honest compatible storage profile", async () => {
    const configured = createPostgresStoreSuiteFromConfig(
      {
        profile: "development",
        connectionString: "postgresql://localhost/pactmark",
        ssl: { mode: "disable" },
      },
      { dataProtector: new TestProtector() },
    );
    expect(configured.securityProfile).toMatchObject({
      transportSecurity: "memory",
      encryptionMode: "application_protected",
      retentionSupport: true,
      deletionSupport: true,
    });
    await configured.database.end?.();
    expect(() => {
      createPostgresStoreSuiteFromConfig(
        {
          profile: "development",
          connectionString: "postgresql://localhost/pactmark",
          ssl: { mode: "disable" },
        },
        {
          securityProfile: createPostgresStorageSecurityProfile(),
          dataProtector: new TestProtector(),
        },
      );
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
    expect(() => {
      assertPostgresStorageSecurityProfile({
        ...createPostgresStorageSecurityProfile(),
        storageSecurityProfileDigest: digest("forged-profile"),
      });
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
  });
});

describe("tenant and immutable record boundaries", () => {
  it("rejects disallowed tenants and highly restricted writes before SQL", () => {
    const guard = new PostgresStorageGuard(
      createPostgresStorageSecurityProfile({ allowedTenants: ["tenant-a"] }),
    );
    expect(() => {
      guard.assertWriteAllowed("tenant-b", "support", "internal");
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
    expect(() => {
      guard.assertWriteAllowed("tenant-a", "support", "highly_restricted");
    }).toThrow(expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }));
  });

  it("uses tenant plus WorkOrder ID and treats exact replay as idempotent", async () => {
    const database = new WorkOrderDatabase();
    const protector = new TestProtector();
    const store = new PostgresAcceptedWorkOrderStore(
      database,
      createPostgresStorageSecurityProfile(),
      { dataProtector: protector },
    );
    const accepted = workOrder();
    await store.putImmutable(accepted);
    await store.putImmutable(accepted);
    await expect(store.get("tenant-a", accepted.id)).resolves.toEqual(accepted);
    await expect(store.get("tenant-b", accepted.id)).resolves.toBeUndefined();
    expect(database.queries.every(({ values }) => values?.[0] !== undefined)).toBe(true);
    expect(database.queries.some(({ values }) => values?.[0] === "tenant-b")).toBe(true);
  });

  it("requires a protector before writing any durable WorkOrder", async () => {
    const database = new WorkOrderDatabase();
    const store = new PostgresAcceptedWorkOrderStore(
      database,
      createPostgresStorageSecurityProfile({
        allowedDataClasses: ["internal", "confidential"],
      }),
    );
    await expect(store.putImmutable(workOrder())).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
    expect(database.queries.some(({ text }) => text.includes("INSERT INTO"))).toBe(false);
  });
});

describe("migration constraints", () => {
  it("defines append-only events, tenant composite keys, fencing, and protected-reference uniqueness", () => {
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("PRIMARY KEY (tenant_id, run_id, sequence)");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("UNIQUE (event_id)");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("pactmark_run_events_immutable");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("PRIMARY KEY (tenant_id, run_id)");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("fencing_token");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("pactmark_context_protected_ref_unique");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("pactmark_input_protected_ref_unique");
    expect(POSTGRES_INITIAL_SCHEMA_SQL).toContain("UNIQUE (tenant_id,operation_key)");
  });

  it("adds durable runtime authorization/effect fields without rewriting the initial schema", () => {
    expect(POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL).toContain("reservation_json jsonb");
    expect(POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL).toContain(
      "CHECK (state IN ('reserved','consumed','expired','revoked'))",
    );
    expect(POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL).toContain("pactmark_effect_key_unique");
    expect(POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL).toContain(
      "ALTER COLUMN operation_key DROP NOT NULL",
    );
    expect(POSTGRES_MIGRATIONS).toContainEqual(
      expect.objectContaining({ version: "004", reversibleSafe: false }),
    );
    expect(POSTGRES_MIGRATIONS).toContainEqual(
      expect.objectContaining({ version: "007", reversibleSafe: false }),
    );
    expect(POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL).toContain(
      "PACTMARK_MIGRATION_006_INCOMPATIBLE_POPULATED_SKELETON_TABLES",
    );
    expect(POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL.indexOf("IF EXISTS")).toBeLessThan(
      POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL.indexOf("DROP TABLE"),
    );
    expect(POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL).toContain(
      "PACTMARK_MIGRATION_007_INCOMPATIBLE_UNBOUND_WAKEUPS",
    );
    expect(POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL).not.toMatch(/goal|challenge_proof/iu);
  });

  it("adds tenant-scoped append-only evidence record tables in migration 008", () => {
    expect(POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL).toContain(
      "PRIMARY KEY (tenant_id,evidence_record_id)",
    );
    expect(POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL).toContain(
      "PRIMARY KEY (tenant_id,run_id,verification_id)",
    );
    expect(POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL).toContain(
      "PRIMARY KEY (tenant_id,pattern_id,pattern_version)",
    );
    expect(POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL.match(/BEFORE UPDATE OR DELETE/gu)).toHaveLength(3);
    expect(
      readFileSync(
        new URL("../migrations/008_evidence_records.sql", import.meta.url),
        "utf8",
      ).trim(),
    ).toBe(POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL.trim());
    expect(POSTGRES_MIGRATIONS.at(-3)).toMatchObject({ version: "008", reversibleSafe: false });
  });

  it("adds protected immutable acknowledged effect results in migration 009", () => {
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "PRIMARY KEY (tenant_id,run_id,effect_id)",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "UNIQUE (tenant_id,effect_digest)",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "UNIQUE (tenant_id,protected_key_id,protected_ref)",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "byte_size bigint NOT NULL CHECK (byte_size >= 0)",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "REFERENCES pactmark_run_work_orders(tenant_id,run_id,work_order_id)",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain(
      "DEFERRABLE INITIALLY DEFERRED",
    );
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).toContain("BEFORE UPDATE OR DELETE");
    expect(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL).not.toMatch(
      /(?:plaintext|result_json|result_value|payload_json)/iu,
    );
    expect(
      readFileSync(
        new URL("../migrations/009_acknowledged_effect_results.sql", import.meta.url),
        "utf8",
      ).trim(),
    ).toBe(POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL.trim());
    expect(POSTGRES_MIGRATIONS.at(-2)).toMatchObject({ version: "009", reversibleSafe: false });
  });

  it("replaces unbounded protected refs with tenant-scoped ciphertext digest indexes", () => {
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL).toContain(
      "(protected_ref_json->>'ciphertextDigest')",
    );
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL).toContain(
      "(record_json#>>'{protectedValue,ciphertextDigest}')",
    );
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL).toContain(
      "(snapshot_json#>>'{protectedValue,ciphertextDigest}')",
    );
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL).toContain(
      "pactmark_acknowledged_effect_results_protected_ref_unique",
    );
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL).toContain(
      "max_active_execution_ms bigint",
    );
    expect(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL.match(/tenant_id,/gu)).toHaveLength(5);
    expect(
      readFileSync(
        new URL("../migrations/010_protected_reference_digests.sql", import.meta.url),
        "utf8",
      ).trim(),
    ).toBe(POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL.trim());
    expect(POSTGRES_MIGRATIONS.at(-1)).toMatchObject({ version: "010", reversibleSafe: false });
  });
});

describe("store suite", () => {
  it("refuses to advertise a protected suite without an injected protector", () => {
    expect(() => createPostgresStoreSuite(new WorkOrderDatabase())).toThrow(
      expect.objectContaining({ code: "KAF_STORAGE_SECURITY_PROFILE" }),
    );
  });

  it("wires one security profile and lease store across the Postgres adapters", async () => {
    const database = new WorkOrderDatabase();
    const suite = createPostgresStoreSuite(database, {
      dataProtector: new TestProtector(),
      generateLeaseId: () => "lease-suite",
      maxInlineArtifactBytes: 32,
    });
    expect(suite.database).toBe(database);
    expect(suite.eventStore.leaseStore).toBe(suite.leaseStore);
    expect(suite.acceptedWorkOrderStore.securityProfile).toBe(suite.securityProfile);
    expect(suite.leaseStore.securityProfile).toBe(suite.securityProfile);

    const configured = createPostgresStoreSuiteFromConfig(
      {
        profile: "development",
        connectionString: "postgresql://localhost/pactmark",
        ssl: { mode: "disable" },
      },
      { dataProtector: new TestProtector() },
    );
    await configured.database.end?.();
  });
});

function workOrder(overrides: Partial<AcceptedAgentWorkOrder> = {}): AcceptedAgentWorkOrder {
  const provisional: AcceptedAgentWorkOrder = {
    schemaVersion: "1",
    kind: "agent",
    id: "work-order-1",
    createdAt: instant,
    goal: "Produce a deterministic answer",
    input: { caseId: "case-1" },
    context: { roleFamily: "support", workflowId: "triage", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "co_produce",
    decisionOwner: { mode: "principal", principal: { type: "user", id: "user-1" } },
    purpose: { code: "support", registryVersion: "1" },
    dataClass: "internal",
    retention: { mode: "session" },
    principal: { type: "user", id: "user-1" },
    tenant: { id: "tenant-a" },
    requestedCapabilities: ["artifact:write"],
    resourceScopeCeiling: [],
    budget: { maxTurns: 3, maxModelCalls: 2, maxToolCalls: 2, maxActiveExecutionMs: 5_000 },
    executionDefinition,
    executionDefinitionDigest: digestCanonicalJson(executionDefinition),
    modelSecurityProfileDigest: digest("model-security"),
    modelResourceProfileDigest: digest("model-resource"),
    modelAdapterRegistrationDigest: digest("model-adapter"),
    workOrderBindingDigest: digest("provisional"),
    ...overrides,
  };
  return {
    ...provisional,
    workOrderBindingDigest: computeAcceptedWorkOrderBindingDigest(provisional),
  };
}

class WorkOrderDatabase implements PostgresDatabase {
  readonly queries: { text: string; values?: readonly unknown[] }[] = [];
  readonly #rows = new Map<
    string,
    {
      canonical_digest: string;
      protected_ref_json: unknown;
      work_order_kind: string;
      work_order_binding_digest: string;
      execution_definition_digest: string;
      purpose_code: string;
      purpose_registry_version: string;
      data_class: string;
    }
  >();

  async query<Row>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    await Promise.resolve();
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    if (text.includes("INSERT INTO pactmark_work_orders")) {
      const key = `${String(values?.[0])}\u0000${String(values?.[1])}`;
      if (this.#rows.has(key)) return { rows: [], rowCount: 0 };
      this.#rows.set(key, {
        canonical_digest: String(values?.[9]),
        protected_ref_json: JSON.parse(String(values?.[13])),
        work_order_kind: String(values?.[2]),
        work_order_binding_digest: String(values?.[3]),
        execution_definition_digest: String(values?.[5]),
        purpose_code: String(values?.[11]),
        purpose_registry_version: String(values?.[27]),
        data_class: String(values?.[10]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM pactmark_work_orders")) {
      const key = `${String(values?.[0])}\u0000${String(values?.[1])}`;
      const row = this.#rows.get(key);
      return {
        rows: (row === undefined ? [] : [row]) as Row[],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  connect(): Promise<PostgresClient> {
    throw new Error("not used by this test");
  }
}

class TestProtector implements DataProtector {
  readonly #values = new Map<string, Uint8Array>();
  #sequence = 0;

  async protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef> {
    await Promise.resolve();
    const id = `ciphertext-${String(++this.#sequence)}`;
    this.#values.set(id, new Uint8Array(plaintext));
    return {
      schemaVersion: "1",
      protectorId: "test",
      keyId: "test-key",
      ciphertextRef: id,
      ciphertextDigest: digest(id),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    };
  }

  async unprotect(
    _binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    const value = this.#values.get(reference.ciphertextRef);
    if (value === undefined) throw new Error("missing test ciphertext");
    return new Uint8Array(value);
  }
}
