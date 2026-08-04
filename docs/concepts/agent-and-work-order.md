---
title: Agent and WorkOrder
description: Separate reusable agent definition from authorized work acceptance.
---

> Compatibility: Pactmark 0.1.x.

## AgentDefinition

An `AgentDefinition` compiles instructions, schemas, tools, model profiles, policy,
and verifiers into versioned identities. Registration digests make same-version
behavior drift observable and reject unsafe resume.

## WorkOrder

A `WorkOrder` identifies tenant, principal, purpose, input, budgets, deadline, and
the exact accepted definition. External input remains `unknown` until its runtime
schema succeeds.

## Authority boundary

The model may propose content and tool requests. It cannot create a grant, approval,
credential, budget, schema result, or effect acknowledgement. Those decisions are
resolved by injected host ports and persisted bindings.
