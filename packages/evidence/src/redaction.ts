import { JsonValueSchema, type JsonValue } from "@pactmark/core";

export interface RedactionRule {
  readonly path: readonly (string | number)[];
  readonly replacement?: string;
}

type MutableJson =
  null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson };

function clone(value: JsonValue): MutableJson {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

export function redactTypedFields(input: JsonValue, rules: readonly RedactionRule[]): JsonValue {
  const output = clone(JsonValueSchema.parse(input));
  for (const rule of rules) {
    if (rule.path.length === 0) throw new TypeError("KAF_REDACTION_ROOT_FORBIDDEN");
    let current: MutableJson = output;
    for (const segment of rule.path.slice(0, -1)) {
      if (current === null || typeof current !== "object") {
        throw new TypeError("KAF_REDACTION_PATH_MISSING");
      }
      let next: MutableJson | undefined;
      if (Array.isArray(current)) {
        next = typeof segment === "number" ? current[segment] : undefined;
      } else {
        next = current[String(segment)];
      }
      if (next === undefined) throw new TypeError("KAF_REDACTION_PATH_MISSING");
      current = next;
    }
    const leaf = rule.path.at(-1);
    if (leaf === undefined) throw new TypeError("KAF_REDACTION_ROOT_FORBIDDEN");
    if (Array.isArray(current) && typeof leaf === "number" && leaf in current) {
      current[leaf] = rule.replacement ?? "[REDACTED]";
    } else if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      String(leaf) in current
    ) {
      current[String(leaf)] = rule.replacement ?? "[REDACTED]";
    } else {
      throw new TypeError("KAF_REDACTION_PATH_MISSING");
    }
  }
  return output;
}

/** Secondary safety net only; callers must use typed redaction for known sensitive fields. */
export function redactCommonSensitiveText(value: string): string {
  return value
    .replaceAll(/\bBasic\s+[A-Za-z0-9+/=]+/giu, "Basic [REDACTED]")
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replaceAll(
      /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,]+)/giu,
      "$1=[REDACTED]",
    )
    .replaceAll(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@[REDACTED_HOST]/")
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]");
}
