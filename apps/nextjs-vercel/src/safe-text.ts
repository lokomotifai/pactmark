export function toSafeText(value: unknown, maximumLength = 12_000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      const serialized = JSON.stringify(value, null, 2);
      text = typeof serialized === "string" ? serialized : String(value);
    } catch {
      text = "[unrenderable value]";
    }
  }
  const escaped = Array.from(text, (character) => {
    const code = character.codePointAt(0);
    if (code === undefined) return "";
    const unsafe =
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    return unsafe ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
  return escaped.length <= maximumLength
    ? escaped
    : `${escaped.slice(0, maximumLength)}\n[truncated]`;
}
