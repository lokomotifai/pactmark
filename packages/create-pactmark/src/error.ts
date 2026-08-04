export type InitializerErrorCode =
  | "KAF_INIT_ABORTED"
  | "KAF_INIT_ARGUMENT_INVALID"
  | "KAF_INIT_COMMAND_FAILED"
  | "KAF_INIT_TARGET_EXISTS"
  | "KAF_INIT_TARGET_INVALID"
  | "KAF_INIT_TEMPLATE_INVALID";

const MESSAGES: Readonly<Record<InitializerErrorCode, string>> = Object.freeze({
  KAF_INIT_ABORTED: "Project creation was cancelled.",
  KAF_INIT_ARGUMENT_INVALID: "An initializer argument is invalid.",
  KAF_INIT_COMMAND_FAILED: "A local setup command failed.",
  KAF_INIT_TARGET_EXISTS: "The target already exists and is not empty.",
  KAF_INIT_TARGET_INVALID: "The project target is invalid.",
  KAF_INIT_TEMPLATE_INVALID: "The embedded template failed validation.",
});

export class InitializerError extends Error {
  readonly code: InitializerErrorCode;
  readonly remediation: string;

  constructor(code: InitializerErrorCode, remediation: string) {
    super(MESSAGES[code]);
    this.name = "InitializerError";
    this.code = code;
    this.remediation = remediation;
  }

  toJSON(): Readonly<{
    schemaVersion: "1";
    code: InitializerErrorCode;
    message: string;
    remediation: string;
  }> {
    return Object.freeze({
      schemaVersion: "1",
      code: this.code,
      message: this.message,
      remediation: this.remediation,
    });
  }
}

export function asInitializerError(error: unknown): InitializerError {
  if (error instanceof InitializerError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new InitializerError("KAF_INIT_ABORTED", "Run the initializer again when ready.");
  }
  return new InitializerError(
    "KAF_INIT_COMMAND_FAILED",
    "Review local filesystem permissions and retry with --dry-run first.",
  );
}
