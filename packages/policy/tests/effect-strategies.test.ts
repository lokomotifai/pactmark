import {
  ToolRegistrationContractSchema,
  digestCanonicalJson,
  type EffectPreview,
  type JsonValue,
  type PreviewContext,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import {
  EffectRegistrationError,
  PreviewExecutionError,
  executeDeterministicPreview,
  validateEffectStrategyRegistration,
  type ExecutableEffectStrategy,
} from "../src/index.js";
import { digest, makeTool } from "./fixtures.js";

type Input = { readonly value: string };
type Output = { readonly ok: boolean };
type NativeStrategy = Extract<ExecutableEffectStrategy<Input, Output>, { readonly kind: "native" }>;

const previewMaterial = {
  schemaVersion: "1" as const,
  normalizedTarget: "workspace/docs/result.md",
  operationClass: "document.write",
  contentDigest: digest("7"),
  reversibility: "irreversible" as const,
  materialConsequence: "Replaces the document visible to the tenant.",
};
const preview: EffectPreview = {
  ...previewMaterial,
  previewDigest: digestCanonicalJson(previewMaterial),
};

const context: PreviewContext = {
  run: {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "step-1",
    purposeCode: "service_delivery",
    dataClass: "public",
  },
  normalizedTarget: { value: preview.normalizedTarget, digest: digest("8") },
  deterministicClock: { now: () => "2026-08-03T10:00:00.000Z", monotonicMilliseconds: () => 0 },
};

function nativeStrategy(
  render: (input: Input, previewContext: PreviewContext) => Promise<EffectPreview> = () =>
    Promise.resolve(preview),
): NativeStrategy {
  return {
    kind: "native",
    registrationDigest: digest("e"),
    preview: {
      id: "document.preview@1",
      implementationVersion: "1.0.0",
      registrationDigest: digest("d"),
      render,
    },
    operationKey: (_input, binding) => binding.effectKey,
    dispatch: () => Promise.reject(new Error("not dispatched by registration validation")),
  };
}

describe("effect strategy registration", () => {
  it("accepts a complete read registration and rejects write metadata on read", () => {
    const tool = makeTool("R1");
    expect(
      validateEffectStrategyRegistration({
        tool,
        strategy: {
          kind: "read",
          registrationDigest: tool.effectStrategyRegistrationDigest,
          execute: () => Promise.resolve({ ok: true }),
        },
      }),
    ).toMatchObject({ strategyKind: "read" });
    expect(() =>
      validateEffectStrategyRegistration({
        tool: { ...tool, security: { ...tool.security, reversibility: "irreversible" } },
        strategy: {
          kind: "read",
          registrationDigest: tool.effectStrategyRegistrationDigest,
          execute: () => Promise.resolve({ ok: true }),
        },
      }),
    ).toThrow(EffectRegistrationError);
  });

  it("accepts native, reconcilable, none, and proved transactional strategies", () => {
    const nativeTool = ToolRegistrationContractSchema.parse({
      ...makeTool("R4"),
      security: { ...makeTool("R4").security, reversibility: "irreversible" },
    });
    expect(
      validateEffectStrategyRegistration({ tool: nativeTool, strategy: nativeStrategy() }),
    ).toMatchObject({ strategyKind: "native" });

    const reconcilableTool = ToolRegistrationContractSchema.parse({
      ...nativeTool,
      effectStrategyKind: "reconcilable",
    });
    expect(
      validateEffectStrategyRegistration({
        tool: reconcilableTool,
        strategy: {
          ...nativeStrategy(),
          kind: "reconcilable",
          lookup: () => Promise.resolve({ status: "unknown" }),
        },
      }),
    ).toMatchObject({ strategyKind: "reconcilable" });

    const noneTool = ToolRegistrationContractSchema.parse({
      ...nativeTool,
      effectStrategyKind: "none",
    });
    expect(
      validateEffectStrategyRegistration({
        tool: noneTool,
        strategy: {
          kind: "none",
          registrationDigest: digest("e"),
          preview: nativeStrategy().preview,
          dispatch: () => Promise.reject(new Error("not called")),
        },
      }),
    ).toMatchObject({ strategyKind: "none" });

    const transactionalTool = ToolRegistrationContractSchema.parse({
      ...nativeTool,
      effectStrategyKind: "transactional",
    });
    expect(
      validateEffectStrategyRegistration({
        tool: transactionalTool,
        strategy: {
          kind: "transactional",
          registrationDigest: digest("e"),
          preview: nativeStrategy().preview,
          coordinatorId: "coordinator-1",
          execute: () => Promise.reject(new Error("not called")),
        },
        coordinatorProof: {
          coordinatorId: "coordinator-1",
          registrationDigest: digest("a"),
          transactionDomain: "postgres-main",
          authorizationDomain: "postgres-main",
          targetMutationDomain: "postgres-main",
          commitsAuthorizationReservation: true,
          commitsAcknowledgedEffect: true,
          commitsValidatedResult: true,
        },
      }),
    ).toMatchObject({
      strategyKind: "transactional",
      transactionCoordinatorRegistrationDigest: digest("a"),
    });
  });

  it.each([
    "strategy_digest",
    "preview_digest",
    "missing_dispatch",
    "transaction_domain",
    "transaction_egress",
    "write_as_r1",
    "not_applicable_write",
  ])("fails closed for incomplete or falsely claimed strategy: %s", (failure) => {
    const baseTool = ToolRegistrationContractSchema.parse({
      ...makeTool("R4"),
      security: { ...makeTool("R4").security, reversibility: "irreversible" },
    });
    const tool =
      failure === "transaction_egress"
        ? ToolRegistrationContractSchema.parse({
            ...baseTool,
            effectStrategyKind: "transactional",
            security: {
              ...baseTool.security,
              egress: {
                mode: "allowlist",
                destinations: ["https://example.com"],
                methods: ["POST"],
                credentialSlots: [],
              },
            },
          })
        : failure === "write_as_r1"
          ? ToolRegistrationContractSchema.parse({
              ...baseTool,
              security: { ...baseTool.security, riskClass: "R1" },
            })
          : failure === "not_applicable_write"
            ? ToolRegistrationContractSchema.parse({
                ...baseTool,
                security: { ...baseTool.security, reversibility: "not_applicable" },
              })
            : baseTool;
    const strategy =
      failure === "transaction_domain" || failure === "transaction_egress"
        ? ({
            kind: "transactional",
            registrationDigest: digest("e"),
            preview: nativeStrategy().preview,
            coordinatorId: "coordinator-1",
            execute: () => Promise.reject(new Error("not called")),
          } as const)
        : ({
            ...nativeStrategy(),
            ...(failure === "strategy_digest" ? { registrationDigest: digest("f") } : {}),
            ...(failure === "preview_digest"
              ? { preview: { ...nativeStrategy().preview, registrationDigest: digest("f") } }
              : {}),
            ...(failure === "missing_dispatch" ? { dispatch: undefined } : {}),
          } as unknown as ExecutableEffectStrategy<Input, Output>);
    expect(() =>
      validateEffectStrategyRegistration({
        tool:
          failure === "transaction_domain"
            ? { ...tool, effectStrategyKind: "transactional" }
            : tool,
        strategy,
        ...(failure === "transaction_domain" || failure === "transaction_egress"
          ? {
              coordinatorProof: {
                coordinatorId: "coordinator-1",
                registrationDigest: digest("a"),
                transactionDomain: "postgres-a",
                authorizationDomain: "postgres-b",
                targetMutationDomain: "postgres-a",
                commitsAuthorizationReservation: true as const,
                commitsAcknowledgedEffect: true as const,
                commitsValidatedResult: true as const,
              },
            }
          : {}),
      }),
    ).toThrow(EffectRegistrationError);
  });

  it("binds compensation to a separate non-recursive write registration", () => {
    const forward = makeTool("R3");
    const compensationTool = ToolRegistrationContractSchema.parse({
      ...makeTool("R4"),
      id: "demo.compensate@1",
      security: { ...makeTool("R4").security, reversibility: "irreversible" },
      toolRegistrationDigest: digest("c"),
    });
    const compensation = {
      id: "document.compensation@1",
      implementationVersion: "1.0.0",
      registrationDigest: forward.compensationStrategyRegistrationDigest ?? digest("f"),
      inputSchemaDigest: digest("b"),
      compensationTool: {
        id: compensationTool.id,
        version: "1",
        toolRegistrationDigest: compensationTool.toolRegistrationDigest,
      },
      deriveInput: () => ({ operation: "restore" }) as JsonValue,
    };
    expect(
      validateEffectStrategyRegistration({
        tool: forward,
        strategy: nativeStrategy(),
        compensation,
        compensationTool,
      }),
    ).toMatchObject({ compensationStrategyRegistrationDigest: digest("f") });
    expect(() =>
      validateEffectStrategyRegistration({
        tool: forward,
        strategy: nativeStrategy(),
        compensation,
        compensationTool: {
          ...compensationTool,
          security: { ...compensationTool.security, reversibility: "compensatable" },
        },
      }),
    ).toThrow(/Recursive/u);
    expect(() =>
      validateEffectStrategyRegistration({
        tool: forward,
        strategy: nativeStrategy(),
      }),
    ).toThrow(/Compensation strategy/u);
    expect(() =>
      validateEffectStrategyRegistration({
        tool: compensationTool,
        strategy: nativeStrategy(),
        compensation,
        compensationTool,
      }),
    ).toThrow(/Only compensatable/u);
    expect(() =>
      validateEffectStrategyRegistration({
        tool: forward,
        strategy: nativeStrategy(),
        compensation: {
          ...compensation,
          compensationTool: { ...compensation.compensationTool, version: "2" },
        },
        compensationTool,
      }),
    ).toThrow(/identity/u);
  });
});

describe("deterministic preview executor", () => {
  it("runs with a capability-minimal frozen context and verifies the digest twice", async () => {
    let calls = 0;
    await expect(
      executeDeterministicPreview({
        strategy: nativeStrategy((_value, receivedContext) => {
          calls += 1;
          expect(Object.keys(receivedContext).sort()).toEqual([
            "deterministicClock",
            "normalizedTarget",
            "run",
          ]);
          expect(Object.isFrozen(receivedContext)).toBe(true);
          expect(receivedContext.deterministicClock.now()).toBe("2026-08-03T10:00:00.000Z");
          expect(receivedContext.deterministicClock.monotonicMilliseconds()).toBe(0);
          return Promise.resolve(preview);
        }).preview,
        value: { value: "bounded" },
        context,
        expectedRegistrationDigest: digest("d"),
        expectedReversibility: "irreversible",
      }),
    ).resolves.toEqual(preview);
    expect(calls).toBe(2);
  });

  it("canonicalizes nested array input and a diff-bound preview", async () => {
    const withDiffMaterial = { ...previewMaterial, diffDigest: digest("6") };
    const withDiff = {
      ...withDiffMaterial,
      previewDigest: digestCanonicalJson(withDiffMaterial),
    };
    await expect(
      executeDeterministicPreview({
        strategy: {
          id: "array.preview@1",
          implementationVersion: "1.0.0",
          registrationDigest: digest("d"),
          render: (value: JsonValue) => {
            expect(Object.isFrozen(value)).toBe(true);
            if (Array.isArray(value)) expect(Object.isFrozen(value[0])).toBe(true);
            return Promise.resolve(withDiff);
          },
        },
        value: [{ nested: ["value"] }],
        context,
        expectedRegistrationDigest: digest("d"),
        expectedReversibility: "irreversible",
      }),
    ).resolves.toEqual(withDiff);
  });

  it("rejects drift, a forged digest, a changed target, and callback failure", async () => {
    let counter = 0;
    const renderers: readonly ((
      input: Input,
      context: PreviewContext,
    ) => Promise<EffectPreview>)[] = [
      () => Promise.resolve({ ...preview, materialConsequence: `change-${String(counter++)}` }),
      () => Promise.resolve({ ...preview, previewDigest: digest("0") }),
      () => Promise.resolve({ ...preview, normalizedTarget: "workspace/private" }),
      () => Promise.reject(new Error("secret canary")),
    ];
    for (const render of renderers) {
      await expect(
        executeDeterministicPreview({
          strategy: nativeStrategy(render).preview,
          value: { value: "bounded" },
          context,
          expectedRegistrationDigest: digest("d"),
          expectedReversibility: "irreversible",
        }),
      ).rejects.toBeInstanceOf(PreviewExecutionError);
    }
    await expect(
      executeDeterministicPreview({
        strategy: nativeStrategy().preview,
        value: { value: "bounded" },
        context,
        expectedRegistrationDigest: digest("f"),
        expectedReversibility: "irreversible",
      }),
    ).rejects.toBeInstanceOf(PreviewExecutionError);
  });
});
