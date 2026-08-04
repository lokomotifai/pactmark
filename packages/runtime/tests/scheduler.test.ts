import type { WakeupRequest } from "@pactmark/core";
import { describe, expect, it, vi } from "vitest";

import { InlineWakeupScheduler } from "../src/scheduler.js";

const request: WakeupRequest = {
  schemaVersion: "1",
  tenantId: "tenant-1",
  runId: "run-1",
  reason: "run_accepted",
  scheduledAt: "2026-08-03T12:00:00.000Z",
  deduplicationKey: "command-1",
};

function scheduler(handler = vi.fn(async () => Promise.resolve())) {
  let id = 0;
  const onHandlerError = vi.fn();
  return {
    handler,
    onHandlerError,
    value: new InlineWakeupScheduler({
      clock: { now: () => request.scheduledAt, monotonicMilliseconds: () => 0 },
      idGenerator: { generate: () => `wakeup-${String(++id)}` },
      handler,
      onHandlerError,
    }),
  };
}

describe("InlineWakeupScheduler", () => {
  it("issues an explicitly non-durable receipt and runs the handler in a microtask", async () => {
    const fixture = scheduler();
    const receipt = await fixture.value.schedule(request);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(receipt).toMatchObject({
      receiptId: "wakeup-1",
      schedulerId: "pactmark.inline@1",
      durable: false,
      atomicWithCommand: false,
    });
    expect(fixture.handler).toHaveBeenCalledWith(request);
  });

  it("cancels pending work without retaining a cancellation tombstone", async () => {
    const fixture = scheduler();
    const receipt = await fixture.value.schedule(request);
    await fixture.value.cancel(receipt);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(fixture.handler).not.toHaveBeenCalled();
    await expect(fixture.value.cancel(receipt)).resolves.toBeUndefined();
  });

  it("routes asynchronous handler failures through the explicit safe host hook", async () => {
    const failure = new Error("fixture failure");
    const fixture = scheduler(vi.fn(async () => Promise.reject(failure)));
    const receipt = await fixture.value.schedule(request);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(fixture.onHandlerError).toHaveBeenCalledWith(receipt, failure);
  });
});
