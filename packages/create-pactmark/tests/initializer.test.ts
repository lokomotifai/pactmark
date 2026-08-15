import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InitializerError,
  TEMPLATE_NAMES,
  asInitializerError,
  createProject,
  initializerInternals,
  planProject,
  type CommandRunner,
  type InitializerOptions,
} from "../src/index.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "create-pactmark-test-")),
  );
  roots.push(value);
  return value;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function options(cwd: string, overrides: Partial<InitializerOptions> = {}): InitializerOptions {
  return {
    cwd,
    target: "my-agent",
    template: "library",
    model: "mock-only",
    store: "memory",
    packageManager: "pnpm",
    install: false,
    git: false,
    dryRun: false,
    json: false,
    ...overrides,
  };
}

describe("initializer planning", () => {
  it("returns a stable, exact, secret-free plan", async () => {
    const cwd = await root();
    const first = await planProject(options(cwd));
    const second = await planProject(options(cwd));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: "1",
      templateFormatVersion: "1",
      frameworkVersion: "0.2.0",
      projectName: "my-agent",
      template: "library",
      model: "mock-only",
      store: "memory",
      packageManager: "pnpm",
    });
    expect(first.targetPath).toBe(path.join(cwd, "my-agent"));
    expect(first.files.every((file) => /^sha256:[a-f0-9]{64}$/u.test(file.digest))).toBe(true);
    expect(first.files.map((file) => file.path)).toEqual(
      [...first.files.map((file) => file.path)].sort(),
    );
    expect(JSON.stringify(first)).not.toMatch(/sk-[a-z0-9]/iu);
  });

  it("rejects path escapes, absolute paths, reserved names, controls, and shell syntax", async () => {
    const cwd = await root();
    const invalid = [
      "",
      "../escape",
      "/absolute",
      "C:\\absolute",
      "con",
      "COM1.txt",
      "bad name",
      "name.",
      "name ",
      "bad;touch",
      "bad\u0007name",
      "UPPER",
      "a//b",
    ];
    for (const target of invalid) {
      await expect(planProject(options(cwd, { target }))).rejects.toMatchObject({
        code: "KAF_INIT_TARGET_INVALID",
      });
    }
  });

  it("validates embedded file paths, duplicates, content, and secrets", () => {
    for (const files of [
      [{ path: "../escape", content: "safe" }],
      [
        { path: "same", content: "one" },
        { path: "same", content: "two" },
      ],
      [{ path: "safe", content: "bad\u0000content" }],
      [{ path: "safe", content: "API_KEY=exposed-value" }],
    ]) {
      expect(() => {
        initializerInternals.validateFiles(files);
      }).toThrow(InitializerError);
    }
  });

  it("normalizes aborts and hides arbitrary errors", () => {
    expect(asInitializerError(new DOMException("cancel", "AbortError"))).toMatchObject({
      code: "KAF_INIT_ABORTED",
    });
    expect(asInitializerError(new Error("raw provider body"))).toMatchObject({
      code: "KAF_INIT_COMMAND_FAILED",
    });
  });
});

describe("atomic generation", () => {
  it("writes nothing during dry-run", async () => {
    const cwd = await root();
    const result = await createProject(options(cwd, { dryRun: true }));
    expect(result.created).toBe(false);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("creates every template from the same embedded package", async () => {
    const cwd = await root();
    for (const template of TEMPLATE_NAMES) {
      const target = `agent-${template}`;
      const result = await createProject(options(cwd, { target, template }));
      expect(result.created).toBe(true);
      const manifest = JSON.parse(
        await readFile(path.join(cwd, target, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(manifest.dependencies["@pactmark/agent"]).toBe("0.2.0");
      expect(await readFile(path.join(cwd, target, "src/host.ts"), "utf8")).toContain(
        "createDeclaredToolExecutor",
      );
      expect((await readdir(cwd)).some((entry) => entry.includes(".pactmark-"))).toBe(false);
    }
  });

  it("accepts an existing empty target but rejects occupied targets and symlinks", async () => {
    const cwd = await root();
    await mkdir(path.join(cwd, "empty"));
    await expect(createProject(options(cwd, { target: "empty" }))).resolves.toMatchObject({
      created: true,
    });

    await mkdir(path.join(cwd, "occupied"));
    await writeFile(path.join(cwd, "occupied", "keep.txt"), "keep");
    await expect(createProject(options(cwd, { target: "occupied" }))).rejects.toMatchObject({
      code: "KAF_INIT_TARGET_EXISTS",
    });
    expect(await readFile(path.join(cwd, "occupied", "keep.txt"), "utf8")).toBe("keep");

    await mkdir(path.join(cwd, "real-parent"));
    await symlink(path.join(cwd, "real-parent"), path.join(cwd, "linked-parent"));
    await expect(
      createProject(options(cwd, { target: "linked-parent/project" })),
    ).rejects.toMatchObject({ code: "KAF_INIT_TARGET_INVALID" });
  });

  it("runs only fixed setup commands inside the sibling temporary directory", async () => {
    const cwd = await root();
    const calls: Array<readonly [string, readonly string[], string]> = [];
    const runner: CommandRunner = {
      run(command, arguments_, commandCwd) {
        calls.push([command, arguments_, commandCwd]);
        return Promise.resolve();
      },
    };
    await createProject(
      options(cwd, { target: "setup", install: true, git: true, packageManager: "npm" }),
      { commandRunner: runner },
    );
    expect(calls.map(([command, arguments_]) => [command, arguments_])).toEqual([
      ["npm", ["install", "--ignore-scripts"]],
      ["git", ["init", "--quiet"]],
    ]);
    expect(calls.every(([, , commandCwd]) => path.dirname(commandCwd) === cwd)).toBe(true);
    expect(calls.every(([, , commandCwd]) => commandCwd !== path.join(cwd, "setup"))).toBe(true);
  });

  it("uses safe install arguments for every supported package manager", () => {
    expect(initializerInternals.installCommand("pnpm")).toEqual([
      "pnpm",
      ["install", "--ignore-scripts"],
    ]);
    expect(initializerInternals.installCommand("npm")).toEqual([
      "npm",
      ["install", "--ignore-scripts"],
    ]);
    expect(initializerInternals.installCommand("yarn")).toEqual([
      "yarn",
      ["install", "--mode=skip-builds"],
    ]);
    expect(initializerInternals.installCommand("bun")).toEqual([
      "bun",
      ["install", "--ignore-scripts"],
    ]);
  });

  it("executes fixed local commands without a shell and reports failures", async () => {
    const cwd = await root();
    await expect(
      initializerInternals.runLocalCommand(process.execPath, ["-e", "process.exit(0)"], cwd),
    ).resolves.toBeUndefined();
    await expect(
      initializerInternals.runLocalCommand(process.execPath, ["-e", "process.exit(7)"], cwd),
    ).rejects.toMatchObject({ code: "KAF_INIT_COMMAND_FAILED" });
  });

  it("cleans temporary state after command failure and cancellation", async () => {
    const cwd = await root();
    const runner: CommandRunner = {
      run: vi.fn(() => Promise.reject(new Error("sensitive raw cause"))),
    };
    await expect(
      createProject(options(cwd, { target: "failed", install: true }), {
        commandRunner: runner,
      }),
    ).rejects.toThrow("sensitive raw cause");
    expect(await readdir(cwd)).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      createProject(options(cwd, { target: "cancelled", signal: controller.signal })),
    ).rejects.toMatchObject({ code: "KAF_INIT_ABORTED" });
    expect(await readdir(cwd)).toEqual([]);

    const during = new AbortController();
    await expect(
      createProject(
        options(cwd, { target: "cancelled-during-install", install: true, signal: during.signal }),
        {
          commandRunner: {
            run: () => {
              during.abort();
              return Promise.resolve();
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_INIT_ABORTED" });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("revalidates embedded files after setup commands and before atomic rename", async () => {
    const cwd = await root();
    await expect(
      createProject(options(cwd, { target: "mutated", install: true }), {
        commandRunner: {
          run: async (_command, _arguments, commandCwd) => {
            await writeFile(path.join(commandCwd, "package.json"), '{"name":"tampered"}\n');
          },
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_INIT_TEMPLATE_INVALID" });
    expect(await readdir(cwd)).toEqual([]);

    await mkdir(path.join(cwd, "empty-mutated"));
    await expect(
      createProject(options(cwd, { target: "empty-mutated", install: true }), {
        commandRunner: {
          run: async (_command, _arguments, commandCwd) => {
            await writeFile(path.join(commandCwd, "package.json"), '{"name":"tampered"}\n');
          },
        },
      }),
    ).rejects.toMatchObject({ code: "KAF_INIT_TEMPLATE_INVALID" });
    expect(await readdir(path.join(cwd, "empty-mutated"))).toEqual([]);
    expect(await readdir(cwd)).toEqual(["empty-mutated"]);
  });

  it("classifies files and missing targets safely", async () => {
    const cwd = await root();
    const file = path.join(cwd, "file");
    await writeFile(file, "value");
    expect(await initializerInternals.targetState(file)).toBe("occupied");
    expect(await initializerInternals.targetState(path.join(cwd, "missing"))).toBe("missing");
    expect((await lstat(file)).isFile()).toBe(true);
  });

  it("requires nested parent directories to exist", async () => {
    const cwd = await root();
    await expect(
      createProject(options(cwd, { target: "missing-parent/project" })),
    ).rejects.toMatchObject({ code: "KAF_INIT_TARGET_INVALID" });
    expect(await readdir(cwd)).toEqual([]);
  });
});
