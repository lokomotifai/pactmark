import { z } from "zod";

import {
  DigestSchema,
  JsonValueSchema,
  digestCanonicalJson,
  type Digest,
  type JsonValue,
} from "./serialization.js";

const StableIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const VersionSchema = z.string().min(1).max(100);

export const RegisteredSchemaSemanticIdentitySchema = z
  .object({
    schemaVersion: z.literal("1"),
    kind: z.enum(["check", "transform"]),
    id: StableIdentifierSchema,
    implementationVersion: VersionSchema,
    implementationArtifactDigest: DigestSchema,
    inputSchemaIdentityDigest: DigestSchema.optional(),
    outputSchemaIdentityDigest: DigestSchema.optional(),
  })
  .strict();
export type RegisteredSchemaSemanticIdentity = z.infer<
  typeof RegisteredSchemaSemanticIdentitySchema
>;

export const SchemaIdentitySchema = z
  .object({
    schemaVersion: z.literal("1"),
    identityFormat: z.literal("pactmark.schema-identity@1"),
    id: StableIdentifierSchema,
    jsonSchemaDialect: z.literal("https://json-schema.org/draft/2020-12/schema"),
    canonicalJsonSchema: JsonValueSchema,
    canonicalJsonSchemaDigest: DigestSchema,
    semanticRevision: VersionSchema,
    registeredSemantics: z.array(RegisteredSchemaSemanticIdentitySchema),
    schemaIdentityDigest: DigestSchema,
  })
  .strict();
export type SchemaIdentity = z.infer<typeof SchemaIdentitySchema>;

export class SchemaIdentityError extends TypeError {
  readonly code = "KAF_SCHEMA_IDENTITY_UNSUPPORTED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchemaIdentityError";
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function zodDefinition(value: unknown): UnknownRecord | undefined {
  return asRecord(asRecord(value)?.["_zod"])?.["def"] as UnknownRecord | undefined;
}

function countCustomSemantics(root: z.ZodType): number {
  const visited = new Set<object>();
  let count = 0;

  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || visited.has(node)) return;
    visited.add(node);
    const definition = zodDefinition(node);
    if (!definition) return;

    const type = definition["type"];
    if (type === "custom" || type === "transform") count += 1;

    const checks = definition["checks"];
    if (Array.isArray(checks)) {
      for (const check of checks) {
        const checkDefinition = zodDefinition(check);
        if (checkDefinition?.["check"] === "custom") count += 1;
      }
    }

    for (const key of [
      "in",
      "out",
      "innerType",
      "element",
      "keyType",
      "valueType",
      "left",
      "right",
    ] as const) {
      visit(definition[key]);
    }
    const options = definition["options"];
    if (Array.isArray(options)) options.forEach(visit);
    const shape = definition["shape"];
    const materializedShape = typeof shape === "function" ? (shape as () => unknown)() : shape;
    const shapeRecord = asRecord(materializedShape);
    if (shapeRecord) Object.values(shapeRecord).forEach(visit);
  };

  visit(root);
  return count;
}

function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

export interface DefineSchemaOptions<S extends z.ZodType> {
  readonly id: string;
  readonly semanticRevision: string;
  readonly schema: S;
  /** Required one-for-one for Zod refinements, preprocessors, transforms, or other custom semantics. */
  readonly registeredSemantics?: readonly RegisteredSchemaSemanticIdentity[];
}

export interface DefinedSchema<S extends z.ZodType> {
  readonly id: string;
  readonly semanticRevision: string;
  readonly schema: S;
  readonly identity: SchemaIdentity;
  readonly schemaIdentity: SchemaIdentity;
  parse(input: unknown): z.output<S>;
  safeParse(input: unknown): z.ZodSafeParseResult<z.output<S>>;
}

export function defineRegisteredSchemaSemantic(
  input: Omit<RegisteredSchemaSemanticIdentity, "schemaVersion">,
): RegisteredSchemaSemanticIdentity {
  return immutable(RegisteredSchemaSemanticIdentitySchema.parse({ schemaVersion: "1", ...input }));
}

export function defineSchema<const S extends z.ZodType>(
  options: DefineSchemaOptions<S>,
): DefinedSchema<S> {
  const registeredSemantics = (options.registeredSemantics ?? []).map((semantic) =>
    RegisteredSchemaSemanticIdentitySchema.parse(semantic),
  );
  const customSemanticCount = countCustomSemantics(options.schema);
  if (customSemanticCount !== registeredSemantics.length) {
    throw new SchemaIdentityError(
      customSemanticCount === 0
        ? "Registered semantics were supplied but the Zod schema has no custom semantic nodes"
        : `Schema contains ${String(customSemanticCount)} custom semantic node(s), but ${String(registeredSemantics.length)} registered identity record(s) were supplied`,
    );
  }

  let generated: unknown;
  try {
    generated = z.toJSONSchema(options.schema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      reused: "ref",
      cycles: "ref",
    });
  } catch (error) {
    throw new SchemaIdentityError("Zod schema is outside Pactmark's portable JSON Schema subset", {
      cause: error,
    });
  }
  const canonicalJsonSchema = JsonValueSchema.parse(generated);
  const canonicalJsonSchemaDigest = digestCanonicalJson(canonicalJsonSchema);
  const identityWithoutDigest = {
    schemaVersion: "1" as const,
    identityFormat: "pactmark.schema-identity@1" as const,
    id: options.id,
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema" as const,
    canonicalJsonSchema,
    canonicalJsonSchemaDigest,
    semanticRevision: options.semanticRevision,
    registeredSemantics,
  };
  const identity = immutable(
    SchemaIdentitySchema.parse({
      ...identityWithoutDigest,
      schemaIdentityDigest: digestCanonicalJson(identityWithoutDigest),
    }),
  );

  return Object.freeze({
    id: identity.id,
    semanticRevision: identity.semanticRevision,
    schema: options.schema,
    identity,
    schemaIdentity: identity,
    parse: (input: unknown): z.output<S> => options.schema.parse(input),
    safeParse: (input: unknown): z.ZodSafeParseResult<z.output<S>> =>
      options.schema.safeParse(input),
  });
}

export function schemaIdentityDigest(identity: SchemaIdentity): Digest {
  const parsed = SchemaIdentitySchema.parse(identity);
  const { schemaIdentityDigest: claimedDigest, ...material } = parsed;
  const actualDigest = digestCanonicalJson(material);
  if (claimedDigest !== actualDigest) {
    throw new SchemaIdentityError("SchemaIdentity digest does not match its canonical material");
  }
  return actualDigest;
}

export function parseWithSchema<S extends z.ZodType>(
  schema: DefinedSchema<S>,
  input: unknown,
): z.output<S> {
  schemaIdentityDigest(schema.identity);
  return schema.parse(input);
}

export type { Digest, JsonValue };
