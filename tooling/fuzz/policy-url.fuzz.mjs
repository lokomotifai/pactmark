import assert from "node:assert/strict";
import { TextDecoder } from "node:util";

import { PolicyNormalizationError, canonicalizeUrl } from "../../packages/policy/dist/index.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function fuzz(data) {
  try {
    const canonical = canonicalizeUrl(decoder.decode(data));
    assert.equal(canonicalizeUrl(canonical), canonical);
    assert.ok(canonical.startsWith("https://") || canonical.startsWith("http://"));
  } catch (error) {
    if (error instanceof PolicyNormalizationError) return;
    throw error;
  }
}
