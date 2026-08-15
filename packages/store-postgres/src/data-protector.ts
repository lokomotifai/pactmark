import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import {
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  KafError,
  ProtectedValueRefSchema,
  type DataProtector,
  type ProtectedValueRef,
} from "@pactmark/core";

import type { PostgresDatabase } from "./database.js";
import { withTransaction } from "./database.js";

const ALGORITHM = "AES-256-GCM";
const PROTECTOR_ID = "pactmark.aes-256-gcm@1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_INVOCATION_CEILING = 1_000_000;
const DEFAULT_NONCE_ATTEMPTS = 4;

export interface DataProtectionKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

/** Host-owned key custody and rotation boundary. Key bytes are never persisted by this package. */
export interface DataProtectionKeyProvider {
  current(): Promise<DataProtectionKey>;
  resolve(keyId: string): Promise<DataProtectionKey | undefined>;
}

export type ProtectionNonceReservation =
  | "reserved"
  | "collision"
  | "ceiling_reached"
  | "key_binding_mismatch"
  | "ceiling_configuration_mismatch";

/** Coordinates nonce uniqueness and the conservative per-key invocation ceiling. */
export interface ProtectionNonceRegistry {
  reserve(
    input: Readonly<{
      namespace: string;
      keyId: string;
      nonce: Uint8Array;
      invocationCeiling: number;
    }>,
  ): Promise<ProtectionNonceReservation>;
}

export interface Aes256GcmDataProtectorOptions {
  readonly keyProvider: DataProtectionKeyProvider;
  readonly nonceRegistry: ProtectionNonceRegistry;
  readonly namespace?: string;
  readonly invocationCeiling?: number;
  readonly maxNonceAttempts?: number;
  readonly generateNonce?: () => Uint8Array;
}

type CiphertextEnvelope = Readonly<{
  version: "1";
  nonce: string;
  ciphertext: string;
  tag: string;
}>;

/**
 * AES-256-GCM reference protector for durable Pactmark records.
 *
 * The host injects key custody/rotation. The registry reserves every 96-bit
 * nonce before encryption and must be durable for production use.
 */
export class Aes256GcmDataProtector implements DataProtector {
  readonly #keyProvider: DataProtectionKeyProvider;
  readonly #nonceRegistry: ProtectionNonceRegistry;
  readonly #namespace: string;
  readonly #invocationCeiling: number;
  readonly #maxNonceAttempts: number;
  readonly #generateNonce: () => Uint8Array;

  constructor(options: Aes256GcmDataProtectorOptions) {
    this.#keyProvider = options.keyProvider;
    this.#nonceRegistry = options.nonceRegistry;
    this.#namespace = requireNonempty(
      options.namespace ?? "pactmark.store-postgres.protected-v1",
      "namespace",
    );
    this.#invocationCeiling = requireInvocationCeiling(
      options.invocationCeiling ?? DEFAULT_INVOCATION_CEILING,
      "invocationCeiling",
    );
    this.#maxNonceAttempts = requirePositiveSafeInteger(
      options.maxNonceAttempts ?? DEFAULT_NONCE_ATTEMPTS,
      "maxNonceAttempts",
    );
    this.#generateNonce = options.generateNonce ?? (() => randomBytes(NONCE_BYTES));
  }

  async protect(
    binding: Readonly<Record<string, string>>,
    plaintextInput: Uint8Array,
  ): Promise<ProtectedValueRef> {
    const keyRecord = await this.#keyProvider.current();
    const key = validateKey(keyRecord);
    const aadMaterial = protectionAad(binding, keyRecord.keyId);
    const aad = new TextEncoder().encode(canonicalJsonStringify(aadMaterial));
    const aadDigest = digestCanonicalJson(binding);
    const plaintext = new Uint8Array(plaintextInput);

    for (let attempt = 0; attempt < this.#maxNonceAttempts; attempt += 1) {
      const nonce = validateNonce(this.#generateNonce());
      const reservation = await this.#nonceRegistry.reserve({
        namespace: this.#namespace,
        keyId: keyRecord.keyId,
        nonce,
        invocationCeiling: this.#invocationCeiling,
      });
      if (reservation === "collision") continue;
      if (reservation === "ceiling_reached") rejectProtection("key_invocation_ceiling_reached");
      if (reservation === "key_binding_mismatch") rejectProtection("key_namespace_mismatch");
      if (reservation === "ceiling_configuration_mismatch") {
        rejectProtection("key_invocation_ceiling_configuration_mismatch");
      }

      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope: CiphertextEnvelope = {
        version: "1",
        nonce: toBase64Url(nonce),
        ciphertext: toBase64Url(ciphertext),
        tag: toBase64Url(tag),
      };
      const serialized = new TextEncoder().encode(JSON.stringify(envelope));
      return ProtectedValueRefSchema.parse({
        schemaVersion: "1",
        protectorId: PROTECTOR_ID,
        keyId: keyRecord.keyId,
        ciphertextRef: `pactmark:aesgcm:v1:${toBase64Url(serialized)}`,
        ciphertextDigest: digestBytes(serialized),
        aadDigest,
        algorithm: ALGORITHM,
      });
    }
    rejectProtection("nonce_collision_retry_exhausted");
  }

  async unprotect(
    binding: Readonly<Record<string, string>>,
    referenceInput: ProtectedValueRef,
  ): Promise<Uint8Array> {
    const reference = ProtectedValueRefSchema.parse(referenceInput);
    if (reference.protectorId !== PROTECTOR_ID || reference.algorithm !== ALGORITHM) {
      rejectProtection("protector_or_algorithm_mismatch");
    }
    const aadMaterial = protectionAad(binding, reference.keyId);
    const expectedAadDigest = digestCanonicalJson(binding);
    if (!safeEqualText(reference.aadDigest, expectedAadDigest)) rejectProtection("aad_mismatch");

    const serialized = decodeCiphertextReference(reference.ciphertextRef);
    if (!safeEqualText(reference.ciphertextDigest, digestBytes(serialized))) {
      rejectProtection("ciphertext_digest_mismatch");
    }
    const envelope = parseEnvelope(serialized);
    const nonce = fromBase64Url(envelope.nonce, "nonce");
    const ciphertext = fromBase64Url(envelope.ciphertext, "ciphertext");
    const tag = fromBase64Url(envelope.tag, "tag");
    validateNonce(nonce);
    if (tag.byteLength !== TAG_BYTES) rejectProtection("authentication_tag_length");

    const keyRecord = await this.#keyProvider.resolve(reference.keyId);
    if (keyRecord === undefined || keyRecord.keyId !== reference.keyId) {
      rejectProtection("key_unavailable");
    }
    const key = validateKey(keyRecord);
    const aad = new TextEncoder().encode(canonicalJsonStringify(aadMaterial));
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch (internalCause) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "authentication_failed" },
        internalCause,
      });
    }
  }
}

/** Durable nonce/counter registry backed by the same PostgreSQL database. */
export class PostgresProtectionNonceRegistry implements ProtectionNonceRegistry {
  constructor(readonly database: PostgresDatabase) {}

  async reserve(
    input: Readonly<{
      namespace: string;
      keyId: string;
      nonce: Uint8Array;
      invocationCeiling: number;
    }>,
  ): Promise<ProtectionNonceReservation> {
    const namespace = requireNonempty(input.namespace, "namespace");
    const keyId = requireNonempty(input.keyId, "keyId");
    const nonce = validateNonce(input.nonce);
    const invocationCeiling = requireInvocationCeiling(
      input.invocationCeiling,
      "invocationCeiling",
    );
    try {
      return await withTransaction(this.database, async (client) => {
        await client.query(
          `INSERT INTO pactmark_protection_key_counters
            (namespace_id,key_id,invocation_count,invocation_ceiling)
           VALUES ($1,$2,0,$3) ON CONFLICT (key_id) DO NOTHING`,
          [namespace, keyId, invocationCeiling],
        );
        const increment = await client.query(
          `UPDATE pactmark_protection_key_counters
           SET invocation_count=invocation_count+1
           WHERE namespace_id=$1 AND key_id=$2 AND invocation_ceiling=$3
             AND invocation_count < invocation_ceiling
           RETURNING invocation_count`,
          [namespace, keyId, invocationCeiling],
        );
        if (increment.rowCount !== 1) {
          const existing = await client.query(
            `SELECT namespace_id,invocation_count,invocation_ceiling
             FROM pactmark_protection_key_counters WHERE key_id=$1`,
            [keyId],
          );
          const row = existing.rows[0] as
            | Readonly<{
                namespace_id: string;
                invocation_count: string | number;
                invocation_ceiling: string | number;
              }>
            | undefined;
          if (row === undefined || row.namespace_id !== namespace) return "key_binding_mismatch";
          if (Number(row.invocation_ceiling) !== invocationCeiling) {
            return "ceiling_configuration_mismatch";
          }
          return "ceiling_reached";
        }
        await client.query(
          `INSERT INTO pactmark_protection_nonces (namespace_id,key_id,nonce)
           VALUES ($1,$2,$3)`,
          [namespace, keyId, nonce],
        );
        return "reserved";
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "collision";
      throw error;
    }
  }
}

/** Process-local registry for deterministic tests and explicitly ephemeral previews only. */
export class MemoryProtectionNonceRegistry implements ProtectionNonceRegistry {
  readonly #seen = new Set<string>();
  readonly #counts = new Map<string, number>();
  readonly #bindings = new Map<
    string,
    Readonly<{ namespace: string; invocationCeiling: number }>
  >();

  async reserve(
    input: Readonly<{
      namespace: string;
      keyId: string;
      nonce: Uint8Array;
      invocationCeiling: number;
    }>,
  ): Promise<ProtectionNonceReservation> {
    await Promise.resolve();
    const binding = this.#bindings.get(input.keyId);
    if (binding !== undefined && binding.namespace !== input.namespace) {
      return "key_binding_mismatch";
    }
    if (binding !== undefined && binding.invocationCeiling !== input.invocationCeiling) {
      return "ceiling_configuration_mismatch";
    }
    this.#bindings.set(input.keyId, {
      namespace: input.namespace,
      invocationCeiling: input.invocationCeiling,
    });
    const nonce = validateNonce(input.nonce);
    const counterKey = input.keyId;
    const nonceKey = `${input.keyId}\u0000${toBase64Url(nonce)}`;
    if (this.#seen.has(nonceKey)) return "collision";
    const count = this.#counts.get(counterKey) ?? 0;
    if (count >= input.invocationCeiling) return "ceiling_reached";
    this.#seen.add(nonceKey);
    this.#counts.set(counterKey, count + 1);
    return "reserved";
  }
}

export function computeProtectionAadDigest(
  binding: Readonly<Record<string, string>>,
  keyId: string,
) {
  protectionAad(binding, keyId);
  return digestCanonicalJson(binding);
}

function protectionAad(
  binding: Readonly<Record<string, string>>,
  keyId: string,
): Readonly<Record<string, string>> {
  for (const required of [
    "tenantId",
    "recordId",
    "storeKind",
    "schemaVersion",
    "purposeCode",
    "dataClass",
  ]) {
    requireNonempty(binding[required], `binding.${required}`);
  }
  if ("keyId" in binding) rejectProtection("binding_must_not_supply_key_id");
  const sorted: Record<string, string> = {};
  for (const [name, value] of Object.entries(binding).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[requireNonempty(name, "binding key")] = requireNonempty(value, name);
  }
  return Object.freeze({ ...sorted, keyId: requireNonempty(keyId, "keyId") });
}

function validateKey(record: DataProtectionKey): Buffer {
  requireNonempty(record.keyId, "keyId");
  const key = Buffer.from(record.key);
  if (key.byteLength !== 32) rejectProtection("aes_256_key_length");
  return key;
}

function validateNonce(input: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(input);
  if (nonce.byteLength !== NONCE_BYTES) rejectProtection("nonce_must_be_96_bits");
  return nonce;
}

function decodeCiphertextReference(reference: string): Uint8Array {
  const prefix = "pactmark:aesgcm:v1:";
  if (!reference.startsWith(prefix)) rejectProtection("ciphertext_reference_format");
  return fromBase64Url(reference.slice(prefix.length), "ciphertext_reference");
}

function parseEnvelope(bytes: Uint8Array): CiphertextEnvelope {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).toSorted().join(",") !== "ciphertext,nonce,tag,version" ||
      !("version" in value) ||
      value.version !== "1" ||
      !("nonce" in value) ||
      typeof value.nonce !== "string" ||
      !("ciphertext" in value) ||
      typeof value.ciphertext !== "string" ||
      !("tag" in value) ||
      typeof value.tag !== "string"
    ) {
      rejectProtection("ciphertext_envelope_invalid");
    }
    return value as CiphertextEnvelope;
  } catch (error) {
    if (error instanceof KafError) throw error;
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "ciphertext_envelope_invalid" },
      internalCause: error,
    });
  }
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) rejectProtection(`${field}_encoding`);
  const decoded = new Uint8Array(Buffer.from(value, "base64url"));
  if (toBase64Url(decoded) !== value) rejectProtection(`${field}_encoding`);
  return decoded;
}

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function requireNonempty(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) rejectProtection(`${field}_required`);
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) rejectProtection(`${field}_invalid`);
  return value;
}

function requireInvocationCeiling(value: number, field: string): number {
  const validated = requirePositiveSafeInteger(value, field);
  if (validated > DEFAULT_INVOCATION_CEILING) rejectProtection(`${field}_not_conservative`);
  return validated;
}

function rejectProtection(reason: string): never {
  throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason } });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
