import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { detectPackageManager, parseArguments } from "./arguments.js";
import { asInitializerError, InitializerError } from "./error.js";
import { createProject } from "./initializer.js";
import {
  FRAMEWORK_VERSION,
  MODEL_NAMES,
  PACKAGE_MANAGER_NAMES,
  STORE_NAMES,
  TEMPLATE_NAMES,
  type InitializerDependencies,
  type InitializerOptions,
  type ModelName,
  type PackageManagerName,
  type StoreName,
  type TemplateName,
} from "./types.js";

export const HELP_TEXT = `create-pactmark ${FRAMEWORK_VERSION}

Usage:
  create-pactmark <target> [options]

Options:
  --template <vercel-next|node-server|cloudflare-worker|library>
  --model <ai-sdk|mock-only>
  --store <memory|postgres>
  --package-manager <pnpm|npm|yarn|bun>
  --yes                 Accept deterministic recommended defaults
  --no-install          Do not install generated dependencies
  --no-git              Do not initialize a local Git repository
  --dry-run             Print the exact plan and write nothing
  --json                Emit stable schema-versioned JSON
  --version, -v         Print the initializer version
  --help, -h            Show this help
`;

export interface Prompter {
  input(message: string, defaultValue: string): Promise<string>;
  select<T extends string>(message: string, choices: readonly T[], defaultValue: T): Promise<T>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

export interface CliIO {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

export interface CliDependencies extends InitializerDependencies {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io?: CliIO;
  readonly prompter?: Prompter;
  readonly signal?: AbortSignal;
}

/* v8 ignore start -- exercised only through a real TTY; prompt policy is tested via the port. */
function defaultPrompter(): Prompter {
  const terminal = createInterface({ input: stdin, output: stdout });
  return {
    async input(message, defaultValue) {
      const answer = (await terminal.question(`${message} (${defaultValue}) `)).trim();
      return answer.length === 0 ? defaultValue : answer;
    },
    async select(message, choices, defaultValue) {
      const answer = (
        await terminal.question(`${message} [${choices.join("/")}] (${defaultValue}) `)
      )
        .trim()
        .toLowerCase();
      if (answer.length === 0) return defaultValue;
      if ((choices as readonly string[]).includes(answer)) return answer as typeof defaultValue;
      throw new InitializerError(
        "KAF_INIT_ARGUMENT_INVALID",
        `Choose one of: ${choices.join(", ")}.`,
      );
    },
    async confirm(message, defaultValue) {
      const marker = defaultValue ? "Y/n" : "y/N";
      const answer = (await terminal.question(`${message} [${marker}] `)).trim().toLowerCase();
      if (answer.length === 0) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      throw new InitializerError("KAF_INIT_ARGUMENT_INVALID", "Answer yes or no.");
    },
    close() {
      terminal.close();
    },
  };
}
/* v8 ignore stop */

async function resolveOptions(
  parsed: ReturnType<typeof parseArguments>,
  dependencies: CliDependencies,
): Promise<InitializerOptions> {
  const detected = detectPackageManager(dependencies.env?.npm_config_user_agent);
  if (parsed.yes) {
    if (parsed.target === undefined) {
      throw new InitializerError("KAF_INIT_ARGUMENT_INVALID", "Provide a target when using --yes.");
    }
    return {
      ...(dependencies.cwd === undefined ? {} : { cwd: dependencies.cwd }),
      target: parsed.target,
      template: parsed.template ?? "vercel-next",
      model: parsed.model ?? "mock-only",
      store: parsed.store ?? "memory",
      packageManager: parsed.packageManager ?? detected,
      install: parsed.install,
      git: parsed.git,
      dryRun: parsed.dryRun,
      json: parsed.json,
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    };
  }

  const prompt = dependencies.prompter ?? defaultPrompter();
  try {
    const target = parsed.target ?? (await prompt.input("Project name", "my-agent"));
    const template =
      parsed.template ??
      (await prompt.select<TemplateName>("Template", TEMPLATE_NAMES, "vercel-next"));
    const model =
      parsed.model ?? (await prompt.select<ModelName>("Model", MODEL_NAMES, "mock-only"));
    const store = parsed.store ?? (await prompt.select<StoreName>("Store", STORE_NAMES, "memory"));
    const packageManager =
      parsed.packageManager ??
      (await prompt.select<PackageManagerName>("Package manager", PACKAGE_MANAGER_NAMES, detected));
    let install = parsed.install;
    let git = parsed.git;
    if (install && git) {
      const setup = await prompt.confirm("Install dependencies and initialize local Git", true);
      install = setup;
      git = setup;
    } else if (install) {
      install = await prompt.confirm("Install dependencies", true);
    } else if (git) {
      git = await prompt.confirm("Initialize local Git", true);
    }
    return {
      ...(dependencies.cwd === undefined ? {} : { cwd: dependencies.cwd }),
      target,
      template,
      model,
      store,
      packageManager,
      install,
      git,
      dryRun: parsed.dryRun,
      json: parsed.json,
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    };
  } finally {
    prompt.close();
  }
}

function renderHuman(result: Awaited<ReturnType<typeof createProject>>): string {
  const status = result.created ? "Created" : "Dry run";
  const files = result.files.map((file) => `  ${file.path} ${file.digest}`).join("\n");
  const dependencies = Object.entries(result.dependencies)
    .map(([name, version]) => `  ${name}@${version}`)
    .join("\n");
  return `${status}: ${result.targetPath}\nTemplate: ${result.template}@${result.templateFormatVersion}\nFiles:\n${files}\nDependencies:\n${dependencies}\nWarnings:\n${result.warnings.map((warning) => `  ${warning}`).join("\n")}\nNext:\n${result.nextCommands.map((command) => `  ${command}`).join("\n")}\n`;
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? { stdout, stderr: process.stderr };
  let json = arguments_.includes("--json");
  try {
    const parsed = parseArguments(arguments_);
    json = parsed.json;
    if (parsed.action === "help") {
      io.stdout.write(HELP_TEXT);
      return 0;
    }
    if (parsed.action === "version") {
      io.stdout.write(`${FRAMEWORK_VERSION}\n`);
      return 0;
    }
    const options = await resolveOptions(parsed, dependencies);
    const result = await createProject(options, dependencies);
    io.stdout.write(json ? `${JSON.stringify(result)}\n` : renderHuman(result));
    return 0;
  } catch (error) {
    const safe = asInitializerError(error);
    io.stderr.write(
      json ? `${JSON.stringify(safe)}\n` : `${safe.code}: ${safe.message} ${safe.remediation}\n`,
    );
    return 1;
  }
}
