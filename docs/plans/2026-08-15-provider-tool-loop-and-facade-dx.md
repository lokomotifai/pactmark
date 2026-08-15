# Plan: real-provider tool loop and facade developer-experience defaults

- **Status:** implemented (maintainer-approved 2026-08-15; see the addendum in
  Section 11 for the three disclosed deviations)
- **Date:** 2026-08-15
- **Scope owner:** maintainer-directed implementation
- **Related ADRs:** ADR-0002 (package boundaries), ADR-0004 (provider adapters),
  ADR-0005 (default-deny security)

## 1. Problem statement

Two adoption-critical gaps exist today:

1. **A real model provider cannot invoke Pactmark tools.** The
   `@pactmark/ai-sdk` driver (`packages/ai-sdk/src/index.ts`) sends a canonical
   JSON prompt through `streamText` and yields a single `final` emission. It
   never advertises tools to the provider and never yields a `tool_call`
   emission, so the governed dispatch pipeline — the product's core claim — is
   exercised only by deterministic fixture drivers.
2. **The facade's minimum viable agent costs ~220 mandatory lines.** Every
   capability literal, model profile, schema wrapper, policy, work order, and
   command context is explicit with no defaults
   (`examples/minimal-tool-agent/src/example.ts`), and `defineTool` accepts only
   `operation.kind: "read"` (`packages/agent/src/definitions.ts:80`), so any
   consequential tool exits the facade entirely.

## 2. Design facts this plan relies on (verified in source)

- The kernel never trusts the model-proposed `targetDigest`. It re-resolves the
  call through the host `ToolCallResolver`
  (`packages/runtime/src/tool-authority.ts:28`) and the policy engine computes
  `normalizedTargetDigest = digestCanonicalJson({schemaVersion: "1", resources:
normalizedResources})` (`packages/policy/src/policy.ts:315`). Therefore an
  adapter may compute the emission's `targetDigest` deterministically from the
  proposed input; it is a wire-format requirement, not an authority claim.
- `defineSchema` already produces a canonical JSON Schema (draft 2020-12) for
  every tool input/output (`packages/core/src/schema-identity.ts`), which is the
  correct artifact to advertise to a provider without exposing executable code.
- The local model path passes `modelInput = {goal, input}` and, after a tool
  completes, `{goal, input, toolResult}` (`packages/runtime/src/runtime.ts:1593,
2309`). The driver receives `{run, input, signal}` only; instructions and the
  tool catalog must be bound by the facade, which owns the agent metadata.
- Every write effect requires a registered executable effect strategy, a
  deterministic preview bound to the policy's normalized target, and a bound
  authorization reservation (`packages/runtime/src/runtime.ts:3273`,
  `packages/runtime/src/effects.ts`). `@pactmark/store-memory` already ships the
  effect ledger, acknowledged-result store, and decision store needed to wire
  this in the ephemeral local profile.
- The portable kernel must stay free of `ai`/`@ai-sdk` imports
  (`tooling/check-portable-imports.mts`). All provider-facing work stays in
  `@pactmark/ai-sdk`; all composition work stays in `@pactmark/agent`.

## 3. Non-goals

- No kernel (`core`/`runtime`/`policy`/`evidence`) behavior changes. The one
  additive facade-visible contract is a new optional field on the facade-level
  `CompiledModelDefinition` type, which lives in `@pactmark/agent`, not the
  kernel.
- No multi-turn conversation memory beyond the kernel's existing
  `{goal, input, toolResult}` context composition. The "last tool result only"
  limitation is documented, not fixed, in this plan.
- No R4/R5 approval flow inside `createLocalRuntime`. The local facade policy
  continues to fail closed for approval-requiring risk classes; the
  approval boundary remains demonstrated at kernel level
  (`examples/approval-agent/`).
- No exactly-once claims, no production-readiness claims, no new hosted
  surface.
- No token-level client streaming; run-level event streaming remains the
  streaming surface.

## 4. Workstream A — `@pactmark/ai-sdk`: governed tool proposals from a real provider

### A1. Agent-context binding contract

Extend the facade type `CompiledModelDefinition`
(`packages/agent/src/definitions.ts`) with an optional method:

```ts
readonly bindAgentContext?: (context: ModelAgentContext) => ModelDriver;
```

where `ModelAgentContext` carries, for exactly one compiled agent:

- `instructions` (the `InstructionBundle` text entries),
- `tools`: readonly list of `{ id, description, toolRegistrationDigest,
inputJsonSchema }` derived from each `DefinedTool`'s registration and schema
  identity (`canonicalJsonSchema`),
- `outputJsonSchema` and `outputSchemaId` for the agent's declared output.

`dispatchingModel` (`packages/agent/src/runtime.ts:489`) resolves the driver as
`metadata.model.bindAgentContext?.(contextFor(agent)) ?? metadata.model.driver`,
once per agent at composition time. Existing compiled models (including every
deterministic fixture) are untouched.

Rationale: the adapter is compiled before `defineAgent` runs, so it cannot know
the tool catalog at construction. Binding at composition time guarantees the
advertised catalog is exactly the agent's registered tool set — no drift, no
second source of truth.

### A2. Provider request assembly

The bound driver translates each kernel invocation into a stateless provider
request:

- `system`: instruction text, followed by a fixed contract paragraph: the
  assistant may call the advertised tools, and its final reply must be only
  JSON conforming to the agent output schema (schema inlined).
- `messages`: one user message containing the canonical JSON of `modelInput`
  (`goal`, `input`, and `toolResult` when present, labeled as the result of the
  previous governed tool call).

No hidden chain-of-thought is requested or persisted; the emission surface
remains `tool_call | final`.

### A3. Tool advertisement without executable authority

Build the AI SDK `tools` map from `ModelAgentContext.tools` using
`jsonSchema(inputJsonSchema)` and the tool description, **without `execute`
callbacks**, so the AI SDK returns tool calls to the caller instead of running
anything. Tool names presented to the provider are the Pactmark tool ids; the
adapter keeps a name → `toolRegistrationDigest` map. This preserves the
existing invariant that the AI SDK never receives executable Pactmark tools.

### A4. Emission mapping

Consume `streamText().fullStream` instead of `textStream`:

- `tool-call` part → yield
  `{type: "tool_call", value: {toolRegistrationDigest, input: args,
targetDigest: digestCanonicalJson(args)}}` and stop consuming the stream
  (one emission per invocation, matching the kernel's single-emission read at
  `packages/runtime/src/runtime.ts:2641`).
- A tool name outside the advertised map → throw
  `KAF_MODEL_EMISSION_INVALID`-class error (non-retryable); the kernel records
  the failure. The adapter never guesses a digest for an unknown name.
- Stream finish without a tool call → parse accumulated text with the existing
  `parseOutput` and yield `final`.
- `input_request` remains unused by this adapter.

The adapter-computed `targetDigest` is legitimate because the kernel discards
it as authority (Section 2); a schema-valid digest is required only for the
wire contract.

### A5. Resource enforcement extension

Existing byte/event counters extend to `fullStream` parts: every part counts
toward `maxStreamEventsPerCall`; text deltas count toward output byte caps;
tool-call arguments are serialized canonically and counted toward the same
output byte caps before the emission is yielded. Abort propagation is
unchanged.

### A6. Version guard: exact pin → tested range

Replace the equality check (`aiPackage.version !== "7.0.48"` throwing
`KAF_MODEL_ADAPTER_MISMATCH`) with a tested-range guard (`>=7.0.48 <8`), and
record the **actually installed** AI SDK version in the adapter registration
material so the registration digest continues to identify the true artifact.
The peer range in `package.json` and the guard stay in lockstep. Rationale:
`ai` is a peer dependency; an exact-version throw makes any consumer lockfile
drift a hard startup failure, which is a supply-chain posture the digest
binding already provides more honestly. This is a deliberate,
maintainer-approvable loosening; if rejected, all other workstream items stand
with the exact pin retained.

### A7. Tests (deterministic, no live keys, per AGENTS.md)

Using `MockLanguageModelV3` fixtures in `packages/ai-sdk`:

- tool-call part → correct `tool_call` emission with digest mapping;
- unknown tool name → non-retryable failure, no emission;
- text finish → `final` with JSON parse and plain-text fallback;
- stream caps across mixed parts (text + tool-call) enforced;
- abort before/mid-stream;
- version-range guard acceptance and rejection;
- **end-to-end**: a facade agent compiled with `fromAISDK(mockModel)` completes
  `RunAccepted → ToolCallRequested → ToolCallCompleted →
VerificationRecorded(pass) → RunCompleted` through `createLocalRuntime`,
  proving the governed loop with a provider-shaped driver. A policy-denial
  variant proves the deny path with the same driver.

## 5. Workstream B — `@pactmark/agent`: defaults, `run()`, and write tools

Design rule for every default: **defaults may only narrow or preserve
authority, never widen it.** Anything consequential (risk class of a write,
compensation declaration, approval-requiring classes) remains explicit.

### B1. `defineTool` ergonomics

- Accept raw Zod schemas for `input`/`output`; auto-wrap with `defineSchema`
  using ids derived from the tool id (`<toolId>.input@<semanticRevision 1>`),
  while still accepting pre-built `DefinedSchema` values unchanged.
- Defaults (all overridable): `implementationVersion: "1.0.0"`;
  `security.dataClasses: ["public"]`; `security.egress: {mode: "none"}`;
  `security.networkEnforcement: "declared_ok"`; `security.maxCallsPerRun: 3`;
  `security.timeoutMs: 10_000`; `security.reversibility` defaults to
  `"not_applicable"` for reads only; `resources` defaults to the tenant scope
  extractor (the exact scope the minimal example hand-writes today).
- `security.riskClass` stays **required for writes**; reads default to `"R1"`.
- `security.requiredScopes` stays required (explicit capability naming is the
  point of the framework).

### B2. `defineAgent` ergonomics

- `instructions` accepts a plain string (auto `defineInstructions`).
- `input`/`output` accept raw Zod schemas (auto `defineSchema` with ids
  derived from the agent id).
- `policy` optional; the generated default policy is
  `default: "deny"` + `allow_with_grant` for `R0` and `R1` **only**. Any tool
  of `R2+` in the agent with the default policy fails composition with a clear
  error naming the missing rule — a write tool always forces a hand-written
  policy line.
- `verifiers` defaults to `["schema@1"]`.
- `description` defaults to the agent id (kept, since the field is required in
  the registration contract).

### B3. `fromAISDK` default profiles

`securityProfile`/`resourceProfile` become optional. Generated defaults:

- security profile id `ai-sdk.<provider>.<modelId>@preview`, provider/model
  from the model instance, `allowedTenants: ["local"]`,
  `allowedPurposes: ["service_delivery"]`, `allowedDataClasses: ["public"]`,
  `retention/logging/training: "none"` claims replaced by honest
  `"unreviewed"`-style markers where the schema allows, and
  `contractReference: "unreviewed-local-preview"` — the profile is explicitly a
  local-preview statement, not a provider-terms attestation;
- resource profile with the minimal example's conservative caps as the
  baseline.

Explicit profiles keep priority; `credentialMode` remains `"ambient_preview"`.

### B4. `createLocalRuntime` and `run()`

- `authorityIssuer` becomes optional; when omitted the facade constructs a
  `createLocalAuthorityIssuer()` internally (local ephemeral profile only).
- New `run(agent, options)` convenience on `LocalRuntimeFacade`:
  `options = {goal, input, tenantId?, principalId?, budget?, signal?}`.
  It issues local authority, builds the `WorkOrderRequest` with defaults
  (purpose `service_delivery`, dataClass `public`, retention `session`,
  work/autonomy `assist`, decision owner `requesting_principal`, risk context
  `low`, `requestedCapabilities` = union of the agent's tools'
  `requiredScopes`, tenant resource-scope ceiling, budget default
  `{maxTurns: 8, maxModelCalls: 8, maxToolCalls: 8,
maxActiveExecutionMs: 60_000}`), creates the command context, starts, waits,
  and returns `{runId, status, output, events, artifacts, evidence,
projection}` where `output` is the parsed final artifact content on
  `completed` runs.
- Capability derivation note: deriving `requestedCapabilities` from the tool
  set is acceptable **only** in this ephemeral local profile because the scope
  universe is exactly the agent's declared tools; the production path keeps
  explicit capability requests. Documented in the function's reference page.

### B5. Write tools in the facade

`defineTool` accepts:

```ts
operation: {
  kind: "write";
  execute(input, context): Promise<output>;
  reversibility: "compensatable" | "irreversible";
}
```

The facade generates, per write tool:

- an executable effect strategy of kind `"none"` wrapping `execute`, producing
  a schema-validated `EffectExecutionResult` with a correctly bound
  `EffectAcknowledgement` (binding fields and `proofDigest` per
  `packages/runtime/src/effects.ts:188`);
- a deterministic preview whose `normalizedTarget` is
  `{schemaVersion: "1", resources: <policy-normalized resources>}` computed
  with the same normalization the policy applies, so
  `digestCanonicalJson(preview.normalizedTarget)` equals the policy's
  `normalizedTargetDigest`; `previewStrategyRegistrationDigest` is added to the
  tool registration;
- registration metadata (`effectStrategyKind: "write"` per the contract's
  vocabulary for non-read strategies, matching what the kernel compares at
  `packages/runtime/src/runtime.ts:3298`).

`createLocalRuntime` wires `RuntimeEffectServices` from
`createMemoryStoreSuite` (effect ledger + acknowledged results) plus a
facade-local `RuntimeEffectAuthorizationResolver` that issues correctly bound,
short-expiry `AuthorizationReservation`s for the ephemeral profile. Risk
gating: R2 writes and R3 compensatable writes run locally under
`allow_with_grant` policy rules; R3 requires the tool to declare
`reversibility: "compensatable"` (schema-enforced); R4/R5 continue to fail
closed locally (`require_approval` → deny, unchanged).

Facade-level guard: composing an agent that owns a write tool while the
runtime lacks effect services fails at `createLocalRuntime` construction with
a named error, not at first dispatch.

### B6. Tests

- Digest-equivalence: a tool/agent built with defaults produces byte-identical
  registration digests to the same tool/agent built with the explicit
  equivalents (proves defaults are sugar, not semantic drift).
- `run()` happy path, budget-exceeded path, cancellation path.
- Write tool end-to-end on memory stores: `EffectPrepared → EffectDispatched →
EffectAcknowledged → ToolCallCompleted → … → RunCompleted`, with the effect
  ledger containing the bound record.
- Denials: R2 write under default policy (composition error); write with
  mismatched preview target (policy denial); write replay across a simulated
  crash boundary re-serves the acknowledged result without re-dispatch
  (memory-store variant of the existing kernel crash tests).
- Malformed input, concurrency (duplicate `run()` on one agent), and packed
  consumer acceptance via the existing `tests/consumer` fixtures.

## 6. Workstream C — examples and documentation

- New `examples/quickstart-agent`: the ~30-line surface (raw Zod, string
  instructions, default policy, `runtime.run(...)`). Offline-deterministic by
  default via a mock provider model; when `AI_GATEWAY_API_KEY` (or an explicit
  provider key) is present, the same file runs against a live provider through
  the AI SDK. CI keeps running it offline (`test:examples` stays hermetic).
- New or extended example demonstrating one governed **write** tool with a
  policy line, showing `EffectAcknowledged` in the event log.
- `examples/minimal-tool-agent` is kept as the fully explicit reference and
  cross-linked as "the same agent without defaults".
- Documentation updates: `docs/getting-started/first-agent.md` (new quickstart
  path), `docs/guides/model-adapters.md` (tool advertisement, emission mapping,
  version-range guard, what the adapter still refuses to do),
  `docs/concepts/tools-risk-and-capability-grants.md` (facade write tools,
  which defaults exist and what they never default). Turkish parity updates for
  every changed page listed in `docs/translations.json`. README "Start in 60
  seconds" and the essential-shape snippet refresh once the new surface exists.

## 7. Compatibility and digest impact

- All changes are additive; every existing explicit call site compiles and
  produces identical digests.
- New-style (defaulted) definitions materialize the defaults into the same
  registration material as explicit values — digests remain deterministic and
  environment-independent, except the AI SDK adapter registration digest,
  which now (deliberately) reflects the installed `ai` version.
- `@pactmark/agent` public API grows; `api:check` reports for `agent` (and
  `core` if the facade context type lands there — preference: keep it in
  `agent`) are regenerated in the same change.

## 8. Verification gates

Per-package `pnpm --filter <pkg> test` + `typecheck` during development; then:

1. `pnpm check` (format, lint, strict types, unit),
2. `pnpm verify:ci` (integration, packed consumers, portability — confirms no
   `ai` import leaks toward the kernel — examples, boundaries, placeholders,
   API reports, security suite),
3. targeted `test:examples` for the new quickstart in offline mode.

Any live-provider smoke run happens only with an explicitly provided key and
is reported separately from the deterministic evidence, never as a CI claim.

## 9. Risks and mitigations

| Risk                                                                     | Mitigation                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider emits malformed/hallucinated tool args                          | Kernel already re-validates via host resolver; adapter maps only advertised names; everything else fails closed.                                              |
| Provider ignores the JSON-output contract                                | `schema@1` verifier fails the run — honest failure, surfaced in docs as expected behavior, with instruction-text guidance.                                    |
| Kernel context carries only the last tool result                         | Documented limitation in the model-adapters guide; multi-tool chains beyond one hop degrade; kernel change explicitly out of scope.                           |
| Facade-generated effect acknowledgement drifts from kernel binding rules | Binding/proof construction is covered by dedicated unit tests mirroring `validateEffectExecution`'s expectations, plus the end-to-end write test.             |
| Default profiles read as provider-terms claims                           | Profile ids and `contractReference` are explicitly marked unreviewed-preview; docs state the host owns real provider-terms review.                            |
| Version-range guard admits an incompatible future `ai` 7.x               | Range upper-bounded at `<8`; adapter tests run against the pinned dev version; the registration digest records the actual version, keeping evidence truthful. |

## 10. Sequencing

1. **A1 + B3** (binding contract, default profiles) — unblocks everything.
2. **A2–A5, A7** (adapter tool loop + tests).
3. **B1, B2, B4** (defaults + `run()`), with digest-equivalence tests.
4. **B5, B6** (write tools + effect wiring).
5. **C** (examples, docs EN/TR, README), then **A6** (version-range guard) and
   API report regeneration, then full gate run (Section 8).

Each step lands only with its tests; no step marks a gate complete without the
observable command output, per `AGENTS.md`.

## 11. Implementation addendum (2026-08-15)

Three deviations from the proposal above were made during implementation, each
narrower or more honest than the planned text:

1. **One kernel correction, despite Section 3.** `validateEffectExecution`
   (`packages/runtime/src/effects.ts`) serialized `operationKey: undefined`
   into the canonical acknowledgement comparison, and the canonical encoder
   rejects undefined — so a kind-`"none"` effect strategy could never be
   acknowledged. Every previously tested strategy carried an operation key,
   which is why the defect stayed invisible. The fix omits the absent key on
   both sides of the comparison; behavior for keyed strategies is unchanged and
   a regression test now pins the keyless path.
2. **Facade write ceiling is R2, not R2+R3.** Section B5 planned dispatch-level
   R3 support. Because the local profile wires no compensation machinery,
   accepting a tool that claims `compensatable` at R3 would overstate what the
   runtime can honor, so `defineTool` rejects R3+ writes with an error that
   points to kernel-level composition.
3. **The live-provider path is a documented two-line swap, not an env-gated
   branch.** Section C planned an `AI_GATEWAY_API_KEY` runtime switch; that
   would add an optional gateway dependency and a hidden network path to a CI
   example. `examples/quickstart-agent` stays hermetic with a provider-shaped
   deterministic model and documents the exact swap to any AI SDK v7 provider
   instance.
