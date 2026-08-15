import assert from "node:assert/strict";
import { TextDecoder } from "node:util";

import { CanonicalJsonError, canonicalJsonStringify } from "../../packages/core/dist/index.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

export function fuzz(data) {
  let value;
  try {
    value = JSON.parse(decoder.decode(data));
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }

  try {
    const canonical = canonicalJsonStringify(value);
    const reparsed = JSON.parse(canonical);
    assert.equal(canonicalJsonStringify(reparsed), canonical);
  } catch (error) {
    if (error instanceof CanonicalJsonError) return;
    throw error;
  }
}
