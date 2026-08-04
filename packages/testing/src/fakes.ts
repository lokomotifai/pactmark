import {
  digestCanonicalJson,
  JsonValueSchema,
  RuntimeCapabilitiesSchema,
  ToolRegistrationContractSchema,
  type Digest,
  type JsonValue,
  type ModelDriver,
  type Run,
  type RuntimeCapabilities,
  type ToolExecutor,
  type ToolRegistrationContract,
} from "@pactmark/core";

import type { CrashInjector } from "./crash.js";

export const TEST_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze(
  RuntimeCapabilitiesSchema.parse({
    schemaVersion: "1",
    executionProfile: "ephemeral",
    durableStorage: false,
    protectedContext: false,
    protectedWorkOrders: false,
    protectedInputSubmissions: false,
    streaming: true,
    cancellation: true,
    sandbox: "unsafe_local",
    networkPolicy: "none",
    backgroundWakeup: false,
    atomicCommandAndWakeup: false,
    humanDecisions: false,
    typedInput: true,
    effectReconciliation: false,
    compensation: false,
    modelCredentials: false,
    toolCredentials: false,
    telemetry: "none",
    transactionDomains: ["testing.process-local"],
  }),
);

export interface FakeModelChunk {
  readonly type: string;
  readonly value: JsonValue;
}

export type FakeModelTurn =
  | Readonly<{ chunks: readonly FakeModelChunk[]; error?: never }>
  | Readonly<{ chunks?: never; error: unknown }>;

export interface FakeModelInvocation {
  readonly index: number;
  readonly run: Run;
  readonly input: JsonValue;
}

export interface FakeModelDriverOptions {
  readonly turns?: readonly FakeModelTurn[];
  readonly capabilities?: RuntimeCapabilities;
  readonly crashInjector?: CrashInjector;
}

/** A finite, scripted model. Each invocation consumes exactly one turn. */
export class FakeModelDriver implements ModelDriver {
  readonly capabilities: RuntimeCapabilities;
  readonly #turns: FakeModelTurn[];
  readonly #crashInjector: CrashInjector | undefined;
  readonly #invocations: FakeModelInvocation[] = [];

  constructor(options: FakeModelDriverOptions = {}) {
    this.capabilities = RuntimeCapabilitiesSchema.parse(
      options.capabilities ?? TEST_RUNTIME_CAPABILITIES,
    );
    this.#turns = [...(options.turns ?? [])];
    this.#crashInjector = options.crashInjector;
  }

  enqueue(turn: FakeModelTurn): void {
    this.#turns.push(turn);
  }

  invocations(): readonly FakeModelInvocation[] {
    return this.#invocations.map((invocation) => structuredClone(invocation));
  }

  remainingTurns(): number {
    return this.#turns.length;
  }

  async *invoke(request: Readonly<{ run: Run; input: JsonValue; signal: AbortSignal }>) {
    await Promise.resolve();
    assertNotAborted(request.signal);
    const index = this.#invocations.length;
    this.#invocations.push({
      index,
      run: structuredClone(request.run),
      input: structuredClone(request.input),
    });
    this.#crashInjector?.hit("model.before_invoke");
    const turn = this.#turns.shift();
    if (turn === undefined) {
      throw new FakeInvocationError("KAF_TESTING_MODEL_SCRIPT_EXHAUSTED");
    }
    if ("error" in turn) throw turn.error;

    for (const chunk of turn.chunks) {
      assertNotAborted(request.signal);
      this.#crashInjector?.hit("model.before_chunk");
      yield { type: chunk.type, value: structuredClone(chunk.value) };
      this.#crashInjector?.hit("model.after_chunk");
    }
    assertNotAborted(request.signal);
    this.#crashInjector?.hit("model.after_invoke");
  }
}

export interface FakeToolCall {
  readonly index: number;
  readonly input: JsonValue;
}

export type FakeToolHandler = (
  input: JsonValue,
  signal: AbortSignal,
) => JsonValue | Promise<JsonValue>;

export interface FakeToolOptions {
  readonly registration: ToolRegistrationContract;
  readonly handler?: FakeToolHandler;
  readonly crashInjector?: CrashInjector;
}

/** A registered deterministic tool implementation with observable calls. */
export class FakeTool {
  readonly registration: ToolRegistrationContract;
  readonly #handler: FakeToolHandler;
  readonly #crashInjector: CrashInjector | undefined;
  readonly #calls: FakeToolCall[] = [];

  constructor(options: FakeToolOptions) {
    this.registration = ToolRegistrationContractSchema.parse(options.registration);
    this.#handler = options.handler ?? ((input) => input);
    this.#crashInjector = options.crashInjector;
  }

  calls(): readonly FakeToolCall[] {
    return this.#calls.map((call) => structuredClone(call));
  }

  async execute(input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    assertNotAborted(signal);
    this.#calls.push({ index: this.#calls.length, input: structuredClone(input) });
    this.#crashInjector?.hit("tool.before_execute");
    const result = await this.#handler(structuredClone(input), signal);
    assertNotAborted(signal);
    this.#crashInjector?.hit("tool.after_execute");
    return structuredClone(result);
  }
}

export interface FakeToolExecutorOptions {
  readonly tools?: readonly FakeTool[];
  readonly capabilities?: RuntimeCapabilities;
}

/** An exact-registration fake dispatcher; unknown or drifted registrations fail closed. */
export class FakeToolExecutor implements ToolExecutor {
  readonly capabilities: RuntimeCapabilities;
  readonly networkPolicy = "none" as const;
  readonly #tools = new Map<string, FakeTool>();

  constructor(options: FakeToolExecutorOptions = {}) {
    this.capabilities = RuntimeCapabilitiesSchema.parse(
      options.capabilities ?? TEST_RUNTIME_CAPABILITIES,
    );
    if (this.capabilities.networkPolicy !== this.networkPolicy) {
      throw new FakeInvocationError("KAF_TESTING_NETWORK_POLICY_MISMATCH");
    }
    for (const tool of options.tools ?? []) this.register(tool);
  }

  register(tool: FakeTool): void {
    const key = registrationKey(tool.registration);
    if (this.#tools.has(key)) {
      throw new FakeInvocationError("KAF_TESTING_TOOL_ALREADY_REGISTERED");
    }
    this.#tools.set(key, tool);
  }

  async execute(
    request: Readonly<{
      registration: ToolRegistrationContract;
      input: JsonValue;
      signal: AbortSignal;
    }>,
  ): Promise<JsonValue> {
    assertNotAborted(request.signal);
    const registration = ToolRegistrationContractSchema.parse(request.registration);
    const input = JsonValueSchema.parse(request.input);
    const tool = this.#tools.get(registrationKey(registration));
    if (tool === undefined) throw new FakeInvocationError("KAF_TESTING_TOOL_NOT_REGISTERED");
    return JsonValueSchema.parse(await tool.execute(input, request.signal));
  }
}

export interface CreateFakeToolRegistrationOptions {
  readonly id?: string;
  readonly implementationVersion?: string;
  readonly description?: string;
  readonly riskClass?: "R0" | "R1";
  readonly effectStrategyKind?: "read" | "none";
  readonly maxCallsPerRun?: number;
  readonly timeoutMs?: number;
}

export function createFakeToolRegistration(
  options: CreateFakeToolRegistrationOptions = {},
): ToolRegistrationContract {
  const id = options.id ?? "testing.echo@1";
  const implementationVersion = options.implementationVersion ?? "1.0.0";
  const effectStrategyKind = options.effectStrategyKind ?? "read";
  const material = {
    schemaVersion: "1" as const,
    id,
    implementationVersion,
    description: options.description ?? "Deterministic Pactmark test tool",
    inputSchemaDigest: seededDigest(`${id}:input`),
    outputSchemaDigest: seededDigest(`${id}:output`),
    security: {
      schemaVersion: "1" as const,
      riskClass: options.riskClass ?? "R0",
      dataClasses: ["public", "internal"] as const,
      reversibility: "not_applicable" as const,
      requiredScopes: [] as readonly string[],
      egress: { mode: "none" as const },
      networkEnforcement: "declared_ok" as const,
      maxCallsPerRun: options.maxCallsPerRun ?? 10,
      timeoutMs: options.timeoutMs ?? 1_000,
    },
    effectStrategyKind,
    effectStrategyRegistrationDigest: seededDigest(`${id}:effect:${effectStrategyKind}`),
    executorKind: "pactmark.testing.fake",
    executorVersion: "1",
  };
  return ToolRegistrationContractSchema.parse({
    ...material,
    toolRegistrationDigest: digestCanonicalJson(material),
  });
}

export type FakeInvocationErrorCode =
  | "KAF_TESTING_MODEL_SCRIPT_EXHAUSTED"
  | "KAF_TESTING_NETWORK_POLICY_MISMATCH"
  | "KAF_TESTING_TOOL_ALREADY_REGISTERED"
  | "KAF_TESTING_TOOL_NOT_REGISTERED";

export class FakeInvocationError extends Error {
  readonly code: FakeInvocationErrorCode;

  constructor(code: FakeInvocationErrorCode) {
    super(code);
    this.name = "FakeInvocationError";
    this.code = code;
  }
}

function registrationKey(registration: ToolRegistrationContract): string {
  return `${registration.id}\u0000${registration.implementationVersion}\u0000${registration.toolRegistrationDigest}`;
}

function seededDigest(seed: string): Digest {
  return digestCanonicalJson({ seed });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}
