import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const examplesRoot = join(repositoryRoot, "examples");
const commands: ReadonlyArray<Readonly<{ directory: string; command: string }>> = readdirSync(
  examplesRoot,
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const readme = readFileSync(join(examplesRoot, entry.name, "README.md"), "utf8");
    return [...readme.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((match) =>
      (match[1] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("pnpm --filter pactmark-example-"))
        .map((command) => ({ directory: entry.name, command })),
    );
  });

if (commands.length === 0) throw new Error("KAF_EXAMPLE_README_COMMANDS_MISSING");

const allowed = /^pnpm --filter (pactmark-example-[a-z0-9-]+) (test|typecheck|build|dev)$/u;
const pnpm = join(repositoryRoot, "node_modules", ".bin", "pnpm");
for (const entry of commands) {
  const match = allowed.exec(entry.command);
  if (match === null) throw new Error(`KAF_EXAMPLE_README_COMMAND_UNSAFE:${entry.command}`);
  const packageName = match[1];
  const script = match[2];
  if (packageName === undefined || script === undefined) {
    throw new Error("KAF_EXAMPLE_README_COMMAND_INVALID");
  }
  const result = spawnSync(pnpm, ["--filter", packageName, script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`KAF_EXAMPLE_README_COMMAND_FAILED:${entry.directory}:${script}`);
  }
}

process.stdout.write(`Executed ${String(commands.length)} documented example commands.\n`);
