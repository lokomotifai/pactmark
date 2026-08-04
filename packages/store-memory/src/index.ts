export {
  createMemoryStorageSecurityProfile,
  MEMORY_STORE_CAPABILITIES,
  MemoryStorageGuard,
  type MemoryStorageProfileOptions,
} from "./config.js";
export { MemoryEventStore } from "./event-store.js";
export { MemoryDecisionStore } from "./decision-store.js";
export { MemoryEffectLedger } from "./effect-ledger.js";
export { MemoryCapabilityGrantStore, MemoryWakeupQueue } from "./authority-stores.js";
export {
  MemoryActiveExecutionReservationStore,
  MemoryCircuitBreakerStore,
  MemoryModelCallReservationStore,
  MemoryModelCallReservationServices,
  MemoryQuotaStore,
} from "./resource-reservations.js";
export {
  MemoryRunCommandUnitOfWork,
  type MemoryRunCommandUnitOfWorkOptions,
} from "./command-unit-of-work.js";
export { MemoryRunLeaseStore, type MemoryRunLeaseStoreOptions } from "./lease-store.js";
export {
  computeAcceptedWorkOrderBindingDigest,
  MemoryAcceptedWorkOrderStore,
  MemoryArtifactStore,
  MemoryContextStore,
  MemoryInputSubmissionStore,
} from "./record-stores.js";
export {
  MemoryEvidenceRecordStore,
  MemoryPatternRecordStore,
  MemoryVerificationRecordStore,
} from "./evidence-record-stores.js";
export {
  MemoryAcknowledgedEffectResultStore,
  type MemoryAcknowledgedEffectResultSnapshot,
} from "./acknowledged-effect-results.js";

import type { DataProtector, QuotaLimit, StorageSecurityProfile } from "@pactmark/core";

import { MemoryRunCommandUnitOfWork } from "./command-unit-of-work.js";
import { createMemoryStorageSecurityProfile, type MemoryStorageProfileOptions } from "./config.js";
import { MemoryEventStore } from "./event-store.js";
import { MemoryDecisionStore } from "./decision-store.js";
import { MemoryEffectLedger } from "./effect-ledger.js";
import { MemoryCapabilityGrantStore, MemoryWakeupQueue } from "./authority-stores.js";
import { MemoryRunLeaseStore, type MemoryRunLeaseStoreOptions } from "./lease-store.js";
import {
  MemoryActiveExecutionReservationStore,
  MemoryCircuitBreakerStore,
  MemoryModelCallReservationStore,
  MemoryModelCallReservationServices,
  MemoryQuotaStore,
} from "./resource-reservations.js";
import {
  MemoryAcceptedWorkOrderStore,
  MemoryArtifactStore,
  MemoryContextStore,
  MemoryInputSubmissionStore,
} from "./record-stores.js";
import {
  MemoryEvidenceRecordStore,
  MemoryPatternRecordStore,
  MemoryVerificationRecordStore,
} from "./evidence-record-stores.js";
import { MemoryAcknowledgedEffectResultStore } from "./acknowledged-effect-results.js";

export interface MemoryStoreSuiteOptions extends MemoryStorageProfileOptions {
  readonly securityProfile?: StorageSecurityProfile;
  readonly dataProtector?: DataProtector;
  readonly now?: () => string;
  readonly maxInlineArtifactBytes?: number;
  readonly generateLeaseId?: MemoryRunLeaseStoreOptions["generateLeaseId"];
  readonly quotaLimits?: readonly QuotaLimit[];
}

export function createMemoryStoreSuite(options: MemoryStoreSuiteOptions = {}) {
  const securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
  const common = {
    securityProfile,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const protectedOptions = {
    ...common,
    ...(options.dataProtector === undefined ? {} : { dataProtector: options.dataProtector }),
  };
  const leaseStore = new MemoryRunLeaseStore({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.generateLeaseId === undefined ? {} : { generateLeaseId: options.generateLeaseId }),
  });
  const eventStore = new MemoryEventStore({ leaseStore, securityProfile });
  const acceptedWorkOrderStore = new MemoryAcceptedWorkOrderStore(protectedOptions);
  const inputSubmissionStore = new MemoryInputSubmissionStore(common);
  const contextStore = new MemoryContextStore(common);
  const decisionStore = new MemoryDecisionStore();
  const acknowledgedEffectResultStore = new MemoryAcknowledgedEffectResultStore(
    securityProfile,
    options.dataProtector,
  );
  const effectLedger = new MemoryEffectLedger(acknowledgedEffectResultStore);
  const capabilityGrantStore = new MemoryCapabilityGrantStore();
  const wakeupQueue = new MemoryWakeupQueue(options.now);
  const quotaStore = new MemoryQuotaStore({
    ...(options.quotaLimits === undefined ? {} : { limits: options.quotaLimits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const activeExecutionReservationStore =
    options.now === undefined
      ? new MemoryActiveExecutionReservationStore()
      : new MemoryActiveExecutionReservationStore(options.now);
  const modelCallReservationStore = new MemoryModelCallReservationStore(options.quotaLimits);
  const modelCallReservationServices =
    options.now === undefined
      ? new MemoryModelCallReservationServices()
      : new MemoryModelCallReservationServices(options.now);
  const circuitBreakerStore = new MemoryCircuitBreakerStore();

  return Object.freeze({
    securityProfile,
    acceptedWorkOrderStore,
    inputSubmissionStore,
    decisionStore,
    effectLedger,
    capabilityGrantStore,
    wakeupQueue,
    quotaStore,
    activeExecutionReservationStore,
    modelCallReservationStore,
    modelCallReservationServices,
    circuitBreakerStore,
    eventStore,
    contextStore,
    acknowledgedEffectResultStore,
    evidenceRecordStore: new MemoryEvidenceRecordStore(securityProfile),
    verificationRecordStore: new MemoryVerificationRecordStore(securityProfile),
    patternRecordStore: new MemoryPatternRecordStore(securityProfile),
    artifactStore: new MemoryArtifactStore({
      ...protectedOptions,
      ...(options.maxInlineArtifactBytes === undefined
        ? {}
        : { maxInlineBytes: options.maxInlineArtifactBytes }),
    }),
    leaseStore,
    runCommandUnitOfWork: new MemoryRunCommandUnitOfWork({
      acceptedWorkOrderStore,
      eventStore,
      inputSubmissionStore,
      contextStore,
      decisionStore,
      effectLedger,
      capabilityGrantStore,
      wakeupQueue,
      quotaStore,
      activeExecutionReservationStore,
      modelCallReservationStore,
      acknowledgedEffectResultStore,
    }),
  });
}
