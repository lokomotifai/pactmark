import type { JsonValue, ToolRegistrationContract } from "@pactmark/core";

import { CrashInjector, type CrashPlanEntry } from "./crash.js";
import { FakeClock, SequenceIdGenerator } from "./deterministic.js";
import {
  FakeModelDriver,
  FakeTool,
  FakeToolExecutor,
  createFakeToolRegistration,
  type FakeModelTurn,
  type FakeToolHandler,
} from "./fakes.js";

type ToolPlan = Readonly<{
  registration: ToolRegistrationContract;
  handler: FakeToolHandler;
}>;

export interface DeterministicScenario {
  readonly clock: FakeClock;
  readonly ids: SequenceIdGenerator;
  readonly crashes: CrashInjector;
  readonly model: FakeModelDriver;
  readonly tools: readonly FakeTool[];
  readonly toolExecutor: FakeToolExecutor;
}

/** Fluent assembly for independent deterministic runtime test fixtures. */
export class ScenarioBuilder {
  #now = "2026-01-01T00:00:00.000Z";
  #idPrefix = "scenario";
  readonly #turns: FakeModelTurn[] = [];
  readonly #tools: ToolPlan[] = [];
  readonly #crashes: CrashPlanEntry[] = [];

  at(instant: string): this {
    if (!Number.isFinite(Date.parse(instant))) throw new TypeError("Scenario instant is invalid");
    this.#now = new Date(Date.parse(instant)).toISOString();
    return this;
  }

  withIdPrefix(prefix: string): this {
    // Validation remains centralized in SequenceIdGenerator.
    void new SequenceIdGenerator({ prefix });
    this.#idPrefix = prefix;
    return this;
  }

  modelTurn(...chunks: readonly Readonly<{ type: string; value: JsonValue }>[]): this {
    this.#turns.push({ chunks: structuredClone(chunks) });
    return this;
  }

  modelError(error: unknown): this {
    this.#turns.push({ error });
    return this;
  }

  tool(registration: ToolRegistrationContract, handler: FakeToolHandler = (input) => input): this {
    this.#tools.push({ registration: structuredClone(registration), handler });
    return this;
  }

  echoTool(id = "testing.echo@1"): this {
    return this.tool(createFakeToolRegistration({ id }), (input) => input);
  }

  crashAt(boundary: string, occurrence = 1): this {
    this.#crashes.push({ boundary, occurrence });
    return this;
  }

  build(): DeterministicScenario {
    const crashes = new CrashInjector(this.#crashes);
    const tools = this.#tools.map(
      (tool) =>
        new FakeTool({
          registration: tool.registration,
          handler: tool.handler,
          crashInjector: crashes,
        }),
    );
    return Object.freeze({
      clock: new FakeClock({ now: this.#now }),
      ids: new SequenceIdGenerator({ prefix: this.#idPrefix }),
      crashes,
      model: new FakeModelDriver({ turns: this.#turns, crashInjector: crashes }),
      tools: Object.freeze(tools),
      toolExecutor: new FakeToolExecutor({ tools }),
    });
  }
}
