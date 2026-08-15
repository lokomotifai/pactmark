import assert from "node:assert/strict";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  InitializerError,
  initializerInternals,
} from "../../packages/create-pactmark/dist/index.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
const cwd = path.resolve("/tmp/pactmark-fuzz-root");

export function fuzz(data) {
  try {
    const target = initializerInternals.validateTarget(cwd, decoder.decode(data));
    const relative = path.relative(cwd, target.absolute);
    assert.notEqual(relative, "");
    assert.ok(!relative.startsWith(".."));
    assert.ok(!path.isAbsolute(relative));
    assert.equal(path.basename(target.absolute), target.projectName);
  } catch (error) {
    if (error instanceof InitializerError) return;
    throw error;
  }
}
