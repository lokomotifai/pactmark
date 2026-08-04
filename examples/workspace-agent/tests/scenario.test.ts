import { describe, expect, it } from "vitest";
import { WorkspaceAgentHarness, containerIsolationFixture } from "../src/agent.js";
describe("workspace agent", () => {
  it("reads only the allowlisted virtual root and produces redacted drafts", () => {
    const agent = new WorkspaceAgentHarness();
    expect(agent.read("workspace/README.md")).toBe("Fixture project\n");
    expect(agent.read("workspace/config.txt")).toContain("token=[REDACTED]");
    const draft = agent.writeDraft("workspace/drafts/report.md", "password=hunter2 sk-abcdefgh");
    expect(draft).toMatchObject({ path: "workspace/drafts/report.md", status: "draft" });
    expect(draft.contentDigest).toMatch(/^sha256:/u);
  });
  it.each(["../secret", "/etc/passwd", "workspace\\..\\secret", "workspace/link"])(
    "denies traversal or symlink path %s",
    (path) => {
      const agent = new WorkspaceAgentHarness();
      expect(() => agent.read(path)).toThrow(/^KAF_WORKSPACE_(?:PATH|SYMLINK)_DENIED$/u);
    },
  );
  it("enforces command, output, timeout, and cancellation limits", () => {
    const budgeted = new WorkspaceAgentHarness({
      maxCommands: 1,
      maxOutputBytes: 128,
      timeoutMs: 100,
    });
    budgeted.read("workspace/README.md");
    expect(() => budgeted.read("workspace/README.md")).toThrow(
      "KAF_WORKSPACE_COMMAND_BUDGET_EXCEEDED",
    );
    expect(() =>
      new WorkspaceAgentHarness({ maxCommands: 2, maxOutputBytes: 3, timeoutMs: 100 }).read(
        "workspace/README.md",
      ),
    ).toThrow("KAF_WORKSPACE_OUTPUT_LIMIT_EXCEEDED");
    expect(() =>
      new WorkspaceAgentHarness().read("workspace/README.md", { elapsedMs: 100 }),
    ).toThrow("KAF_WORKSPACE_TIMEOUT");
    const cancellation = new AbortController();
    cancellation.abort();
    expect(() =>
      new WorkspaceAgentHarness().read("workspace/README.md", { signal: cancellation.signal }),
    ).toThrow("KAF_WORKSPACE_CANCELLED");
  });
  it("labels the container fixture without a production isolation claim", () => {
    expect(containerIsolationFixture).toEqual({
      adapterKind: "container_contract_fixture",
      network: "none",
      nonRoot: true,
      productionIsolationClaim: false,
    });
  });
});
