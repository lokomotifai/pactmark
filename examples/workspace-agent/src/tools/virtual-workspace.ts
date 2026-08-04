export type VirtualEntry =
  | { readonly kind: "file"; content: string }
  | { readonly kind: "symlink"; readonly target: string };

export class VirtualWorkspace {
  readonly #entries = new Map<string, VirtualEntry>([
    ["workspace/README.md", { kind: "file", content: "Fixture project\n" }],
    ["workspace/config.txt", { kind: "file", content: "token=fixture-secret\nmode=test\n" }],
    ["workspace/link", { kind: "symlink", target: "/etc/passwd" }],
  ]);
  resolve(path: string): string {
    if (path.includes("\\") || path.startsWith("/") || path.includes("\0"))
      throw new TypeError("KAF_WORKSPACE_PATH_DENIED");
    const parts = path.split("/");
    if (
      parts.some((part) => part === "" || part === "." || part === "..") ||
      parts[0] !== "workspace"
    )
      throw new TypeError("KAF_WORKSPACE_PATH_DENIED");
    const normalized = parts.join("/");
    if (this.#entries.get(normalized)?.kind === "symlink")
      throw new TypeError("KAF_WORKSPACE_SYMLINK_DENIED");
    return normalized;
  }
  read(path: string): string {
    const normalized = this.resolve(path);
    const entry = this.#entries.get(normalized);
    if (entry?.kind !== "file") throw new TypeError("KAF_WORKSPACE_NOT_FOUND");
    return entry.content;
  }
  writeDraft(path: string, content: string): void {
    const normalized = this.resolve(path);
    if (!normalized.startsWith("workspace/drafts/"))
      throw new TypeError("KAF_WORKSPACE_WRITE_DENIED");
    this.#entries.set(normalized, { kind: "file", content });
  }
}
