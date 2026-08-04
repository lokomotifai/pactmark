import { z } from "zod";

import { PrincipalSchema, TenantSchema } from "./authority.js";
import { DigestSchema, digestCanonicalJson } from "./serialization.js";
import { ResourceScopeSchema } from "./work-order.js";

export const COMMAND_ID_PATTERN = /^kafcmd_([0-9]{13})_([0-9a-f]{32})$/u;

export const CommandIdSchema = z
  .string()
  .regex(COMMAND_ID_PATTERN, "Expected a timestamped-random KAF command ID");
export type CommandId = z.infer<typeof CommandIdSchema>;

export interface CommandIdEntropy {
  now(): Date;
  randomBytes(length: number): Uint8Array;
}

/** Core entropy-injected constructor. Public facades supply a safe clock and CSPRNG. */
export function createCommandId(entropy: CommandIdEntropy): CommandId {
  const timestamp = entropy.now().getTime();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 1_000_000_000_000 ||
    timestamp > 9_999_999_999_999
  ) {
    throw new RangeError("Command timestamp must be a 13-digit Unix epoch millisecond value");
  }
  const random = entropy.randomBytes(16);
  if (random.length !== 16) {
    throw new RangeError("Command ID entropy source must return exactly 16 bytes");
  }
  let suffix = "";
  for (const byte of random) suffix += byte.toString(16).padStart(2, "0");
  return CommandIdSchema.parse(`kafcmd_${String(timestamp)}_${suffix}`);
}

export function commandIdTimestamp(commandId: string): number | undefined {
  const match = COMMAND_ID_PATTERN.exec(commandId);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export type CommandIdWindowResult =
  | { readonly valid: true; readonly timestamp: number }
  | {
      readonly valid: false;
      readonly code:
        | "KAF_COMMAND_ID_MALFORMED"
        | "KAF_COMMAND_ID_FUTURE_SKEW"
        | "KAF_COMMAND_IDEMPOTENCY_EXPIRED";
    };

export function validateCommandIdWindow(
  commandId: string,
  options: Readonly<{ now: Date; maximumFutureSkewMs: number; idempotencyHorizonMs: number }>,
): CommandIdWindowResult {
  const timestamp = commandIdTimestamp(commandId);
  if (timestamp === undefined) return { valid: false, code: "KAF_COMMAND_ID_MALFORMED" };
  const now = options.now.getTime();
  if (timestamp > now + options.maximumFutureSkewMs) {
    return { valid: false, code: "KAF_COMMAND_ID_FUTURE_SKEW" };
  }
  if (timestamp + options.idempotencyHorizonMs <= now) {
    return { valid: false, code: "KAF_COMMAND_IDEMPOTENCY_EXPIRED" };
  }
  return { valid: true, timestamp };
}

export const CommandContextSchema = z
  .object({
    schemaVersion: z.literal("1"),
    commandId: CommandIdSchema,
    operation: z.string().trim().min(1).max(256),
    normalizedResourceScope: z.array(ResourceScopeSchema).max(256),
    requestDigest: DigestSchema,
  })
  .strict();
export type CommandContext = z.infer<typeof CommandContextSchema>;

export function createCommandContext(
  input: Readonly<{
    commandId: string;
    operation: string;
    payload: unknown;
    normalizedResourceScope?: readonly z.input<typeof ResourceScopeSchema>[];
  }>,
): CommandContext {
  return CommandContextSchema.parse({
    schemaVersion: "1",
    commandId: input.commandId,
    operation: input.operation,
    normalizedResourceScope: input.normalizedResourceScope ?? [],
    requestDigest: digestCanonicalJson(input.payload),
  });
}

export const CommandScopeSchema = z
  .object({
    issuerId: z.string().trim().min(1).max(256),
    tenant: TenantSchema,
    principal: PrincipalSchema,
    operation: z.string().trim().min(1).max(256),
    normalizedResourceScope: z.array(ResourceScopeSchema).max(256),
    commandId: CommandIdSchema,
  })
  .strict();
export type CommandScope = z.infer<typeof CommandScopeSchema>;

export const CommandResultReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), runId: z.string().trim().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal("event"),
      runId: z.string().trim().min(1).max(256),
      eventId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("effect"),
      runId: z.string().trim().min(1).max(256),
      effectId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision_challenge"),
      challengeId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("input_submission"),
      submissionId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({ kind: z.literal("response"), responseReference: z.string().trim().min(1).max(1024) })
    .strict(),
]);
export type CommandResultReference = z.infer<typeof CommandResultReferenceSchema>;

export const CommandRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    scope: CommandScopeSchema,
    requestDigest: DigestSchema,
    status: z.enum(["in_progress", "committed"]),
    resultReference: CommandResultReferenceSchema.optional(),
    safeResponseDigest: DigestSchema.optional(),
    firstSeenAt: z.iso.datetime({ offset: true }),
    committedAt: z.iso.datetime({ offset: true }).optional(),
    detailRetentionExpiresAt: z.iso.datetime({ offset: true }),
    idempotencyExpiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CommandRecord = z.infer<typeof CommandRecordSchema>;
