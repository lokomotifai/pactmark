export const VERSION = "0.1.0";

const ROOT = `Pactmark ${VERSION}

Usage: pactmark <command> [options]

Commands:
  dev
  compile
  run <agent> --input <file-or-json>
  inspect <runId>
  events <runId> [--after <sequence>]
  replay <runId>
  doctor [--profile local|preview|production] [--production]
  test [scenario]
  eval [suite]
  evidence export <runId> [--format json|md]
  evidence verify <path>
  audit verify <runId>
  migrate status|up
  policy explain <fixture>
  effects reconcile <runId> <effectId> --resolution <file-or-json>
  effects compensate <runId> <effectId> --request <file-or-json>

Global options: --json --debug --help --version`;

const HELP: Readonly<Record<string, string>> = Object.freeze({
  dev: "Usage: pactmark dev [--json]",
  compile:
    "Usage: pactmark compile [--json]\n\nReads AGENT.md and optional skills/* inputs, then atomically writes .pactmark/generated/agent-manifest.json.",
  run: "Usage: pactmark run <agent> --input <file-or-json> [--json]",
  inspect: "Usage: pactmark inspect <runId> [--json]",
  events: "Usage: pactmark events <runId> [--after <sequence>] [--json]",
  replay:
    "Usage: pactmark replay <runId> [--json]\n\nVerifies a terminal run from stored events and artifacts without executing tools or models.",
  doctor: "Usage: pactmark doctor [--profile local|preview|production] [--production] [--json]",
  test: "Usage: pactmark test [scenario] [--json]",
  eval: "Usage: pactmark eval [suite] [--json]",
  evidence:
    "Usage: pactmark evidence export <runId> [--format json|md] [--json]\n       pactmark evidence verify <path> [--json]",
  audit: "Usage: pactmark audit verify <runId> [--json]",
  migrate: "Usage: pactmark migrate status|up [--json]",
  policy: "Usage: pactmark policy explain <fixture> [--json]",
  effects:
    "Usage: pactmark effects reconcile <runId> <effectId> --resolution <file-or-json> [--json]\n       pactmark effects compensate <runId> <effectId> --request <file-or-json> [--json]",
});

export function helpFor(command?: string): string {
  return command === undefined ? ROOT : (HELP[command] ?? ROOT);
}
