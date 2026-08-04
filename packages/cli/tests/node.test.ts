import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { createNodeCliIo } from "../src/index.js";

describe("Node CLI environment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves paths, reads UTF-8, and returns undefined without a config", async () => {
    const io = createNodeCliIo({ cwd: import.meta.dirname, configPath: "", isTty: false });
    const fixturePath = join(import.meta.dirname, "fixture.txt");
    expect(io.resolvePath("fixture.txt")).toBe(fixturePath);
    expect(io.resolvePath(import.meta.filename)).toBe(import.meta.filename);
    await expect(io.readTextFile(fixturePath)).resolves.toContain("fixture");
    await expect(io.loadHost()).resolves.toBeUndefined();
  });

  it("loads a structurally valid explicit host module", async () => {
    const io = createNodeCliIo({ cwd: import.meta.dirname, configPath: "fixtures/host.mjs" });
    await expect(io.loadHost()).resolves.toMatchObject({ runtime: {}, authority: {} });
  });

  it("rejects a module that is not a host", async () => {
    const io = createNodeCliIo({ cwd: import.meta.dirname, configPath: "fixtures/not-host.mjs" });
    await expect(io.loadHost()).resolves.toBeUndefined();
  });

  it("uses process defaults only as inert byte writers", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const io = createNodeCliIo({ configPath: "" });
    io.writeStdout("safe");
    io.writeStderr("safe-error");
    expect(stdout).toHaveBeenCalledWith("safe");
    expect(stderr).toHaveBeenCalledWith("safe-error");
  });
});
