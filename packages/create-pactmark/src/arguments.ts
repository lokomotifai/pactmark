import { InitializerError } from "./error.js";
import {
  MODEL_NAMES,
  PACKAGE_MANAGER_NAMES,
  STORE_NAMES,
  TEMPLATE_NAMES,
  type ModelName,
  type PackageManagerName,
  type ParsedArguments,
  type StoreName,
  type TemplateName,
} from "./types.js";

function optionValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InitializerError("KAF_INIT_ARGUMENT_INVALID", `${flag} requires a value.`);
  }
  return value;
}

function choice<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InitializerError(
    "KAF_INIT_ARGUMENT_INVALID",
    `${flag} must be one of: ${allowed.join(", ")}.`,
  );
}

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let target: string | undefined;
  let template: TemplateName | undefined;
  let model: ModelName | undefined;
  let store: StoreName | undefined;
  let packageManager: PackageManagerName | undefined;
  let yes = false;
  let install = true;
  let git = true;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined || argument === "--") continue;
    if (!argument.startsWith("-")) {
      if (target !== undefined) {
        throw new InitializerError(
          "KAF_INIT_ARGUMENT_INVALID",
          "Provide exactly one project target.",
        );
      }
      target = argument;
      continue;
    }
    switch (argument) {
      case "--help":
      case "-h":
        return { action: "help", yes, install, git, dryRun, json };
      case "--version":
      case "-v":
        return { action: "version", yes, install, git, dryRun, json };
      case "--template":
        template = choice(optionValue(arguments_, index, argument), TEMPLATE_NAMES, argument);
        index += 1;
        break;
      case "--model":
        model = choice(optionValue(arguments_, index, argument), MODEL_NAMES, argument);
        index += 1;
        break;
      case "--store":
        store = choice(optionValue(arguments_, index, argument), STORE_NAMES, argument);
        index += 1;
        break;
      case "--package-manager":
        packageManager = choice(
          optionValue(arguments_, index, argument),
          PACKAGE_MANAGER_NAMES,
          argument,
        );
        index += 1;
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--no-install":
        install = false;
        break;
      case "--no-git":
        git = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new InitializerError(
          "KAF_INIT_ARGUMENT_INVALID",
          `Unknown option ${argument}. Run create-pactmark --help.`,
        );
    }
  }

  return {
    action: "run",
    ...(target === undefined ? {} : { target }),
    ...(template === undefined ? {} : { template }),
    ...(model === undefined ? {} : { model }),
    ...(store === undefined ? {} : { store }),
    ...(packageManager === undefined ? {} : { packageManager }),
    yes,
    install,
    git,
    dryRun,
    json,
  };
}

export function detectPackageManager(userAgent: string | undefined): PackageManagerName {
  const name = userAgent?.split("/")[0]?.toLowerCase();
  return (PACKAGE_MANAGER_NAMES as readonly string[]).includes(name ?? "")
    ? (name as PackageManagerName)
    : "pnpm";
}
