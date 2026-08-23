import { KafError } from "@pactmark/core";

const ERROR_REFERENCE_URL = "https://github.com/lokomotifai/pactmark/blob/main/ERRORS.md";

function errorReference(anchor: string): string {
  return `${ERROR_REFERENCE_URL}#${anchor}`;
}

export type CliErrorCode =
  | "KAF_CLI_ARGUMENT_INVALID"
  | "KAF_CLI_COMMAND_UNSUPPORTED"
  | "KAF_CLI_HOST_NOT_CONFIGURED"
  | "KAF_CLI_RESOURCE_NOT_FOUND"
  | "KAF_CLI_EVIDENCE_INVALID"
  | "KAF_CLI_COMPILE_INVALID"
  | "KAF_CLI_COMPILE_SECRET_DETECTED"
  | "KAF_CLI_REPLAY_INTEGRITY_FAILED"
  | "KAF_CLI_IO_FAILURE";

const DESCRIPTORS: Readonly<
  Record<CliErrorCode, Readonly<{ message: string; remediation: string }>>
> = Object.freeze({
  KAF_CLI_ARGUMENT_INVALID: {
    message: "The command arguments are invalid.",
    remediation: "Run the command with --help and correct the arguments.",
  },
  KAF_CLI_COMMAND_UNSUPPORTED: {
    message: "The configured host does not support this command.",
    remediation: "Configure the corresponding authenticated host operation.",
  },
  KAF_CLI_HOST_NOT_CONFIGURED: {
    message: "No Pactmark CLI host is configured.",
    remediation: "Set PACTMARK_CLI_CONFIG to a trusted local host module.",
  },
  KAF_CLI_RESOURCE_NOT_FOUND: {
    message: "The requested Pactmark resource was not found.",
    remediation: "Check the identifier and the configured tenant authority.",
  },
  KAF_CLI_EVIDENCE_INVALID: {
    message: "The evidence record is invalid or its digest does not match.",
    remediation: "Export the record again from its authoritative run store.",
  },
  KAF_CLI_COMPILE_INVALID: {
    message: "The Pactmark authoring inputs are invalid.",
    remediation: "Correct AGENT.md, skill manifests, paths, schema versions, and capabilities.",
  },
  KAF_CLI_COMPILE_SECRET_DETECTED: {
    message: "A possible secret was found in a Pactmark authoring input.",
    remediation: "Remove credentials and reference an external credential provider instead.",
  },
  KAF_CLI_REPLAY_INTEGRITY_FAILED: {
    message: "The stored run does not match its read-only replay integrity checks.",
    remediation: "Inspect the append-only event stream and artifact store before trusting the run.",
  },
  KAF_CLI_IO_FAILURE: {
    message: "The command could not read the requested local input.",
    remediation: "Check the path, permissions, and UTF-8 JSON content.",
  },
});

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly remediation: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(
    code: CliErrorCode,
    options: { readonly details?: Readonly<Record<string, string | number | boolean | null>> } = {},
  ) {
    const descriptor = DESCRIPTORS[code];
    super(descriptor.message);
    this.name = "CliError";
    this.code = code;
    this.remediation = descriptor.remediation;
    this.details = options.details;
  }
}

export interface CliPublicError {
  readonly schemaVersion: "1";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly remediation: string;
  readonly docsUrl: string;
  readonly causeCode?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly diagnostic?: Readonly<{ kind: "redacted"; errorType: string }>;
}

export function toCliPublicError(error: unknown, debug: boolean): CliPublicError {
  if (error instanceof CliError) {
    return {
      schemaVersion: "1",
      code: error.code,
      message: error.message,
      retryable: false,
      remediation: error.remediation,
      docsUrl: errorReference("cli-errors"),
      ...(debug ? { diagnostic: { kind: "redacted" as const, errorType: error.name } } : {}),
    };
  }
  if (error instanceof KafError) {
    return {
      schemaVersion: "1",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      remediation: `See ${error.documentationSlug}.`,
      docsUrl: errorReference(error.documentationSlug),
      ...(error.causeCode === undefined ? {} : { causeCode: error.causeCode }),
      ...(debug ? { diagnostic: { kind: "redacted" as const, errorType: error.name } } : {}),
    };
  }
  return {
    schemaVersion: "1",
    code: "KAF_CLI_IO_FAILURE",
    message: DESCRIPTORS.KAF_CLI_IO_FAILURE.message,
    retryable: false,
    remediation: DESCRIPTORS.KAF_CLI_IO_FAILURE.remediation,
    docsUrl: errorReference("cli-errors"),
    ...(debug
      ? {
          diagnostic: {
            kind: "redacted" as const,
            errorType: error instanceof Error ? "Error" : "UnknownError",
          },
        }
      : {}),
  };
}
