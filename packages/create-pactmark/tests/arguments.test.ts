import { describe, expect, it } from "vitest";

import { InitializerError, detectPackageManager, parseArguments } from "../src/index.js";

describe("argument parsing", () => {
  it("parses the complete non-interactive contract", () => {
    expect(
      parseArguments([
        "my-agent",
        "--template",
        "node-server",
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
      ]),
    ).toEqual({
      action: "run",
      target: "my-agent",
      template: "node-server",
      model: "ai-sdk",
      store: "postgres",
      packageManager: "npm",
      yes: true,
      install: false,
      git: false,
      dryRun: true,
      json: true,
    });
  });

  it("supports help and version aliases", () => {
    expect(parseArguments(["-h"]).action).toBe("help");
    expect(parseArguments(["--help"]).action).toBe("help");
    expect(parseArguments(["-v"]).action).toBe("version");
    expect(parseArguments(["--version"]).action).toBe("version");
  });

  it("rejects unknown, missing, invalid, and repeated values", () => {
    for (const arguments_ of [["--wat"], ["--template"], ["--template", "unknown"], ["a", "b"]]) {
      expect(() => parseArguments(arguments_)).toThrow(InitializerError);
    }
  });

  it("detects supported managers and safely defaults", () => {
    expect(detectPackageManager("npm/12.0.2 node/v24")).toBe("npm");
    expect(detectPackageManager("pnpm/11.18.0 node/v24")).toBe("pnpm");
    expect(detectPackageManager("yarn/4.10.3 node/v24")).toBe("yarn");
    expect(detectPackageManager("bun/1.3.9")).toBe("bun");
    expect(detectPackageManager("unknown/1")).toBe("pnpm");
    expect(detectPackageManager(undefined)).toBe("pnpm");
  });
});
