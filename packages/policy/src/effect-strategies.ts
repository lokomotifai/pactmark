import {
  EffectPreviewSchema,
  ToolRegistrationContractSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type Digest,
  type EffectBinding,
  type EffectExecutionResult,
  type EffectPreview,
  type JsonValue,
  type PreviewContext,
  type PreviewStrategy,
  type ToolExecutionContext,
  type ToolRegistrationContract,
} from "@pactmark/core";

export class EffectRegistrationError extends TypeError {
  readonly code = "KAF_POLICY_EFFECT_STRATEGY_REQUIRED" as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = "EffectRegistrationError";
  }
}

export class PreviewExecutionError extends Error {
  readonly code = "KAF_POLICY_PREVIEW_REQUIRED" as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = "PreviewExecutionError";
  }
}

type RegisteredPreview<I extends JsonValue> = PreviewStrategy<I> & {
  readonly registrationDigest: Digest;
};

type RegisteredStrategyBase = {
  readonly registrationDigest: Digest;
};

export type ExecutableEffectStrategy<I extends JsonValue, O extends JsonValue> =
  | (RegisteredStrategyBase & {
      readonly kind: "read";
      execute(input: I, context: ToolExecutionContext): Promise<O>;
    })
  | (RegisteredStrategyBase & {
      readonly kind: "native";
      readonly preview: RegisteredPreview<I>;
      operationKey(input: I, binding: EffectBinding): string;
      dispatch(input: I, key: string, context: unknown): Promise<EffectExecutionResult>;
    })
  | (RegisteredStrategyBase & {
      readonly kind: "transactional";
      readonly preview: RegisteredPreview<I>;
      readonly coordinatorId: string;
      execute(input: I, context: unknown): Promise<EffectExecutionResult>;
    })
  | (RegisteredStrategyBase & {
      readonly kind: "reconcilable";
      readonly preview: RegisteredPreview<I>;
      operationKey(input: I, binding: EffectBinding): string;
      lookup(
        key: string,
        context: unknown,
      ): Promise<
        | { readonly status: "applied"; readonly execution: EffectExecutionResult }
        | { readonly status: "not_applied" }
        | { readonly status: "unknown" }
      >;
      dispatch(input: I, key: string, context: unknown): Promise<EffectExecutionResult>;
    })
  | (RegisteredStrategyBase & {
      readonly kind: "none";
      readonly preview: RegisteredPreview<I>;
      dispatch(input: I, context: unknown): Promise<EffectExecutionResult>;
    });

export type TransactionCoordinatorProof = Readonly<{
  coordinatorId: string;
  registrationDigest: Digest;
  transactionDomain: string;
  authorizationDomain: string;
  targetMutationDomain: string;
  commitsAuthorizationReservation: true;
  commitsAcknowledgedEffect: true;
  commitsValidatedResult: true;
}>;

export type CompensationStrategyRegistration<
  O extends JsonValue,
  CInput extends JsonValue,
> = Readonly<{
  id: string;
  implementationVersion: string;
  registrationDigest: Digest;
  inputSchemaDigest: Digest;
  compensationTool: Readonly<{
    id: string;
    version: string;
    toolRegistrationDigest: Digest;
  }>;
  deriveInput(original: Readonly<{ acknowledgementDigest: Digest; result: O }>): CInput;
}>;

export type EffectRegistrationInput<I extends JsonValue, O extends JsonValue> = Readonly<{
  tool: ToolRegistrationContract;
  strategy: ExecutableEffectStrategy<I, O>;
  coordinatorProof?: TransactionCoordinatorProof;
  compensation?: CompensationStrategyRegistration<O, JsonValue>;
  compensationTool?: ToolRegistrationContract;
}>;

export type ValidatedEffectRegistration = Readonly<{
  toolId: string;
  toolRegistrationDigest: Digest;
  strategyKind: ToolRegistrationContract["effectStrategyKind"];
  strategyRegistrationDigest: Digest;
  previewStrategyRegistrationDigest?: Digest;
  compensationStrategyRegistrationDigest?: Digest;
  transactionCoordinatorRegistrationDigest?: Digest;
}>;

function assertMethod(value: object, key: string, label: string): void {
  if (typeof Reflect.get(value, key) !== "function") {
    throw new EffectRegistrationError(`${label} must be an executable callback`);
  }
}

function validatePreviewBinding<I extends JsonValue>(
  tool: ToolRegistrationContract,
  preview: RegisteredPreview<I>,
): void {
  if (
    tool.previewStrategyRegistrationDigest === undefined ||
    preview.registrationDigest !== tool.previewStrategyRegistrationDigest
  ) {
    throw new EffectRegistrationError("Preview registration digest does not match the tool");
  }
  if (preview.id.length === 0 || preview.implementationVersion.length === 0) {
    throw new EffectRegistrationError("Preview identity is incomplete");
  }
  assertMethod(preview, "render", "preview.render");
}

function validateCompensation<O extends JsonValue>(
  tool: ToolRegistrationContract,
  compensation: CompensationStrategyRegistration<O, JsonValue> | undefined,
  compensationToolInput: ToolRegistrationContract | undefined,
): Digest | undefined {
  if (tool.security.reversibility !== "compensatable") {
    if (compensation !== undefined || tool.compensationStrategyRegistrationDigest !== undefined) {
      throw new EffectRegistrationError("Only compensatable tools may bind compensation");
    }
    return undefined;
  }
  if (
    compensation === undefined ||
    compensationToolInput === undefined ||
    tool.compensationStrategyRegistrationDigest !== compensation.registrationDigest
  ) {
    throw new EffectRegistrationError("Compensation strategy and separate tool are required");
  }
  const compensationTool = ToolRegistrationContractSchema.parse(compensationToolInput);
  if (
    compensation.compensationTool.id !== compensationTool.id ||
    compensation.compensationTool.version !== compensationTool.id.split("@").at(-1) ||
    compensation.compensationTool.toolRegistrationDigest !== compensationTool.toolRegistrationDigest
  ) {
    throw new EffectRegistrationError("Compensation tool identity does not match its registration");
  }
  if (compensationTool.id === tool.id || compensationTool.effectStrategyKind === "read") {
    throw new EffectRegistrationError("Compensation must use a separate write tool");
  }
  if (compensationTool.security.reversibility === "compensatable") {
    throw new EffectRegistrationError("Recursive compensation is not supported in v0.1");
  }
  assertMethod(compensation, "deriveInput", "compensation.deriveInput");
  return compensation.registrationDigest;
}

export function validateEffectStrategyRegistration<I extends JsonValue, O extends JsonValue>(
  input: EffectRegistrationInput<I, O>,
): ValidatedEffectRegistration {
  const tool = ToolRegistrationContractSchema.parse(input.tool);
  const strategy = input.strategy;
  if (
    strategy.kind !== tool.effectStrategyKind ||
    strategy.registrationDigest !== tool.effectStrategyRegistrationDigest
  ) {
    throw new EffectRegistrationError("Executable strategy identity does not match the tool");
  }

  if (strategy.kind === "read") {
    if (
      tool.security.riskClass === "R3" ||
      tool.security.riskClass === "R4" ||
      tool.security.riskClass === "R5" ||
      tool.security.reversibility !== "not_applicable" ||
      tool.previewStrategyRegistrationDigest !== undefined
    ) {
      throw new EffectRegistrationError("Read strategies are limited to non-mutating R0-R2 tools");
    }
    assertMethod(strategy, "execute", "read.execute");
    validateCompensation(tool, input.compensation, input.compensationTool);
    return Object.freeze({
      toolId: tool.id,
      toolRegistrationDigest: tool.toolRegistrationDigest,
      strategyKind: strategy.kind,
      strategyRegistrationDigest: strategy.registrationDigest,
    });
  }

  validatePreviewBinding(tool, strategy.preview);
  if (tool.security.riskClass === "R0" || tool.security.riskClass === "R1") {
    throw new EffectRegistrationError("State-changing strategies cannot claim R0 or R1");
  }
  if (tool.security.reversibility === "not_applicable") {
    throw new EffectRegistrationError("A write strategy must declare effect reversibility");
  }

  let coordinatorDigest: Digest | undefined;
  switch (strategy.kind) {
    case "native":
      assertMethod(strategy, "operationKey", "native.operationKey");
      assertMethod(strategy, "dispatch", "native.dispatch");
      break;
    case "transactional": {
      assertMethod(strategy, "execute", "transactional.execute");
      const proof = input.coordinatorProof;
      if (
        proof === undefined ||
        proof.coordinatorId !== strategy.coordinatorId ||
        proof.transactionDomain === "" ||
        proof.transactionDomain !== proof.authorizationDomain ||
        proof.transactionDomain !== proof.targetMutationDomain ||
        tool.security.egress.mode !== "none"
      ) {
        throw new EffectRegistrationError(
          "Transactional strategy lacks same-domain coordinator proof",
        );
      }
      coordinatorDigest = proof.registrationDigest;
      break;
    }
    case "reconcilable":
      assertMethod(strategy, "operationKey", "reconcilable.operationKey");
      assertMethod(strategy, "lookup", "reconcilable.lookup");
      assertMethod(strategy, "dispatch", "reconcilable.dispatch");
      break;
    case "none":
      assertMethod(strategy, "dispatch", "none.dispatch");
      break;
  }

  const compensationDigest = validateCompensation(tool, input.compensation, input.compensationTool);
  return Object.freeze({
    toolId: tool.id,
    toolRegistrationDigest: tool.toolRegistrationDigest,
    strategyKind: strategy.kind,
    strategyRegistrationDigest: strategy.registrationDigest,
    previewStrategyRegistrationDigest: strategy.preview.registrationDigest,
    ...(compensationDigest === undefined
      ? {}
      : { compensationStrategyRegistrationDigest: compensationDigest }),
    ...(coordinatorDigest === undefined
      ? {}
      : { transactionCoordinatorRegistrationDigest: coordinatorDigest }),
  });
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJson(child)])),
    );
  }
  return value;
}

function previewMaterial(preview: EffectPreview): JsonValue {
  return {
    schemaVersion: preview.schemaVersion,
    normalizedTarget: preview.normalizedTarget,
    operationClass: preview.operationClass,
    contentDigest: preview.contentDigest,
    reversibility: preview.reversibility,
    materialConsequence: preview.materialConsequence,
    ...(preview.diffDigest === undefined ? {} : { diffDigest: preview.diffDigest }),
  };
}

export async function executeDeterministicPreview<I extends JsonValue>(input: {
  readonly strategy: RegisteredPreview<I>;
  readonly value: I;
  readonly context: PreviewContext;
  readonly expectedRegistrationDigest: Digest;
  readonly expectedReversibility: "compensatable" | "irreversible";
}): Promise<EffectPreview> {
  if (input.strategy.registrationDigest !== input.expectedRegistrationDigest) {
    throw new PreviewExecutionError("Preview registration digest mismatch");
  }
  const canonicalInput = canonicalJsonStringify(input.value);
  const makeValue = (): I => freezeJson(JSON.parse(canonicalInput) as JsonValue) as I;
  const context = Object.freeze({
    run: Object.freeze({ ...input.context.run }),
    normalizedTarget: Object.freeze({ ...input.context.normalizedTarget }),
    deterministicClock: Object.freeze({
      now: () => input.context.deterministicClock.now(),
      monotonicMilliseconds: () => input.context.deterministicClock.monotonicMilliseconds(),
    }),
  });
  let first: EffectPreview;
  let second: EffectPreview;
  try {
    first = EffectPreviewSchema.parse(await input.strategy.render(makeValue(), context));
    second = EffectPreviewSchema.parse(await input.strategy.render(makeValue(), context));
  } catch {
    throw new PreviewExecutionError("Preview callback failed or returned an invalid result");
  }
  const expectedDigest = digestCanonicalJson(previewMaterial(first));
  if (
    first.previewDigest !== expectedDigest ||
    first.normalizedTarget !== input.context.normalizedTarget.value ||
    first.reversibility !== input.expectedReversibility ||
    canonicalJsonStringify(first) !== canonicalJsonStringify(second)
  ) {
    throw new PreviewExecutionError("Preview output is unstable or does not match its binding");
  }
  return Object.freeze(first);
}
