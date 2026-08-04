# @pactmark/runtime

Portable, provider-neutral orchestration for Pactmark runs. The runtime validates opaque authority before storage access, persists accepted WorkOrders separately from reference-only events, derives run state through the core reducer, and injects model, policy, tool, verifier, evidence, lease, artifact, transaction, and scheduling ports.

`createRuntime` requires a `RunCommandUnitOfWork`. Start/cancel/resume idempotency and every event transition cross that injected transaction boundary; no process-local command ledger is used. Durable background acceptance is rejected unless command mutation and wake-up enqueue are advertised as atomic. `InlineWakeupScheduler` is explicitly process-local and non-durable, retains only pending timers, and routes handler failures to an explicit host hook.

The deterministic model protocol accepts `tool_call` and `final` emissions. Tool execution is restricted to registered R0/R1 `read` tools and always follows registration, scope, risk, budget, and injected policy checks. The event stream replays from a sequence and polls the store with constant runtime memory until the run becomes terminal or the caller aborts.

This package does not provide a database, credential resolver, model-call quota implementation, protected input/decision store, policy rules, executor, or background worker. Interrupted boundaries without a durable context/checkpoint are parked instead of being repeated. `evaluateReadiness({ profile: "production" })` therefore fails honestly until the missing protected stores and bound model-call reservation/credential capabilities are supplied by later integration work; it does not infer production safety from package presence.
