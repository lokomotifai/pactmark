import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { compileAgentPackage } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pactmark-cli-compile-"));
  roots.push(parent);
  const project = join(parent, "project");
  await mkdir(project);
  await writeFile(join(project, "AGENT.md"), "# Agent\r\n\r\nFollow policy.\r\n", "utf8");
  return project;
}

describe("compileAgentPackage", () => {
  it("materializes deterministic normalized instructions and skills", async () => {
    const root = await workspace();
    await mkdir(join(root, "skills", "review", "resources"), { recursive: true });
    await mkdir(join(root, ".pactmark"), { recursive: true });
    await writeFile(
      join(root, ".pactmark", "capabilities.json"),
      JSON.stringify({ schemaVersion: "1", capabilities: ["artifact.read"] }),
    );
    await writeFile(
      join(root, "skills", "review", "skill.json"),
      JSON.stringify({
        schemaVersion: "1",
        id: "review",
        version: "1.0.0",
        description: "Review an artifact",
        compatibility: { pactmarkCore: "^0.1.0", runtimes: ["portable"] },
        requiredCapabilities: ["artifact.read"],
      }),
    );
    await writeFile(join(root, "skills", "review", "SKILL.md"), "\uFEFF# Review\r\nSafely.\r\n");
    await writeFile(
      join(root, "skills", "review", "resources", "schema.bin"),
      new Uint8Array([0, 1, 2]),
    );
    const first = await compileAgentPackage(root);
    const firstOutput = await readFile(join(root, first.manifestPath), "utf8");
    const second = await compileAgentPackage(root);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(await readFile(join(root, second.manifestPath), "utf8")).toBe(firstOutput);
    expect(first.requiredCapabilities).toEqual(["artifact.read"]);
    expect(firstOutput).not.toContain("\\r");
    const concurrent = await Promise.all([
      compileAgentPackage(root),
      compileAgentPackage(root),
      compileAgentPackage(root),
    ]);
    expect(new Set(concurrent.map(({ sourceDigest }) => sourceDigest))).toEqual(
      new Set([first.sourceDigest]),
    );
    expect(await readdir(join(root, ".pactmark", "generated"))).toEqual(["agent-manifest.json"]);
  });

  it("fails closed on unresolved capabilities, stale schemas, and secrets", async () => {
    const unresolved = await workspace();
    await mkdir(join(unresolved, "skills", "review"), { recursive: true });
    await writeFile(
      join(unresolved, "skills", "review", "skill.json"),
      JSON.stringify({
        schemaVersion: "1",
        id: "review",
        version: "1.0.0",
        description: "Review",
        compatibility: { pactmarkCore: "^0.1.0", runtimes: ["portable"] },
        requiredCapabilities: ["missing.capability"],
      }),
    );
    await writeFile(join(unresolved, "skills", "review", "SKILL.md"), "# Review\n");
    await expect(compileAgentPackage(unresolved)).rejects.toMatchObject({
      code: "KAF_CLI_COMPILE_INVALID",
    });

    const stale = await workspace();
    await mkdir(join(stale, ".pactmark"), { recursive: true });
    await writeFile(
      join(stale, ".pactmark", "capabilities.json"),
      JSON.stringify({ schemaVersion: "0", capabilities: [] }),
    );
    await expect(compileAgentPackage(stale)).rejects.toMatchObject({
      code: "KAF_CLI_COMPILE_INVALID",
    });

    const secret = await workspace();
    await writeFile(join(secret, "AGENT.md"), "token=abcdefghijklmnop\n");
    await expect(compileAgentPackage(secret)).rejects.toMatchObject({
      code: "KAF_CLI_COMPILE_SECRET_DETECTED",
    });
  });

  it("rejects output path symlinks without writing outside the project", async () => {
    const pactmarkLink = await workspace();
    const firstOutside = join(pactmarkLink, "..", "outside-pactmark");
    await mkdir(firstOutside);
    await symlink(firstOutside, join(pactmarkLink, ".pactmark"));
    await expect(compileAgentPackage(pactmarkLink)).rejects.toMatchObject({
      code: "KAF_CLI_COMPILE_INVALID",
    });
    expect(await readdir(firstOutside)).toEqual([]);

    const generatedLink = await workspace();
    const secondOutside = join(generatedLink, "..", "outside-generated");
    await mkdir(secondOutside);
    await mkdir(join(generatedLink, ".pactmark"));
    await symlink(secondOutside, join(generatedLink, ".pactmark", "generated"));
    await expect(compileAgentPackage(generatedLink)).rejects.toMatchObject({
      code: "KAF_CLI_COMPILE_INVALID",
    });
    expect(await readdir(secondOutside)).toEqual([]);
  });
});
