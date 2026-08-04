export type MCPAdapterErrorCode =
  | "KAF_MCP_ABORTED"
  | "KAF_MCP_CONNECTION_FAILED"
  | "KAF_MCP_CREDENTIAL_BINDING_INVALID"
  | "KAF_MCP_EGRESS_REQUIRED"
  | "KAF_MCP_EXPOSURE_DENIED"
  | "KAF_MCP_HTTP_ENDPOINT_DENIED"
  | "KAF_MCP_HTTP_REDIRECT_DENIED"
  | "KAF_MCP_IDENTITY_DRIFT"
  | "KAF_MCP_LIMIT_EXCEEDED"
  | "KAF_MCP_MALFORMED_RESPONSE"
  | "KAF_MCP_PRODUCTION_SANDBOX_REQUIRED"
  | "KAF_MCP_STDIO_ENVIRONMENT_INVALID"
  | "KAF_MCP_TOOL_NOT_EXPOSED"
  | "KAF_MCP_TOOL_INPUT_INVALID"
  | "KAF_MCP_TOOL_OUTPUT_INVALID"
  | "KAF_MCP_TOOL_SCHEMA_DRIFT";

export class MCPAdapterError extends Error {
  readonly code: MCPAdapterErrorCode;

  constructor(code: MCPAdapterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MCPAdapterError";
    this.code = code;
  }
}
