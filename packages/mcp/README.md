# @pactmark/mcp

Guarded MCP client adapter built against the official `@modelcontextprotocol/sdk@1.30.0`.

The host—not a model, WorkOrder, prompt, or server response—pins transport configuration, server identity, executable/endpoint, arguments, working directory, environment-name allowlist, tool schema digests, purpose, Pactmark security metadata, and exposure authority. Discovery metadata and returned content are always untrusted. Stdio uses an empty-by-default exact environment and is preview-only unless a production-ready sandbox launcher is supplied. Streamable HTTP uses no global `fetch`: preview requires an injected client, while production requires an exact-profile host egress boundary that explicitly enforces DNS-rebinding, redirect-origin, credential-origin, and byte/time controls.

This package does not implement a production arbitrary-code sandbox or a DNS/IP-enforcing egress proxy. Production readiness is reported only when those host-owned controls are explicitly injected and bound to the exact profile. A plain `EgressHttpClient` is preview-only and never satisfies production readiness.

## Security contract

- `defineMCPTransportSecurityProfile`, `defineMCPServerIdentity`, and
  `defineMCPToolPin` materialize canonical SHA-256 identities. Every connection
  re-verifies the claimed digests before transport creation or discovery.
- The stdio profile pins an absolute executable, executable bytes, exact argument vector, working directory, explicit environment-name allowlist, filesystem and network policy IDs, and finite process/output/time limits. Direct preview launch verifies the executable and working-directory types plus exact executable bytes before resolving environment values. Pactmark's transport spawns with `shell: false` and an exact `env`; it does not use the official SDK transport's safe-default ambient environment merge. Abort and close terminate the child with bounded TERM/KILL cleanup, while stdout/stderr and individual requests are bounded.
- Direct preview launch opens the executable with no-follow semantics and hashes
  that open descriptor. Linux executes the same descriptor through
  `/proc/self/fd`; macOS keeps the verified descriptor open and immediately
  rechecks device, inode, size, and modification time before spawning because
  `posix_spawn` cannot execute `/dev/fd`. That macOS check narrows but cannot
  eliminate the pathname race, so direct launch remains preview-only on every
  platform. Unsupported platforms fail closed.
- Production stdio is rejected unless a sandbox launcher is bound to the exact
  transport-profile digest and declares process, filesystem, network, and
  resource-limit enforcement. Its `verifyExecutable` step must succeed before
  environment resolution or launch, and the launch request carries the exact
  profile, executable, arguments, cwd, environment, policy IDs, limits, and
  `AbortSignal`. The launcher remains responsible for enforcing these bindings
  inside its isolation boundary.
- Streamable HTTP accepts one exact HTTPS endpoint. Textually private, loopback,
  link-local, and metadata endpoints additionally require a trusted-host
  capability bound to the exact profile digest and origin. This capability does
  not replace egress enforcement. Production bytes must traverse an
  `MCPHttpEgressBoundary` bound to the exact profile and endpoint; its host-owned
  implementation must resolve and revalidate DNS/IP destinations, resist DNS
  rebinding, reject redirect-origin changes, bind credentials to the resolved
  origin, and enforce limits. Pactmark additionally checks the exact URL on
  every request, uses manual redirects, strips ambient authorization/cookie/API
  key headers, omits browser credentials, and bounds request/response/time.
  The boundary's active resolved-endpoint validation is invoked immediately
  before each fetch; a construction-time hostname check is not accepted as DNS
  rebinding protection.
- HTTP credentials are resolved only after endpoint/egress validation from a Pactmark `SecretRef` whose tenant, WorkOrder, execution definition, grant, slot, destination digest, pinned tool registration, and authorization reservation match. The bearer value is added only for the exact endpoint and is never forwarded through a redirect.
- Server descriptions, annotations, schemas, metadata, capabilities, and tool output are parsed as untrusted data. The model-visible description and security metadata come from the host pin. Unknown, ambiguous, schema-drifted, wrong-purpose, and ungranted tools are unavailable. Exact discovered input/output JSON Schemas are compiled and enforced; authority and grant identity are checked again before every call.
- Optional audit events contain only operation/status, digests, safe KAF codes,
  and counts—never MCP content, arguments, output, credentials, or endpoint
  tokens.

`MCPServerIdentityDigest` is included in each MCP tool registration digest, so
the existing core agent/checkpoint/effect bindings transitively identify the
exact server and transport. A distinct core-level MCP server kill-switch port
does not yet exist; hosts must revoke the bound tool registration digests until
that cross-package contract is added.

The core `EgressBroker.bind` shape binds one tool registration, while one MCP connection may discover several independently pinned tool registrations. This package therefore does not invent a server-wide core binding or claim that a plain bound client proves DNS enforcement. Production HTTP uses the explicit MCP-level enforced-boundary contract above until a future reviewed core contract can represent a multi-tool MCP server connection.

`skipLibCheck` is scoped to this adapter because SDK 1.30.0's published
`StreamableHTTPClientTransport.sessionId` declaration conflicts with TypeScript
6 `exactOptionalPropertyTypes`. Pactmark's own public declarations remain fully
typechecked and do not expose SDK transport types.

## v0.3 pin migration

Schema presence is part of an MCP tool's pinned identity. Hosts upgrading from
v0.2 must regenerate pins for tools that advertise no `outputSchema`, using
`mcpToolOutputSchemaDigest(undefined)`. The v0.2 convention of hashing an
implicit `{ "type": "object" }` schema is intentionally rejected as drift: it
cannot distinguish an absent schema from a server that later adds that schema.
Do not replace an absent schema with an invented permissive schema during
migration.
