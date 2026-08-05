import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HELP_TEXT, runCli, type Prompter } from "../src/index.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "create-pactmark-cli-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function output() {
  let out = "";
  let error = "";
  return {
    io: {
      stdout: { write: (value: string) => (out += value) },
      stderr: { write: (value: string) => (error += value) },
    },
    out: () => out,
    error: () => error,
  };
}

describe("CLI", () => {
  it("renders help and version without touching disk", async () => {
    const help = output();
    expect(await runCli(["--help"], { io: help.io })).toBe(0);
    expect(help.out()).toBe(HELP_TEXT);
    expect(help.error()).toBe("");

    const version = output();
    expect(await runCli(["--version"], { io: version.io })).toBe(0);
    expect(version.out()).toBe("0.1.1\n");
  });

  it("emits stable JSON for a complete no-prompt dry run", async () => {
    const cwd = await root();
    const printed = output();
    const status = await runCli(
      [
        "json-agent",
        "--template",
        "vercel-next",
        "--model",
        "ai-sdk",
        "--store",
        "postgres",
        "--package-manager",
        "npm",
        "--yes",
        "--no-install",
        "--no-git",
        "--dry-run",
        "--json",
      ],
      { cwd, io: printed.io },
    );
    expect(status).toBe(0);
    const result = JSON.parse(printed.out()) as {
      schemaVersion: string;
      created: boolean;
      targetPath: string;
      dependencies: Record<string, string>;
    };
    expect(result).toMatchObject({
      schemaVersion: "1",
      created: false,
      targetPath: path.join(cwd, "json-agent"),
    });
    expect(result.dependencies["@pactmark/ai-sdk"]).toBe("0.1.1");
    expect(await readdir(cwd)).toEqual([]);
  });

  it("uses only the six documented interactive prompt subjects", async () => {
    const cwd = await root();
    const subjects: string[] = [];
    const close = vi.fn();
    const prompt: Prompter = {
      input(message) {
        subjects.push(message);
        return Promise.resolve("interactive-agent");
      },
      select(message, _choices, defaultValue) {
        subjects.push(message);
        return Promise.resolve(defaultValue);
      },
      confirm(message) {
        subjects.push(message);
        return Promise.resolve(false);
      },
      close,
    };
    const printed = output();
    expect(
      await runCli(["--dry-run"], {
        cwd,
        env: { npm_config_user_agent: "npm/12.0.2" },
        io: printed.io,
        prompter: prompt,
      }),
    ).toBe(0);
    expect(subjects).toEqual([
      "Project name",
      "Template",
      "Model",
      "Store",
      "Package manager",
      "Install dependencies and initialize local Git",
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(printed.out()).toContain("Dry run:");
  });

  it("creates a project and renders a bounded human summary", async () => {
    const cwd = await root();
    const printed = output();
    expect(
      await runCli(["made", "--template", "library", "--yes", "--no-install", "--no-git"], {
        cwd,
        io: printed.io,
      }),
    ).toBe(0);
    expect(printed.out()).toContain(`Created: ${path.join(cwd, "made")}`);
    expect(await readdir(path.join(cwd, "made"))).toContain("package.json");
  });

  it("returns only a stable safe error shape", async () => {
    const cwd = await root();
    const printed = output();
    expect(await runCli(["../escape", "--yes", "--json"], { cwd, io: printed.io })).toBe(1);
    expect(printed.out()).toBe("");
    expect(JSON.parse(printed.error())).toEqual({
      schemaVersion: "1",
      code: "KAF_INIT_TARGET_INVALID",
      message: "The project target is invalid.",
      remediation:
        "Remove traversal, reserved names, controls, shell characters, and trailing dots or spaces.",
    });
    expect(printed.error()).not.toContain("stack");
  });

  it("requires a target in yes mode and closes prompts after interactive errors", async () => {
    const missing = output();
    expect(await runCli(["--yes"], { io: missing.io })).toBe(1);
    expect(missing.error()).toContain("KAF_INIT_ARGUMENT_INVALID");

    const close = vi.fn();
    const prompt: Prompter = {
      input: () => Promise.reject(new Error("untrusted prompt error")),
      select: vi.fn(),
      confirm: vi.fn(),
      close,
    };
    const failed = output();
    expect(await runCli([], { io: failed.io, prompter: prompt })).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(failed.error()).not.toContain("untrusted prompt error");
    expect(failed.error()).toContain("KAF_INIT_COMMAND_FAILED");
  });
});
