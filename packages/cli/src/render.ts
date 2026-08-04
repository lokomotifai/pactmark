import { canonicalJsonStringify } from "@pactmark/core";

const MAX_TEXT_CODE_POINTS = 512;
const MAX_MULTILINE_BYTES = 32 * 1024;
const MAX_MULTILINE_LINES = 200;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Mark}\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function escapeCodePoint(value: string): string {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).padStart(4, "0")}`
    : `\\u{${codePoint.toString(16)}}`;
}

/** Converts terminal-active and visual-spoofing characters to inert, visible notation. */
export function visibleText(value: string): string {
  const codePoints = Array.from(value);
  const bounded = codePoints.slice(0, MAX_TEXT_CODE_POINTS).join("");
  const suffix = codePoints.length > MAX_TEXT_CODE_POINTS ? "…[truncated]" : "";
  return `${bounded.replaceAll(UNSAFE, escapeCodePoint)}${suffix}`;
}

/** Canonical JSON with terminal-active Unicode represented as JSON escapes. */
export function safeCanonicalJson(value: unknown): string {
  return canonicalJsonStringify(value).replaceAll(UNSAFE, escapeCodePoint);
}

export function safeMultiline(value: string): string {
  const rendered = value
    .split("\n")
    .slice(0, MAX_MULTILINE_LINES)
    .map((line) => visibleText(line))
    .join("\n");
  const encoder = new TextEncoder();
  if (encoder.encode(rendered).byteLength <= MAX_MULTILINE_BYTES) return rendered;
  let bounded = "";
  for (const codePoint of rendered) {
    if (encoder.encode(`${bounded}${codePoint}…[truncated]`).byteLength > MAX_MULTILINE_BYTES)
      break;
    bounded += codePoint;
  }
  return `${bounded}…[truncated]`;
}
