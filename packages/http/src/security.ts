/** Compares UTF-8 text without returning early on a differing byte or length. */
export function constantTimeTextEqual(candidate: string | null, expected: string): boolean {
  if (candidate === null) return false;
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
