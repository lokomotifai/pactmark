import type {
  AcceptedWorkOrderStore,
  ArtifactStore,
  ContextStore,
  EventStore,
  InputSubmissionStore,
  RunLeaseStore,
  RuntimeCapabilities,
} from "@pactmark/core";
import { RuntimeCapabilitiesSchema } from "@pactmark/core";

import {
  createContractArtifact,
  createContractContextSnapshot,
  createContractInputSubmission,
  createContractPlanningEvent,
  createContractRunAcceptedEvent,
  createContractWorkOrder,
  contractDigest,
} from "./fixtures.js";
import { ContractRecorder, sameValue, type ContractReport } from "./report.js";

export interface StoreContractFactories {
  readonly createAcceptedWorkOrderStore: () => AcceptedWorkOrderStore;
  readonly createInputSubmissionStore: () => InputSubmissionStore;
  readonly createEventStore: () => EventStore;
  readonly createContextStore: () => ContextStore;
  readonly createArtifactStore: () => ArtifactStore;
  readonly createRunLeaseHarness: () => RunLeaseContractHarness;
}

export interface RunLeaseContractHarness {
  readonly store: RunLeaseStore;
  advance(milliseconds: number): void;
}

export async function runAcceptedWorkOrderStoreContract(
  createStore: () => AcceptedWorkOrderStore,
): Promise<ContractReport> {
  const contract = new ContractRecorder("AcceptedWorkOrderStore");
  const store = createStore();
  assertCapabilities(contract, store.capabilities);
  const workOrder = createContractWorkOrder();
  await store.putImmutable(workOrder);
  await store.putImmutable(structuredClone(workOrder));
  contract.assert(
    sameValue(await store.get("contract-tenant", workOrder.id), workOrder),
    "immutable-round-trip",
  );
  const firstRead = await store.get("contract-tenant", workOrder.id);
  const secondRead = await store.get("contract-tenant", workOrder.id);
  contract.assert(
    firstRead !== undefined && secondRead !== undefined && firstRead !== secondRead,
    "defensive-record-copy",
  );
  contract.assert(
    (await store.get("other-tenant", workOrder.id)) === undefined,
    "tenant-isolation",
  );
  await contract.rejects(
    () => store.putImmutable(createContractWorkOrder({ goal: "Changed immutable goal" })),
    "same-id-mutation-rejected",
  );
  await store.delete("contract-tenant", workOrder.id);
  contract.assert(
    (await store.get("contract-tenant", workOrder.id)) === undefined,
    "explicit-deletion",
  );
  return contract.report();
}

export async function runInputSubmissionStoreContract(
  createStore: () => InputSubmissionStore,
): Promise<ContractReport> {
  const contract = new ContractRecorder("InputSubmissionStore");
  const store = createStore();
  assertCapabilities(contract, store.capabilities);
  const record = createContractInputSubmission();
  contract.assert(sameValue(await store.putOnce(record), record), "put-once");
  contract.assert(sameValue(await store.putOnce(structuredClone(record)), record), "same-replay");
  contract.assert(
    sameValue(await store.get("contract-tenant", "contract-run", "contract-request"), record),
    "tenant-scoped-round-trip",
  );
  const firstRead = await store.get("contract-tenant", "contract-run", "contract-request");
  const secondRead = await store.get("contract-tenant", "contract-run", "contract-request");
  contract.assert(
    firstRead !== undefined && secondRead !== undefined && firstRead !== secondRead,
    "defensive-record-copy",
  );
  contract.assert(
    (await store.get("other-tenant", "contract-run", "contract-request")) === undefined,
    "tenant-isolation",
  );
  await contract.rejects(
    () =>
      store.putOnce(
        createContractInputSubmission({ valueDigest: contractDigest("different-value") }),
      ),
    "changed-value-replay-rejected",
  );
  await store.delete("contract-tenant", "contract-run", "contract-request");
  contract.assert(
    (await store.get("contract-tenant", "contract-run", "contract-request")) === undefined,
    "explicit-deletion",
  );
  return contract.report();
}

export async function runEventStoreContract(
  createStore: () => EventStore,
): Promise<ContractReport> {
  const contract = new ContractRecorder("EventStore");
  const store = createStore();
  assertCapabilities(contract, store.capabilities);
  const accepted = createContractRunAcceptedEvent();
  contract.assert(
    sameValue(await store.append(accepted, 0), { sequence: 1, replayed: false }),
    "first-append",
  );
  contract.assert(
    sameValue(await store.append(structuredClone(accepted), 0), {
      sequence: 1,
      replayed: true,
    }),
    "event-id-idempotency",
  );
  await contract.rejects(
    () => store.append(createContractRunAcceptedEvent({ tenantId: "other-tenant" }), 0),
    "event-id-conflict-rejected",
  );

  const firstWriter = createContractPlanningEvent();
  const secondWriter = createContractPlanningEvent({
    eventId: "contract-event-competing",
    payload: { stepId: "competing-step" },
  });
  const outcomes = await Promise.allSettled([
    store.append(firstWriter, 1),
    store.append(secondWriter, 1),
  ]);
  contract.assert(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length === 1 &&
      outcomes.filter((outcome) => outcome.status === "rejected").length === 1,
    "optimistic-concurrency",
  );
  contract.assert(
    (await collect(store.read("other-tenant", "contract-run"))).length === 0,
    "tenant-isolation",
  );
  contract.assert(
    (await collect(store.read("contract-tenant", "contract-run", 1))).length === 1,
    "sequence-replay-cursor",
  );
  const firstReplay = await collect(store.read("contract-tenant", "contract-run"));
  const secondReplay = await collect(store.read("contract-tenant", "contract-run"));
  contract.assert(
    firstReplay.length === 2 &&
      secondReplay.length === 2 &&
      firstReplay[0] !== secondReplay[0] &&
      sameValue(firstReplay, secondReplay),
    "defensive-event-copy",
  );
  await contract.rejects(
    () => collect(store.read("contract-tenant", "contract-run", -1)),
    "invalid-replay-cursor-rejected",
  );
  contract.assert(
    (await store.getProjection("contract-tenant", "contract-run"))?.lastSequence === 2,
    "projection-updated",
  );
  return contract.report();
}

export async function runContextStoreContract(
  createStore: () => ContextStore,
): Promise<ContractReport> {
  const contract = new ContractRecorder("ContextStore");
  const store = createStore();
  assertCapabilities(contract, store.capabilities);
  await store.put(createContractContextSnapshot(1));
  await store.put(createContractContextSnapshot(2));
  contract.assert(
    (await store.getLatest("contract-tenant", "contract-run"))?.sequence === 2,
    "latest-snapshot",
  );
  contract.assert(
    (await store.getLatest("other-tenant", "contract-run")) === undefined,
    "tenant-isolation",
  );
  const firstRead = await store.getLatest("contract-tenant", "contract-run");
  const secondRead = await store.getLatest("contract-tenant", "contract-run");
  contract.assert(
    firstRead !== undefined && secondRead !== undefined && firstRead !== secondRead,
    "defensive-snapshot-copy",
  );
  await contract.rejects(
    () =>
      store.put(
        createContractContextSnapshot(2, {
          contextDigest: contractDigest("changed-context"),
        }),
      ),
    "same-snapshot-mutation-rejected",
  );
  await store.delete("contract-tenant", "contract-run");
  contract.assert(
    (await store.getLatest("contract-tenant", "contract-run")) === undefined,
    "explicit-deletion",
  );
  return contract.report();
}

export async function runArtifactStoreContract(
  createStore: () => ArtifactStore,
): Promise<ContractReport> {
  const contract = new ContractRecorder("ArtifactStore");
  const store = createStore();
  assertCapabilities(contract, store.capabilities);
  const fixture = createContractArtifact();
  await store.put(fixture.artifact, fixture.content);
  await store.put(structuredClone(fixture.artifact), new Uint8Array(fixture.content));
  const stored = await store.get("contract-tenant", fixture.artifact.artifactId);
  contract.assert(stored !== undefined, "round-trip");
  contract.assert(
    stored !== undefined && new TextDecoder().decode(stored.content) === "contract artifact",
    "content-round-trip",
  );
  if (stored !== undefined) stored.content[0] = 0;
  const reread = await store.get("contract-tenant", fixture.artifact.artifactId);
  contract.assert(
    reread !== undefined && new TextDecoder().decode(reread.content) === "contract artifact",
    "defensive-content-copy",
  );
  contract.assert(
    stored !== undefined && reread !== undefined && stored.artifact !== reread.artifact,
    "defensive-metadata-copy",
  );
  contract.assert(
    (await store.get("other-tenant", fixture.artifact.artifactId)) === undefined,
    "tenant-isolation",
  );
  const changed = createContractArtifact(new TextEncoder().encode("changed artifact"));
  await contract.rejects(
    () => store.put(changed.artifact, changed.content),
    "same-id-mutation-rejected",
  );
  await store.delete("contract-tenant", fixture.artifact.artifactId);
  contract.assert(
    (await store.get("contract-tenant", fixture.artifact.artifactId)) === undefined,
    "explicit-deletion",
  );
  return contract.report();
}

export async function runRunLeaseStoreContract(
  createHarness: () => RunLeaseContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("RunLeaseStore");
  const harness = createHarness();
  const { store } = harness;
  const first = await store.acquire("contract-tenant", "contract-run", "worker-a", 1_000);
  contract.assert(first !== undefined && first.fencingToken >= 1, "first-acquire");
  contract.assert(
    (await store.acquire("contract-tenant", "contract-run", "worker-b", 1_000)) === undefined,
    "exclusive-active-lease",
  );
  const otherTenant = await store.acquire("other-tenant", "contract-run", "worker-b", 1_000);
  contract.assert(otherTenant !== undefined, "tenant-isolation");
  if (first === undefined) return contract.report();
  harness.advance(1_001);
  const second = await store.acquire("contract-tenant", "contract-run", "worker-b", 1_000);
  contract.assert(
    second !== undefined && second.fencingToken > first.fencingToken,
    "expired-lease-fence-advances",
  );
  await contract.rejects(() => store.renew(first, 1_000), "stale-renew-rejected");
  if (second !== undefined) {
    const renewed = await store.renew(second, 1_000);
    contract.assert(renewed.fencingToken === second.fencingToken, "renew-preserves-fence");
    await store.release(renewed);
    await contract.rejects(() => store.renew(renewed, 1_000), "released-renew-rejected");
    const reacquired = await store.acquire("contract-tenant", "contract-run", "worker-c", 1_000);
    contract.assert(
      reacquired !== undefined && reacquired.fencingToken > renewed.fencingToken,
      "released-lease-fence-advances",
    );
  }
  return contract.report();
}

export async function runStoreContracts(
  factories: StoreContractFactories,
): Promise<readonly ContractReport[]> {
  return Promise.all([
    runAcceptedWorkOrderStoreContract(factories.createAcceptedWorkOrderStore),
    runInputSubmissionStoreContract(factories.createInputSubmissionStore),
    runEventStoreContract(factories.createEventStore),
    runContextStoreContract(factories.createContextStore),
    runArtifactStoreContract(factories.createArtifactStore),
    runRunLeaseStoreContract(factories.createRunLeaseHarness),
  ]);
}

function assertCapabilities(contract: ContractRecorder, capabilities: RuntimeCapabilities): void {
  const parsed = RuntimeCapabilitiesSchema.safeParse(capabilities);
  contract.assert(parsed.success, "valid-runtime-capabilities");
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
