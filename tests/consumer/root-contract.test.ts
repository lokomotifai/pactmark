import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../../tooling/lib/repository.mjs";

type RootManifest = {
  readonly private: boolean;
  readonly packageManager: string;
  readonly engines: { readonly node: string };
  readonly scripts: Readonly<Record<string, string>>;
};

describe("root consumer contract", () => {
  it("pins the package manager and exposes real quality commands", () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as RootManifest;
    expect(manifest.private).toBe(true);
    expect(manifest.packageManager).toBe("pnpm@11.18.0");
    expect(manifest.engines.node).toContain("22");
    expect(manifest.engines.node).toContain("24");
    for (const script of [
      "format",
      "format:check",
      "lint",
      "typecheck",
      "test",
      "build",
      "docs:check",
      "pack:check",
      "release:dry-run",
      "verify",
    ]) {
      expect(manifest.scripts[script]).toBeTypeOf("string");
      expect(manifest.scripts[script]).not.toMatch(/^\s*(?:true|echo)\b/u);
    }
  });
});
