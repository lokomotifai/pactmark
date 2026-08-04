import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
let workRoot = "";
let tarball = "";
let unpacked = "";

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "create-pactmark-pack-"));
  const packed = await run("npm", ["pack", "--json", "--pack-destination", workRoot], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_cache: path.join(workRoot, "npm-cache") },
  });
  const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarball = path.join(workRoot, result[0]!.filename);
  unpacked = path.join(workRoot, "unpacked");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(unpacked));
  await run("tar", ["-xzf", tarball, "-C", unpacked]);
}, 60_000);

afterAll(async () => {
  if (workRoot !== "") await rm(workRoot, { recursive: true, force: true });
});

describe("packed initializer", () => {
  it("contains only allowlisted runtime, metadata, documentation, and license files", async () => {
    const listed = await run("tar", ["-tzf", tarball]);
    const entries = listed.stdout.trim().split("\n");
    expect(entries).toContain("package/package.json");
    expect(entries).toContain("package/README.md");
    expect(entries).toContain("package/LICENSE");
    expect(entries).toContain("package/NOTICE");
    expect(entries).toContain("package/dist/bin.js");
    expect(
      entries.every((entry) =>
        /^package\/(?:dist\/|README\.md$|LICENSE$|NOTICE$|package\.json$)/u.test(entry),
      ),
    ).toBe(true);

    const manifest = JSON.parse(
      await readFile(path.join(unpacked, "package", "package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      publishConfig: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      name: "create-pactmark",
      version: "0.1.0",
      bin: { "create-pactmark": "./dist/bin.js" },
      publishConfig: { registry: "https://registry.npmjs.org/" },
    });
    expect(manifest.publishConfig).not.toHaveProperty("access");
  });

  it("executes the packed bin and retains all four embedded templates", async () => {
    const bin = path.join(unpacked, "package", "dist", "bin.js");
    await chmod(bin, 0o755);
    const version = await run(process.execPath, [bin, "--version"]);
    expect(version.stdout).toBe("0.1.0\n");

    for (const template of ["library", "node-server", "vercel-next", "cloudflare-worker"]) {
      const target = `packed-${template}`;
      const generated = await run(
        process.execPath,
        [
          bin,
          target,
          "--template",
          template,
          "--model",
          "mock-only",
          "--store",
          "memory",
          "--package-manager",
          "npm",
          "--yes",
          "--no-install",
          "--no-git",
          "--json",
        ],
        { cwd: workRoot },
      );
      const result = JSON.parse(generated.stdout) as { created: boolean; template: string };
      expect(result).toEqual(expect.objectContaining({ created: true, template }));
      const manifest = JSON.parse(
        await readFile(path.join(workRoot, target, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(manifest.dependencies["@pactmark/agent"]).toBe("0.1.0");
    }
  });

  it("resolves the declared binary through npm exec from the absolute tarball", async () => {
    const executed = await run(
      "npm",
      ["exec", "--offline", "--yes", `--package=${tarball}`, "--", "create-pactmark", "--version"],
      {
        cwd: workRoot,
        env: { ...process.env, npm_config_cache: path.join(workRoot, "exec-cache") },
      },
    );
    expect(executed.stdout).toBe("0.1.0\n");
  });
});
