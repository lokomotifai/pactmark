import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  gitFiles,
  gitSourceState,
  repositoryRoot,
  sha256File,
} from "../../tooling/lib/repository.mjs";

const gitSourceStateTimeout = process.platform === "win32" ? 30_000 : 5_000;

describe("repository tooling", () => {
  it("returns deterministic SHA-256 identities", () => {
    const path = join(repositoryRoot, ".artifacts", "test-hash-input.txt");
    mkdirSync(join(repositoryRoot, ".artifacts"), { recursive: true });
    writeFileSync(path, "pactmark\n", { mode: 0o600 });
    const expected = createHash("sha256").update("pactmark\n").digest("hex");
    expect(sha256File(path)).toBe(`sha256:${expected}`);
  });

  it("keeps private bootstrap roots outside the public file set", () => {
    expect(gitFiles().filter((path) => /^(?:briefs|research)\//u.test(path))).toEqual([]);
  });

  it("excludes tracked files deleted in the working tree", () => {
    expect(gitFiles().every((path) => existsSync(join(repositoryRoot, path)))).toBe(true);
  });

  it(
    "reports a real clean commit and fails closed for dirty or uncommitted sources",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "pactmark-git-source-"));
      try {
        execFileSync("git", ["init", "--quiet"], { cwd: directory });
        expect(gitSourceState(directory)).toEqual({
          commit: "uncommitted-local-source",
          clean: false,
        });
        writeFileSync(join(directory, "source.txt"), "one\n");
        execFileSync("git", ["add", "source.txt"], { cwd: directory });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Pactmark Conformance",
            "-c",
            "user.email=conformance@pactmark.invalid",
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "-m",
            "baseline",
          ],
          { cwd: directory },
        );
        const clean = gitSourceState(directory);
        expect(clean.clean).toBe(true);
        expect(clean.commit).toMatch(/^[0-9a-f]{40,64}$/u);
        writeFileSync(join(directory, "source.txt"), "two\n");
        expect(gitSourceState(directory)).toEqual({ commit: clean.commit, clean: false });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    gitSourceStateTimeout,
  );
});
