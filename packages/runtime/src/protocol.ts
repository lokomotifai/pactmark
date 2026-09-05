import { z } from "zod";

import { DigestSchema, JsonValueSchema } from "@pactmark/core";

export const RuntimeModelEmissionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tool_call"),
      value: z.union([
        z
          .object({
            toolRegistrationDigest: DigestSchema,
            input: JsonValueSchema,
            /** @deprecated The host derives the authoritative target from validated input. */
            targetDigest: DigestSchema,
          })
          .strict(),
        z.object({ toolRegistrationDigest: DigestSchema, input: JsonValueSchema }).strict(),
      ]),
    })
    .strict(),
  z.object({ type: z.literal("final"), value: JsonValueSchema }).strict(),
  z
    .object({
      type: z.literal("input_request"),
      value: z
        .object({
          inputSchemaDigest: DigestSchema,
          safePrompt: z.string().trim().min(1).max(2_000),
        })
        .strict(),
    })
    .strict(),
]);
export type RuntimeModelEmission = z.infer<typeof RuntimeModelEmissionSchema>;
