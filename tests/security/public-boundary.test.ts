import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gitFiles, repositoryRoot } from "../../tooling/lib/repository.mjs";

function findLifecycleMarker(root: string): readonly string[] {
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === ".pactmark-canary-ran") matches.push(path);
      else if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return matches;
}

describe("public repository boundary", () => {
  it("contains no tracked private input or obvious credential file", () => {
    expect(gitFiles().filter((path) => /^(?:briefs|research)\//u.test(path))).toEqual([]);
    expect(
      gitFiles().filter(
        (path) =>
          /(^|\/)\.env(?:\.|$)/u.test(path) &&
          path !== ".env.example" &&
          !path.endsWith("/.env.example"),
      ),
    ).toEqual([]);
    expect(gitFiles().filter((path) => /\.(?:pem|p12|pfx|key)$/u.test(path))).toEqual([]);
  });

  it("denies dependency lifecycle scripts by default and pins reviewed exceptions", () => {
    const workspace = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("strictDepBuilds: true");
    const allowBuilds = workspace.match(/^allowBuilds:\n((?: {2}.*\n)+)/mu)?.[1];
    expect(allowBuilds).toBeTypeOf("string");
    const reviewed = [...String(allowBuilds).matchAll(/^ {2}(?:"([^"]+)"|([^:\s]+)):\s+true\b/gmu)]
      .map((match) => match[1] ?? match[2])
      .sort();
    expect(reviewed).toEqual([
      "bun",
      "esbuild@0.27.0",
      "esbuild@0.28.1",
      "sharp@0.35.3",
      "workerd@1.20260730.1",
    ]);
    expect(allowBuilds).not.toContain("set this to true or false");
  });

  it("does not execute a denied malicious postinstall canary", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pactmark-lifecycle-"));
    try {
      const fixture = join(repositoryRoot, "fixtures", "security", "malicious-postinstall-canary");
      const packed = JSON.parse(
        execFileSync("npm", ["pack", fixture, "--json", "--pack-destination", temporary], {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
        }),
      ) as readonly { readonly filename: string }[];
      const filename = packed[0]?.filename;
      expect(filename).toBeTypeOf("string");
      writeFileSync(
        join(temporary, "package.json"),
        `${JSON.stringify(
          {
            name: "pactmark-lifecycle-test",
            version: "1.0.0",
            private: true,
            dependencies: {
              "malicious-postinstall-canary": `file:./${String(filename)}`,
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(temporary, "pnpm-workspace.yaml"),
        ["strictDepBuilds: true", "allowBuilds:", "  malicious-postinstall-canary: false", ""].join(
          "\n",
        ),
      );
      const install = spawnSync(
        join(repositoryRoot, "node_modules", ".bin", "pnpm"),
        ["install", "--offline", "--store-dir", join(temporary, "pnpm-store")],
        {
          cwd: temporary,
          encoding: "utf8",
        },
      );
      expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
      expect(findLifecycleMarker(temporary)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("uses immutable references in every configured workflow", () => {
    const actionReference = /\buses:\s*([^\s#]+)@([^\s#]+)/gu;
    const mutable: string[] = [];
    for (const path of gitFiles().filter((entry) => entry.startsWith(".github/workflows/"))) {
      const content = readFileSync(join(repositoryRoot, path), "utf8");
      for (const match of content.matchAll(actionReference)) {
        const action = match[1] ?? "";
        const reference = match[2] ?? "";
        if (!action.startsWith("./") && !/^[0-9a-f]{40}$/u.test(reference)) {
          mutable.push(`${action}@${reference}`);
        }
      }
    }
    expect(mutable).toEqual([]);
  });

  it("pins the trusted-publishing package-manager toolchain without registry bootstrap", () => {
    const releaseWorkflow = readFileSync(
      join(repositoryRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(
      releaseWorkflow.match(/pnpm\/setup@84cb39b217b10273981911c288cd62326dc7c6d2/gu),
    ).toHaveLength(2);
    expect(releaseWorkflow.match(/version: 11\.18\.0/gu)).toHaveLength(2);
    expect(releaseWorkflow.match(/node-version: 24\.18\.1/gu)).toHaveLength(2);
    expect(releaseWorkflow.match(/npm --version\)" = "11\.16\.0"/gu)).toHaveLength(2);
    expect(releaseWorkflow).not.toContain("npm@latest");
    expect(releaseWorkflow).not.toContain("npm install --global");
  });
});
