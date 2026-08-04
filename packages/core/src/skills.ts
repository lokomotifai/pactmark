import { z } from "zod";
import { DigestSchema } from "./serialization.js";

const PackageRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$)).+$/);

export const SkillEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal("1"),
      kind: z.literal("instruction"),
      path: PackageRelativePathSchema,
      mediaType: z.literal("text/markdown"),
      content: z.string(),
      contentDigest: DigestSchema,
      textNormalization: z.literal("utf8-bom-lf"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      kind: z.literal("resource"),
      path: PackageRelativePathSchema,
      mediaType: z.string().min(1),
      contentDigest: DigestSchema,
      byteSize: z.number().int().nonnegative(),
      textNormalization: z.enum(["none", "utf8-bom-lf"]),
    })
    .strict(),
]);
export const SkillManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    entries: z.array(SkillEntrySchema).min(1),
    contentDigest: DigestSchema,
    provenance: z
      .object({
        sourceType: z.enum(["local_package", "workspace_compiled"]),
        sourceName: z.string().min(1),
        sourceDigest: DigestSchema,
      })
      .strict(),
    compatibility: z
      .object({
        pactmarkCore: z.string().min(1),
        runtimes: z.array(z.enum(["portable", "node", "vercel", "cloudflare_preview"])).min(1),
      })
      .strict(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
