import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../../tooling/lib/repository.mjs";

describe("WP-00 bootstrap contract", () => {
  it("protects private bootstrap inputs in every Git checkout", () => {
    for (const path of ["briefs/.pactmark-private-probe", "research/.pactmark-private-probe"]) {
      const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", path], {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
  });

  it("configures the public-surface inspection as a required quality gate", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts["public-surface:check"]).toBe(
      "node --import tsx tooling/check-public-surface.mts",
    );
    expect(manifest.scripts["security:verify"]).toContain("pnpm public-surface:check");
    expect(manifest.scripts.verify).toContain("pnpm security:verify");
  });
});
