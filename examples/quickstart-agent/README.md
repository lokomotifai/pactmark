# Quickstart agent

The shortest governed Pactmark agent: raw Zod schemas, string instructions,
default local policy, and `runtime.run(...)` — about thirty lines in
[`src/agent.ts`](src/agent.ts). A provider-shaped model proposes a tool call
through `@pactmark/ai-sdk`; the proposal still crosses schema validation,
policy, capability, and dispatch boundaries before the tool executes, and the
run ends with a verified artifact and an evidence record.

The example is deterministic and needs no model key: the model in
[`src/model.ts`](src/model.ts) speaks the exact AI SDK provider protocol a live
provider uses. [`src/records-agent.ts`](src/records-agent.ts) adds one governed
R2 **write** tool with an explicit policy rule — the effect crosses a
deterministic preview, a one-use capability grant, and the effect ledger, and
the event log shows `EffectPrepared → EffectDispatched → EffectAcknowledged`.

```sh
pnpm --filter pactmark-example-quickstart test
pnpm --filter pactmark-example-quickstart dev
```

## Run against a live provider

The required test and development commands never make a live call. The separate
`smoke:live` command is fail-closed unless it receives an explicit opt-in,
provider module, provider export, model ID, and the provider's own credential.
Install the AI SDK v7 provider package you intend to test, then run, for example:

```text
pnpm --filter pactmark-example-quickstart add @ai-sdk/anthropic
PACTMARK_ENABLE_LIVE_PROVIDER=1 \
PACTMARK_LIVE_PROVIDER_MODULE=@ai-sdk/anthropic \
PACTMARK_LIVE_PROVIDER_EXPORT=anthropic \
PACTMARK_LIVE_MODEL_ID='<reviewed-model-id>' \
ANTHROPIC_API_KEY='<secret>' \
pnpm --filter pactmark-example-quickstart smoke:live
```

The smoke command reports only provider/model identity, stable event names, and
whether evidence was produced; it does not print the credential or raw provider
errors. Tools remain schema-only advertisements to the provider, the host
revalidates every proposed input, and the smoke fails unless the provider calls
the governed lookup tool and the final output passes verification. Default
model profiles are explicit `unreviewed-local-preview` claims — this is an
opt-in integration observation, not required CI evidence or production
readiness. A production host must review provider terms and pass its own
profiles.

The full explicit form of the same agent — every capability, profile, policy,
and budget spelled out — is
[`examples/minimal-tool-agent`](../minimal-tool-agent/).
