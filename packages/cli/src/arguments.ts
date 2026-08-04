import { CliError } from "./error.js";

export interface ParsedArguments {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

const VALUE_OPTIONS = new Set(["input", "format", "profile", "after", "resolution", "request"]);

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      const equal = value.indexOf("=");
      const name = value.slice(2, equal === -1 ? undefined : equal);
      if (name.length === 0 || Object.hasOwn(options, name))
        throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: name || "--" } });
      if (VALUE_OPTIONS.has(name)) {
        const optionValue = equal === -1 ? argv[index + 1] : value.slice(equal + 1);
        if (optionValue === undefined || optionValue.startsWith("--"))
          throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: name } });
        options[name] = optionValue;
        if (equal === -1) index += 1;
      } else {
        if (equal !== -1)
          throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: name } });
        options[name] = true;
      }
    } else if (command === undefined) {
      command = value;
    } else {
      positionals.push(value);
    }
  }
  return { ...(command === undefined ? {} : { command }), positionals, options };
}

export function requirePositional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (value === undefined)
    throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { missing: label } });
  return value;
}

export function stringOption(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}
