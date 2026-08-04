export {
  assertPostgresStorageSecurityProfile,
  createPostgresStorageSecurityProfile,
  POSTGRES_STORE_CAPABILITIES,
  PostgresStorageGuard,
  toPgPoolConfig,
  validatePostgresConnectionConfig,
  type PostgresConnectionConfig,
  type PostgresStorageProfileOptions,
} from "./config.js";
export {
  Aes256GcmDataProtector,
  MemoryProtectionNonceRegistry,
  PostgresProtectionNonceRegistry,
  computeProtectionAadDigest,
  type Aes256GcmDataProtectorOptions,
  type DataProtectionKey,
  type DataProtectionKeyProvider,
  type ProtectionNonceRegistry,
  type ProtectionNonceReservation,
} from "./data-protector.js";
export {
  createPostgresDatabase,
  withTransaction,
  type PostgresClient,
  type PostgresDatabase,
  type SqlResult,
} from "./database.js";
export { PostgresEventStore } from "./event-store.js";
export { PostgresEffectLedger } from "./effect-ledger.js";
export {
  PostgresRunCommandUnitOfWork,
  type PostgresRunCommandUnitOfWorkOptions,
} from "./command-unit-of-work.js";
export { PostgresRunLeaseStore, type PostgresRunLeaseStoreOptions } from "./lease-store.js";
export {
  POSTGRES_INITIAL_SCHEMA_SQL,
  POSTGRES_COMMAND_UOW_SCHEMA_SQL,
  POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL,
  POSTGRES_EFFECT_AUTHORIZATION_UOW_SCHEMA_SQL,
  POSTGRES_AUTHORITY_DECISION_AGGREGATES_SCHEMA_SQL,
  POSTGRES_RESOURCE_RESERVATIONS_SCHEMA_SQL,
  POSTGRES_WORKER_QUEUE_METADATA_SCHEMA_SQL,
  POSTGRES_EVIDENCE_RECORDS_SCHEMA_SQL,
  POSTGRES_ACKNOWLEDGED_EFFECT_RESULTS_SCHEMA_SQL,
  POSTGRES_PROTECTED_REFERENCE_DIGESTS_SCHEMA_SQL,
  POSTGRES_MIGRATIONS,
  PostgresMigrationManager,
  type PostgresMigration,
} from "./migrations.js";
export {
  PostgresEvidenceRecordStore,
  PostgresPatternRecordStore,
  PostgresVerificationRecordStore,
} from "./evidence-record-stores.js";
export { PostgresAcknowledgedEffectResultStore } from "./acknowledged-effect-results.js";
export {
  PostgresCircuitBreakerStore,
  PostgresActiveExecutionReservationStore,
  PostgresModelCallReservationStore,
  PostgresModelCallReservationServices,
  PostgresQuotaStore,
  putActiveExecutionReservation,
  putModelCallReservation,
  reserveAdmission,
} from "./resource-reservations.js";
export { PostgresProjectionRebuilder } from "./projection-rebuilder.js";
export {
  computeAcceptedWorkOrderBindingDigest,
  PostgresAcceptedWorkOrderStore,
  PostgresArtifactStore,
  PostgresContextStore,
  PostgresInputSubmissionStore,
  type ProtectedStoreDeletion,
  type PostgresRecordStoreOptions,
} from "./record-stores.js";

import {
  KafError,
  type DataProtector,
  type QuotaLimit,
  type StorageSecurityProfile,
} from "@pactmark/core";

import {
  assertPostgresStorageSecurityProfile,
  createPostgresStorageSecurityProfile,
  toPgPoolConfig,
  type PostgresConnectionConfig,
  type PostgresStorageProfileOptions,
} from "./config.js";
import { createPostgresDatabase, type PostgresDatabase } from "./database.js";
import { PostgresEventStore } from "./event-store.js";
import { PostgresEffectLedger } from "./effect-ledger.js";
import { PostgresRunCommandUnitOfWork } from "./command-unit-of-work.js";
import { PostgresRunLeaseStore, type PostgresRunLeaseStoreOptions } from "./lease-store.js";
import { PostgresMigrationManager } from "./migrations.js";
import { PostgresProjectionRebuilder } from "./projection-rebuilder.js";
import {
  PostgresCircuitBreakerStore,
  PostgresActiveExecutionReservationStore,
  PostgresModelCallReservationServices,
  PostgresModelCallReservationStore,
  PostgresQuotaStore,
} from "./resource-reservations.js";
import {
  PostgresAcceptedWorkOrderStore,
  PostgresArtifactStore,
  PostgresContextStore,
  PostgresInputSubmissionStore,
  type ProtectedStoreDeletion,
} from "./record-stores.js";
import {
  PostgresEvidenceRecordStore,
  PostgresPatternRecordStore,
  PostgresVerificationRecordStore,
} from "./evidence-record-stores.js";
import { PostgresAcknowledgedEffectResultStore } from "./acknowledged-effect-results.js";

export interface PostgresStoreSuiteOptions extends PostgresStorageProfileOptions {
  readonly securityProfile?: StorageSecurityProfile;
  readonly dataProtector?: DataProtector;
  readonly maxInlineArtifactBytes?: number;
  readonly generateLeaseId?: PostgresRunLeaseStoreOptions["generateLeaseId"];
  readonly now?: () => string;
  readonly generateWakeupId?: (requestDigest: string) => string;
  readonly onDelete?: (record: ProtectedStoreDeletion) => void | Promise<void>;
  readonly quotaLimits?: readonly QuotaLimit[];
}

export function createPostgresStoreSuite(
  database: PostgresDatabase,
  options: PostgresStoreSuiteOptions = {},
) {
  if (options.dataProtector === undefined) {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "data_protector_required_for_postgres_suite" },
    });
  }
  const securityProfile = options.securityProfile ?? createPostgresStorageSecurityProfile(options);
  const recordOptions = {
    dataProtector: options.dataProtector,
    ...(options.maxInlineArtifactBytes === undefined
      ? {}
      : { maxInlineArtifactBytes: options.maxInlineArtifactBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onDelete === undefined ? {} : { onDelete: options.onDelete }),
  };
  const leaseStore = new PostgresRunLeaseStore(database, {
    securityProfile,
    ...(options.generateLeaseId === undefined ? {} : { generateLeaseId: options.generateLeaseId }),
  });
  const eventStore = new PostgresEventStore(database, securityProfile, leaseStore);
  const acknowledgedEffectResultStore = new PostgresAcknowledgedEffectResultStore(
    database,
    securityProfile,
    options.dataProtector,
  );
  return Object.freeze({
    database,
    securityProfile,
    migrationManager: new PostgresMigrationManager(database),
    acceptedWorkOrderStore: new PostgresAcceptedWorkOrderStore(
      database,
      securityProfile,
      recordOptions,
    ),
    inputSubmissionStore: new PostgresInputSubmissionStore(
      database,
      securityProfile,
      recordOptions,
    ),
    eventStore,
    effectLedger: new PostgresEffectLedger(
      database,
      securityProfile,
      acknowledgedEffectResultStore,
    ),
    acknowledgedEffectResultStore,
    quotaStore: new PostgresQuotaStore(database, options.quotaLimits ?? []),
    circuitBreakerStore: new PostgresCircuitBreakerStore(database),
    activeExecutionReservationStore: new PostgresActiveExecutionReservationStore(database),
    modelCallReservationStore: new PostgresModelCallReservationStore(database),
    modelCallReservationServices:
      options.now === undefined
        ? new PostgresModelCallReservationServices()
        : new PostgresModelCallReservationServices(options.now),
    projectionRebuilder: new PostgresProjectionRebuilder(eventStore),
    contextStore: new PostgresContextStore(database, securityProfile, recordOptions),
    artifactStore: new PostgresArtifactStore(database, securityProfile, recordOptions),
    evidenceRecordStore: new PostgresEvidenceRecordStore(database, securityProfile),
    verificationRecordStore: new PostgresVerificationRecordStore(database, securityProfile),
    patternRecordStore: new PostgresPatternRecordStore(database, securityProfile),
    leaseStore,
    runCommandUnitOfWork: new PostgresRunCommandUnitOfWork(database, {
      securityProfile,
      dataProtector: options.dataProtector,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.generateWakeupId === undefined
        ? {}
        : { generateWakeupId: options.generateWakeupId }),
      ...(options.quotaLimits === undefined ? {} : { quotaLimits: options.quotaLimits }),
    }),
  });
}

export function createPostgresStoreSuiteFromConfig(
  connection: PostgresConnectionConfig,
  options: PostgresStoreSuiteOptions = {},
) {
  if (options.dataProtector === undefined) {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "data_protector_required_for_postgres_suite" },
    });
  }
  const poolConfig = toPgPoolConfig(connection);
  const transportMode = connection.ssl.mode === "disable" ? "development-plaintext" : "verify-full";
  const securityProfile =
    options.securityProfile ?? createPostgresStorageSecurityProfile({ ...options, transportMode });
  assertPostgresStorageSecurityProfile(securityProfile, { transportMode });
  const database = createPostgresDatabase(poolConfig);
  return createPostgresStoreSuite(database, { ...options, securityProfile, transportMode });
}
