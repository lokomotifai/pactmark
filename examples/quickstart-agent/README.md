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

Replace the fixture in `src/model.ts` with any AI SDK v7 model instance, for
example:

```ts
import { anthropic } from "@ai-sdk/anthropic";
export const model = () => anthropic("claude-sonnet-4-5");
```

Nothing else changes: tools remain schema-only advertisements to the provider,
the host revalidates every proposed input, and a final answer that does not
match the output schema fails verification instead of completing the run.
Default model profiles are explicit `unreviewed-local-preview` claims — a
production host must review provider terms and pass its own profiles.

The full explicit form of the same agent — every capability, profile, policy,
and budget spelled out — is
[`examples/minimal-tool-agent`](../minimal-tool-agent/).
