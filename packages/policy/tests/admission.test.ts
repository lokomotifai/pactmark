import { type AdmissionRequest, type Clock, type IdGenerator } from "@pactmark/core";
import { describe, expect, it } from "vitest";

import { AdmissionError, createMemoryAdmissionController } from "../src/index.js";

let now = "2026-08-03T10:00:00.000Z";
let nextId = 0;
const clock: Clock = { now: () => now, monotonicMilliseconds: () => 0 };
const ids: IdGenerator = { generate: () => `admission-${String(++nextId)}` };

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    schemaVersion: "1",
    tenant: { id: "tenant-1" },
    principal: { type: "user", id: "user-1" },
    category: "active_run",
    resourceKey: "agent:test@1",
    amount: 1,
    leaseDurationMs: 60_000,
    ...overrides,
  };
}

describe("memory admission reference", () => {
  it("enforces scoped finite limits, releases once, and returns bounded retry guidance", async () => {
    now = "2026-08-03T10:00:00.000Z";
    const { controller, quotaStore } = createMemoryAdmissionController({
      clock,
      idGenerator: ids,
      limits: [{ category: "active_run", maximum: 2, retryAfterSeconds: 9_999 }],
    });
    const first = await controller.evaluate(request());
    const second = await controller.evaluate(request());
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    await expect(controller.evaluate(request())).resolves.toEqual({
      admitted: false,
      code: "KAF_POLICY_ADMISSION_LIMIT",
      retryAfterSeconds: 3600,
    });
    if (!first.admitted) throw new Error("fixture must be admitted");
    await quotaStore.release(
      first.reservation.tenant.id,
      first.reservation.id,
      first.reservation.fencingToken,
      "2026-08-03T10:00:01.000Z",
    );
    await expect(controller.evaluate(request())).resolves.toMatchObject({ admitted: true });
    await expect(
      quotaStore.release("tenant-1", first.reservation.id, 999, now),
    ).rejects.toBeInstanceOf(AdmissionError);
  });

  it("isolates tenant/principal/resource scopes and reclaims only expired leases", async () => {
    now = "2026-08-03T10:00:00.000Z";
    const { controller, quotaStore } = createMemoryAdmissionController({
      clock,
      idGenerator: ids,
      limits: [{ category: "active_run", maximum: 1, retryAfterSeconds: 10 }],
    });
    await expect(controller.evaluate(request())).resolves.toMatchObject({ admitted: true });
    await expect(
      controller.evaluate(request({ tenant: { id: "tenant-2" } })),
    ).resolves.toMatchObject({ admitted: true });
    await expect(
      controller.evaluate(request({ principal: { type: "user", id: "user-2" } })),
    ).resolves.toMatchObject({ admitted: true });
    await expect(
      controller.evaluate(request({ resourceKey: "agent:other@1" })),
    ).resolves.toMatchObject({ admitted: true });
    now = "2026-08-03T10:01:00.000Z";
    await expect(quotaStore.reconcileExpired(now)).resolves.toBe(4);
    await expect(controller.evaluate(request())).resolves.toMatchObject({ admitted: true });
  });

  it("replays one command without a second debit and rejects changed reuse", async () => {
    now = "2026-08-03T10:00:00.000Z";
    const { controller } = createMemoryAdmissionController({
      clock,
      idGenerator: ids,
      limits: [{ category: "request_start", maximum: 1, retryAfterSeconds: 5 }],
    });
    const value = request({
      category: "request_start",
      commandId: "kafcmd_1785751200000_00000000000000000000000000000000",
    });
    const first = await controller.evaluate(value);
    await expect(controller.evaluate(value)).resolves.toEqual(first);
    await expect(controller.evaluate({ ...value, amount: 2 })).rejects.toBeInstanceOf(
      AdmissionError,
    );
  });

  it("denies unconfigured categories and invalid configuration", async () => {
    const { controller } = createMemoryAdmissionController({
      clock,
      idGenerator: ids,
      limits: [{ category: "active_run", maximum: 1, retryAfterSeconds: 1 }],
    });
    await expect(controller.evaluate(request({ category: "model_call" }))).resolves.toEqual({
      admitted: false,
      code: "KAF_POLICY_ADMISSION_DENIED",
      retryAfterSeconds: 60,
    });
    expect(() =>
      createMemoryAdmissionController({
        clock,
        idGenerator: ids,
        limits: [
          { category: "active_run", maximum: Number.POSITIVE_INFINITY, retryAfterSeconds: 1 },
        ],
      }),
    ).toThrow(AdmissionError);
    expect(() =>
      createMemoryAdmissionController({
        clock,
        idGenerator: ids,
        limits: [{ category: "active_run", maximum: 1, retryAfterSeconds: 0 }],
      }),
    ).toThrow(AdmissionError);
  });
});
