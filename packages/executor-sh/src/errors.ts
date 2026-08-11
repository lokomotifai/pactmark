export type ExecutorAdapterErrorCode =
  | "KAF_EXECUTOR_ABORTED"
  | "KAF_EXECUTOR_CONNECTION_DRIFT"
  | "KAF_EXECUTOR_CONNECTION_FAILED"
  | "KAF_EXECUTOR_DEPLOYMENT_NOT_READY"
  | "KAF_EXECUTOR_INPUT_INVALID"
  | "KAF_EXECUTOR_OUTPUT_INVALID"
  | "KAF_EXECUTOR_PIN_DRIFT"
  | "KAF_EXECUTOR_POLICY_UNSUPPORTED"
  | "KAF_EXECUTOR_REGISTRATION_UNKNOWN"
  | "KAF_EXECUTOR_SCHEMA_INVALID"
  | "KAF_EXECUTOR_SCHEMA_UNSAFE"
  | "KAF_EXECUTOR_STATUS_UNSUPPORTED"
  | "KAF_EXECUTOR_TIMEOUT";

export class ExecutorAdapterError extends Error {
  readonly code: ExecutorAdapterErrorCode;

  constructor(code: ExecutorAdapterErrorCode, message: string) {
    super(message);
    this.name = "ExecutorAdapterError";
    this.code = code;
  }
}
