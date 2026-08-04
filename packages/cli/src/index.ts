export { runCli } from "./cli.js";
export { CliError, toCliPublicError, type CliErrorCode, type CliPublicError } from "./error.js";
export { helpFor, VERSION } from "./help.js";
export { createNodeCliIo, type NodeCliEnvironmentOptions } from "./node.js";
export { compileAgentPackage } from "./compile.js";
export { safeCanonicalJson, safeMultiline, visibleText } from "./render.js";
export { CliHostProbeSchema, CliOperationResultSchema } from "./types.js";
export type {
  CliIo,
  CliHostProbe,
  CompileResult,
  CliOperationName,
  CliOperationRequest,
  CliOperationResult,
  CliRunResult,
  CliRuntime,
  PactmarkCliHost,
} from "./types.js";
