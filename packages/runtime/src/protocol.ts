import { z } from "zod";

import { DigestSchema, JsonValueSchema } from "@pactmark/core";

export const RuntimeModelEmissionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("tool_call"),
      value: z
        .object({
          toolRegistrationDigest: DigestSchema,
          input: JsonValueSchema,
          targetDigest: DigestSchema,
        })
        .strict(),
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
