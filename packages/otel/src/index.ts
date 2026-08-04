import { digestCanonicalJson, type TelemetrySink } from "@pactmark/core";

export interface PactmarkTelemetryRecord {
  readonly schemaVersion: "1";
  readonly operation: string;
  readonly status: string;
  readonly durationMs: number;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly counters: Readonly<Record<string, number>>;
}

export interface MetadataTelemetryOptions {
  /** Deployment-specific salt. Keep it outside model and event data. */
  readonly deploymentSalt: string;
  /** The host owns exporter configuration and all network behavior. */
  readonly export: (record: PactmarkTelemetryRecord) => void;
  readonly allowedIdentifierKeys?: readonly string[];
  readonly allowedCounterKeys?: readonly string[];
}

const defaultIdentifiers = new Set([
  "runId",
  "toolId",
  "riskClass",
  "policyReason",
  "provider",
  "model",
  "errorCode",
]);
const defaultCounters = new Set(["inputTokens", "outputTokens", "toolCalls", "modelCalls"]);

function pseudonymize(value: string, salt: string): string {
  return digestCanonicalJson([salt, value]);
}

function selectStrings(
  values: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>,
  salt: string,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) continue;
    output[key] = key === "runId" ? pseudonymize(value, salt) : value.slice(0, 256);
  }
  return Object.freeze(output);
}

function selectNumbers(
  values: Readonly<Record<string, number>>,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, number>> {
  const output: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key) && Number.isFinite(value) && value >= 0) output[key] = value;
  }
  return Object.freeze(output);
}

/**
 * Creates a metadata-only sink. It has no ambient exporter and makes no network
 * call; the host must explicitly supply the export callback.
 */
export function createMetadataTelemetrySink(options: MetadataTelemetryOptions): TelemetrySink {
  if (options.deploymentSalt.length < 16) {
    throw new TypeError("KAF_TELEMETRY_DEPLOYMENT_SALT_INVALID");
  }
  const identifiers = new Set(options.allowedIdentifierKeys ?? defaultIdentifiers);
  const counters = new Set(options.allowedCounterKeys ?? defaultCounters);
  return Object.freeze({
    emit(record: Parameters<TelemetrySink["emit"]>[0]): void {
      if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
        throw new TypeError("KAF_TELEMETRY_DURATION_INVALID");
      }
      options.export(
        Object.freeze({
          schemaVersion: "1",
          operation: record.operation.slice(0, 256),
          status: record.status.slice(0, 128),
          durationMs: record.durationMs,
          identifiers: selectStrings(record.identifiers, identifiers, options.deploymentSalt),
          counters: selectNumbers(record.counters, counters),
        }),
      );
    },
  });
}

export function createNoopTelemetrySink(): TelemetrySink {
  return Object.freeze({ emit: () => undefined });
}
