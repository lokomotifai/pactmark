export const FRAMEWORK_VERSION = "0.1.2" as const;
export const TEMPLATE_FORMAT_VERSION = "1" as const;

export const TEMPLATE_NAMES = [
  "vercel-next",
  "node-server",
  "cloudflare-worker",
  "library",
] as const;
export const MODEL_NAMES = ["ai-sdk", "mock-only"] as const;
export const STORE_NAMES = ["memory", "postgres"] as const;
export const PACKAGE_MANAGER_NAMES = ["pnpm", "npm", "yarn", "bun"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export type ModelName = (typeof MODEL_NAMES)[number];
export type StoreName = (typeof STORE_NAMES)[number];
export type PackageManagerName = (typeof PACKAGE_MANAGER_NAMES)[number];

export interface InitializerOptions {
  readonly cwd?: string;
  readonly target: string;
  readonly template: TemplateName;
  readonly model: ModelName;
  readonly store: StoreName;
  readonly packageManager: PackageManagerName;
  readonly install: boolean;
  readonly git: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly signal?: AbortSignal;
}

export interface PlannedFile {
  readonly path: string;
  readonly digest: string;
}

export interface InitializerPlan {
  readonly schemaVersion: "1";
  readonly templateFormatVersion: "1";
  readonly frameworkVersion: "0.1.2";
  readonly targetPath: string;
  readonly projectName: string;
  readonly template: TemplateName;
  readonly model: ModelName;
  readonly store: StoreName;
  readonly packageManager: PackageManagerName;
  readonly install: boolean;
  readonly initializeGit: boolean;
  readonly files: readonly PlannedFile[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly generatedScripts: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  readonly nextCommands: readonly string[];
}

export interface InitializerResult extends InitializerPlan {
  readonly created: boolean;
}

export interface CommandRunner {
  run(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface InitializerDependencies {
  readonly commandRunner?: CommandRunner;
}

export interface ParsedArguments {
  readonly action: "run" | "help" | "version";
  readonly target?: string;
  readonly template?: TemplateName;
  readonly model?: ModelName;
  readonly store?: StoreName;
  readonly packageManager?: PackageManagerName;
  readonly yes: boolean;
  readonly install: boolean;
  readonly git: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}
