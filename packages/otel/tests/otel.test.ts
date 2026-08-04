import { describe, expect, it, vi } from "vitest";

import {
  createMetadataTelemetrySink,
  createNoopTelemetrySink,
  type PactmarkTelemetryRecord,
} from "../src/index.js";

describe("metadata telemetry", () => {
  it("exports only allowlisted metadata and pseudonymizes run IDs", () => {
    const records: PactmarkTelemetryRecord[] = [];
    const exportRecord = vi.fn((record: PactmarkTelemetryRecord): void => {
      records.push(record);
    });
    const sink = createMetadataTelemetrySink({
      deploymentSalt: "deployment-specific-salt",
      export: exportRecord,
    });
    sink.emit({
      operation: "tool.execute",
      status: "ok",
      durationMs: 12,
      identifiers: {
        runId: "run-secret",
        toolId: "knowledge.search@1",
        prompt: "must-not-leave",
        userEmail: "must-not-leave@example.com",
      },
      counters: { inputTokens: 4, outputTokens: 8, privateBytes: 999 },
    });
    expect(exportRecord).toHaveBeenCalledOnce();
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("expected exported telemetry record");
    expect(record).toMatchObject({
      schemaVersion: "1",
      operation: "tool.execute",
      status: "ok",
      durationMs: 12,
      identifiers: { toolId: "knowledge.search@1" },
      counters: { inputTokens: 4, outputTokens: 8 },
    });
    expect(record.identifiers.runId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(record.identifiers).not.toHaveProperty("prompt");
    expect(record.identifiers).not.toHaveProperty("userEmail");
    expect(record.counters).not.toHaveProperty("privateBytes");
  });

  it("supports narrower host allowlists and clips identifier values", () => {
    const records: unknown[] = [];
    const sink = createMetadataTelemetrySink({
      deploymentSalt: "deployment-specific-salt",
      allowedIdentifierKeys: ["provider"],
      allowedCounterKeys: ["modelCalls"],
      export: (record) => {
        records.push(record);
      },
    });
    sink.emit({
      operation: "model.call",
      status: "ok",
      durationMs: 0,
      identifiers: { provider: "x".repeat(300), model: "hidden" },
      counters: { modelCalls: 1, inputTokens: Number.NaN },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ counters: { modelCalls: 1 } });
    expect((records[0] as { identifiers: { provider: string } }).identifiers.provider).toHaveLength(
      256,
    );
  });

  it("rejects weak salts and invalid measurements", () => {
    expect(() =>
      createMetadataTelemetrySink({ deploymentSalt: "short", export: () => undefined }),
    ).toThrow("KAF_TELEMETRY_DEPLOYMENT_SALT_INVALID");
    const sink = createMetadataTelemetrySink({
      deploymentSalt: "deployment-specific-salt",
      export: () => undefined,
    });
    expect(() => {
      sink.emit({
        operation: "run",
        status: "bad",
        durationMs: -1,
        identifiers: {},
        counters: {},
      });
    }).toThrow("KAF_TELEMETRY_DURATION_INVALID");
  });

  it("provides an inert default with no exporter", () => {
    const sink = createNoopTelemetrySink();
    sink.emit({
      operation: "run",
      status: "ok",
      durationMs: 0,
      identifiers: {},
      counters: {},
    });
  });
});
