import {
  CommandContextSchema,
  CommandRecordSchema,
  CommandScopeSchema,
  JsonValueSchema,
  type CommandContext,
  type CommandScope,
  type JsonValue,
  type RunCommandUnitOfWork,
} from "@pactmark/core";

import { createContractCommandRecord, contractDigest } from "./fixtures.js";
import {
  ContractRecorder,
  assertSafeErrorSurface,
  sameValue,
  type ContractReport,
  type SafeErrorSurfaceFactory,
} from "./report.js";

export interface RunCommandUnitOfWorkContractHarness {
  readonly unitOfWork: RunCommandUnitOfWork;
  readonly scope: CommandScope;
  readonly context: CommandContext;
  readonly expectedValue: JsonValue;
  readonly sensitiveErrorMarker: string;
  readonly errorSurface: SafeErrorSurfaceFactory;
  observeAtomicCommandAndWakeup(unitOfWork: RunCommandUnitOfWork): Promise<boolean>;
}

/** Verifies complete-scope replay, changed-digest rejection, tenant binding, and capability truth. */
export async function runRunCommandUnitOfWorkContract(
  createHarness: () => RunCommandUnitOfWorkContractHarness,
): Promise<ContractReport> {
  const contract = new ContractRecorder("RunCommandUnitOfWork");
  const harness = createHarness();
  const unit = harness.unitOfWork;
  contract.assert(
    CommandScopeSchema.safeParse(harness.scope).success,
    "command-scope-schema-valid",
  );
  contract.assert(
    CommandContextSchema.safeParse(harness.context).success,
    "command-context-schema-valid",
  );
  contract.assert(JsonValueSchema.safeParse(harness.expectedValue).success, "result-schema-valid");
  contract.assert(unit.transactionDomain.trim().length > 0, "transaction-domain-declared");
  contract.assert(
    (await harness.observeAtomicCommandAndWakeup(unit)) === unit.atomicCommandAndWakeup,
    "atomic-command-wakeup-capability-truthful",
  );

  let callbackCalls = 0;
  const first = await unit.transactCommand(harness.scope, harness.context, async (transaction) => {
    callbackCalls += 1;
    await transaction.putCommandRecord(
      createContractCommandRecord(harness.scope, harness.context.requestDigest),
    );
    return structuredClone(harness.expectedValue);
  });
  contract.assert(!first.replayed, "first-command-not-replayed");
  contract.assert(sameValue(first.value, harness.expectedValue), "first-command-result");
  contract.assert(
    CommandRecordSchema.safeParse(first.commandRecord).success,
    "command-record-schema-valid",
  );

  const replay = await unit.transactCommand(harness.scope, harness.context, () => {
    callbackCalls += 1;
    return Promise.reject(new Error("replay callback must not run"));
  });
  contract.assert(replay.replayed, "exact-command-replayed");
  contract.assert(sameValue(replay.value, harness.expectedValue), "replayed-command-result");
  contract.assert(callbackCalls === 1, "replay-zero-callback-dispatch");

  const changedContext = CommandContextSchema.parse({
    ...harness.context,
    requestDigest: contractDigest("changed-command-request"),
  });
  const changedDigestError = await contract.captureRejection(
    () =>
      unit.transactCommand(harness.scope, changedContext, () => {
        callbackCalls += 1;
        return Promise.resolve(harness.expectedValue);
      }),
    "changed-digest-replay-rejected",
  );
  contract.assert(callbackCalls === 1, "changed-digest-zero-callback-dispatch");
  assertSafeErrorSurface(
    contract,
    changedDigestError,
    harness.errorSurface,
    harness.sensitiveErrorMarker,
    "changed-digest-safe-error",
  );

  const freshScope = CommandScopeSchema.parse({
    ...harness.scope,
    commandId: nextCommandId(harness.scope.commandId),
  });
  const freshContext = CommandContextSchema.parse({
    ...harness.context,
    commandId: freshScope.commandId,
    requestDigest: contractDigest("cross-tenant-command-request"),
  });
  const foreignScope = CommandScopeSchema.parse({
    ...freshScope,
    tenant: { id: `${freshScope.tenant.id}-foreign` },
  });
  await contract.rejects(
    () =>
      unit.transactCommand(freshScope, freshContext, async (transaction) => {
        await transaction.putCommandRecord(
          createContractCommandRecord(foreignScope, freshContext.requestDigest),
        );
        return harness.expectedValue;
      }),
    "cross-tenant-command-record-rejected",
  );

  let malformedCallbackCalls = 0;
  const transactUntrusted = unit.transactCommand.bind(unit) as unknown as (
    scope: unknown,
    context: unknown,
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
  await contract.rejects(
    () =>
      transactUntrusted({ ...freshScope, tenant: { id: "" } }, freshContext, () => {
        malformedCallbackCalls += 1;
        return Promise.resolve(null);
      }),
    "malformed-command-scope-rejected",
  );
  contract.assert(malformedCallbackCalls === 0, "malformed-command-zero-callback-dispatch");
  return contract.report();
}

function nextCommandId(commandId: string): string {
  const final = commandId.at(-1);
  return `${commandId.slice(0, -1)}${final === "0" ? "1" : "0"}`;
}
