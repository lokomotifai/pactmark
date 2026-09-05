import { z } from "zod";

export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a lowercase sha256 digest");
export type Digest = z.infer<typeof DigestSchema>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type CanonicalJsonErrorCode =
  | "KAF_SERIALIZATION_INVALID_JSON"
  | "KAF_SERIALIZATION_DUPLICATE_KEY"
  | "KAF_SERIALIZATION_INVALID_UNICODE"
  | "KAF_SERIALIZATION_NON_I_JSON_NUMBER"
  | "KAF_SERIALIZATION_UNSUPPORTED_VALUE"
  | "KAF_SERIALIZATION_CYCLIC_VALUE";

export class CanonicalJsonError extends TypeError {
  readonly code: CanonicalJsonErrorCode;
  readonly path: string;

  constructor(code: CanonicalJsonErrorCode, message: string, path = "$") {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
    this.path = path;
  }
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(
          "KAF_SERIALIZATION_INVALID_UNICODE",
          "Unpaired high surrogate",
          path,
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalJsonError(
        "KAF_SERIALIZATION_INVALID_UNICODE",
        "Unpaired low surrogate",
        path,
      );
    }
  }
}

function quote(value: string, path: string): string {
  assertValidUnicode(value, path);
  return JSON.stringify(value);
}

function serializeCanonicalNumber(value: number, path: string): string {
  const serialized = JSON.stringify(value);
  const unsafePlainInteger =
    Number.isInteger(value) && !Number.isSafeInteger(value) && !/[eE]/u.test(serialized);
  if (!Number.isFinite(value) || unsafePlainInteger) {
    throw new CanonicalJsonError(
      "KAF_SERIALIZATION_NON_I_JSON_NUMBER",
      "Numbers must be finite IEEE-754 values and integers must be exactly representable",
      path,
    );
  }
  return serialized;
}

function normalizedDecimalIdentity(token: string): string | undefined {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token);
  if (parts === null) return undefined;
  const sign = parts[1] ?? "";
  const integerDigits = parts[2] ?? "";
  const fractionalDigits = parts[3] ?? "";
  let coefficientDigits = `${integerDigits}${fractionalDigits}`.replace(/^0+/u, "");
  if (coefficientDigits.length === 0) return "0e0";
  let exponent = BigInt(parts[4] ?? "0") - BigInt(fractionalDigits.length);
  const trailingZeros = /0+$/u.exec(coefficientDigits)?.[0].length ?? 0;
  if (trailingZeros > 0) {
    coefficientDigits = coefficientDigits.slice(0, -trailingZeros);
    exponent += BigInt(trailingZeros);
  }
  return `${sign}${coefficientDigits}e${String(exponent)}`;
}

function assertUnroundedIntegerToken(
  token: string,
  value: number,
  canonicalToken: string,
  path: string,
): void {
  if (!Number.isInteger(value)) return;
  if (normalizedDecimalIdentity(token) !== normalizedDecimalIdentity(canonicalToken)) {
    throw new CanonicalJsonError(
      "KAF_SERIALIZATION_NON_I_JSON_NUMBER",
      "Integer number tokens must not be rounded to another canonical value",
      path,
    );
  }
}

function canonicalize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value, path);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeCanonicalNumber(value, path);
  if (typeof value !== "object") {
    throw new CanonicalJsonError(
      "KAF_SERIALIZATION_UNSUPPORTED_VALUE",
      `Unsupported JSON value type: ${typeof value}`,
      path,
    );
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(
      "KAF_SERIALIZATION_CYCLIC_VALUE",
      "Cyclic values cannot be canonicalized",
      path,
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError(
            "KAF_SERIALIZATION_UNSUPPORTED_VALUE",
            "Sparse arrays are not valid canonical JSON input",
            `${path}[${String(index)}]`,
          );
        }
        entries.push(canonicalize(value[index], `${path}[${String(index)}]`, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "KAF_SERIALIZATION_UNSUPPORTED_VALUE",
        "Only ordinary JSON objects are supported",
        path,
      );
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new CanonicalJsonError(
        "KAF_SERIALIZATION_UNSUPPORTED_VALUE",
        "Symbol keys are not supported",
        path,
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const fields: string[] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new CanonicalJsonError(
          "KAF_SERIALIZATION_UNSUPPORTED_VALUE",
          "Accessor properties are not supported",
          `${path}.${key}`,
        );
      }
      fields.push(
        `${quote(key, `${path}.[key]`)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`,
      );
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785 JSON Canonicalization Scheme over an already materialized value. */
export function canonicalJsonStringify(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.readValue("$");
    this.whitespace();
    if (this.offset !== this.source.length) this.fail("Unexpected trailing input");
    return value;
  }

  private readValue(path: string): JsonValue {
    this.whitespace();
    const char = this.source[this.offset];
    if (char === '"') return this.readString(path);
    if (char === "{") return this.readObject(path);
    if (char === "[") return this.readArray(path);
    if (char === "t" && this.consume("true")) return true;
    if (char === "f" && this.consume("false")) return false;
    if (char === "n" && this.consume("null")) return null;
    return this.readNumber(path);
  }

  private readObject(path: string): { readonly [key: string]: JsonValue } {
    this.offset += 1;
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.source[this.offset] !== '"') this.fail("Object key must be a JSON string");
      const key = this.readString(`${path}.[key]`);
      if (keys.has(key)) {
        throw new CanonicalJsonError(
          "KAF_SERIALIZATION_DUPLICATE_KEY",
          `Duplicate object key: ${key}`,
          path,
        );
      }
      keys.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ":") this.fail("Expected ':' after object key");
      this.offset += 1;
      result[key] = this.readValue(`${path}.${key}`);
      this.whitespace();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail("Expected ',' or '}' in object");
      this.offset += 1;
    }
  }

  private readArray(path: string): readonly JsonValue[] {
    this.offset += 1;
    const result: JsonValue[] = [];
    this.whitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    for (;;) {
      result.push(this.readValue(`${path}[${String(result.length)}]`));
      this.whitespace();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") this.fail("Expected ',' or ']' in array");
      this.offset += 1;
    }
  }

  private readString(path: string): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char === '"') {
        this.offset += 1;
        let value: string;
        try {
          value = JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          this.fail("Invalid JSON string");
        }
        assertValidUnicode(value, path);
        return value;
      }
      if (char === "\\") {
        this.offset += 2;
        continue;
      }
      if (char === undefined || char.charCodeAt(0) <= 0x1f)
        this.fail("Invalid control character in string");
      this.offset += 1;
    }
    this.fail("Unterminated JSON string");
  }

  private readNumber(path: string): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.offset),
    );
    if (!match) this.fail("Expected a JSON value");
    this.offset += match[0].length;
    const value = Number(match[0]);
    const canonicalToken = serializeCanonicalNumber(value, path);
    assertUnroundedIntegerToken(match[0], value, canonicalToken, path);
    return value;
  }

  private whitespace(): void {
    while (["\t", "\n", "\r", " "].includes(this.source[this.offset] ?? "")) {
      this.offset += 1;
    }
  }

  private consume(token: string): boolean {
    if (!this.source.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }

  private fail(message: string): never {
    throw new CanonicalJsonError(
      "KAF_SERIALIZATION_INVALID_JSON",
      `${message} at offset ${String(this.offset)}`,
    );
  }
}

/** Parses JSON while rejecting duplicate keys, invalid Unicode and non-I-JSON numbers. */
export function parseJsonStrict(source: string): JsonValue {
  return new StrictJsonParser(source).parse();
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function uint32At(values: Uint32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError("SHA-256 word index is out of bounds");
  return value;
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Portable synchronous SHA-256; output is byte-for-byte compatible with Web Crypto SHA-256. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      schedule[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = uint32At(schedule, index - 15);
      const b = uint32At(schedule, index - 2);
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[index] =
        (uint32At(schedule, index - 16) + s0 + uint32At(schedule, index - 7) + s1) >>> 0;
    }
    let a = uint32At(hash, 0);
    let b = uint32At(hash, 1);
    let c = uint32At(hash, 2);
    let d = uint32At(hash, 3);
    let e = uint32At(hash, 4);
    let f = uint32At(hash, 5);
    let g = uint32At(hash, 6);
    let h = uint32At(hash, 7);
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + choose + uint32At(SHA256_CONSTANTS, index) + uint32At(schedule, index)) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (uint32At(hash, 0) + a) >>> 0;
    hash[1] = (uint32At(hash, 1) + b) >>> 0;
    hash[2] = (uint32At(hash, 2) + c) >>> 0;
    hash[3] = (uint32At(hash, 3) + d) >>> 0;
    hash[4] = (uint32At(hash, 4) + e) >>> 0;
    hash[5] = (uint32At(hash, 5) + f) >>> 0;
    hash[6] = (uint32At(hash, 6) + g) >>> 0;
    hash[7] = (uint32At(hash, 7) + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((word, index) => {
    outputView.setUint32(index * 4, word, false);
  });
  return output;
}

export function digestBytes(bytes: Uint8Array): Digest {
  const hex = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return DigestSchema.parse(`sha256:${hex}`);
}

export function digestCanonicalJson(value: unknown): Digest {
  return digestBytes(new TextEncoder().encode(canonicalJsonStringify(value)));
}
