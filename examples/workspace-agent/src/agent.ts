import type { DraftArtifact, SandboxAdapterContract, WorkspaceBudget } from "./contract.js";
import { workspacePolicy } from "./policy.js";
import { VirtualWorkspace } from "./tools/virtual-workspace.js";
import { createDraftArtifact } from "./verifiers/draft.js";

export const containerIsolationFixture: SandboxAdapterContract = Object.freeze({
  adapterKind: "container_contract_fixture",
  network: "none",
  nonRoot: workspacePolicy.denySymlinks,
  productionIsolationClaim: workspacePolicy.productionSecurityBoundary,
});
export class WorkspaceAgentHarness {
  readonly #workspace = new VirtualWorkspace();
  readonly #budget: WorkspaceBudget;
  #commands = 0;
  constructor(budget: WorkspaceBudget = { maxCommands: 3, maxOutputBytes: 128, timeoutMs: 100 }) {
    this.#budget = budget;
  }
  read(path: string, options: Readonly<{ elapsedMs?: number; signal?: AbortSignal }> = {}): string {
    this.#admit(options);
    return this.#bounded(redact(this.#workspace.read(path)));
  }
  writeDraft(
    path: string,
    content: string,
    options: Readonly<{ elapsedMs?: number; signal?: AbortSignal }> = {},
  ): DraftArtifact {
    this.#admit(options);
    const safe = redact(content);
    this.#workspace.writeDraft(path, safe);
    return createDraftArtifact(path, safe);
  }
  #admit(options: Readonly<{ elapsedMs?: number; signal?: AbortSignal }>): void {
    if (options.signal?.aborted === true) throw new TypeError("KAF_WORKSPACE_CANCELLED");
    if ((options.elapsedMs ?? 0) >= this.#budget.timeoutMs)
      throw new TypeError("KAF_WORKSPACE_TIMEOUT");
    this.#commands += 1;
    if (this.#commands > this.#budget.maxCommands)
      throw new TypeError("KAF_WORKSPACE_COMMAND_BUDGET_EXCEEDED");
  }
  #bounded(value: string): string {
    if (new TextEncoder().encode(value).byteLength > this.#budget.maxOutputBytes)
      throw new TypeError("KAF_WORKSPACE_OUTPUT_LIMIT_EXCEEDED");
    return value;
  }
}
function redact(value: string): string {
  return value
    .replace(/\b(token|secret|password)=[^\s]+/giu, "$1=[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
}
