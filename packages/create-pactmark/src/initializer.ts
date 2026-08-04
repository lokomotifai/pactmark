import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { InitializerError } from "./error.js";
import { materializeTemplate, type TemplateFile } from "./templates.js";
import {
  FRAMEWORK_VERSION,
  TEMPLATE_FORMAT_VERSION,
  type CommandRunner,
  type InitializerDependencies,
  type InitializerOptions,
  type InitializerPlan,
  type InitializerResult,
  type PackageManagerName,
} from "./types.js";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SHELL_CHARACTER = /[;&|`$><!*?()[\]{}'"\\]/u;
const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?$/u;
const SECRET_ASSIGNMENT = /(?:api[_-]?key|secret|token|password)\s*=\s*[^\s#]+/iu;

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function containsControlOrShell(value: string): boolean {
  if (SHELL_CHARACTER.test(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new InitializerError("KAF_INIT_ABORTED", "Run the initializer again when ready.");
  }
}

function validateTarget(
  cwd: string,
  target: string,
): Readonly<{
  absolute: string;
  relative: string;
  projectName: string;
}> {
  if (
    target.length === 0 ||
    target !== target.trim() ||
    target.length > 1024 ||
    path.isAbsolute(target) ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target)
  ) {
    throw new InitializerError(
      "KAF_INIT_TARGET_INVALID",
      "Use a non-empty relative target below the current directory.",
    );
  }
  const normalized = target.replaceAll(path.sep, "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED.test(segment) ||
        containsControlOrShell(segment),
    )
  ) {
    throw new InitializerError(
      "KAF_INIT_TARGET_INVALID",
      "Remove traversal, reserved names, controls, shell characters, and trailing dots or spaces.",
    );
  }
  const projectName = segments.at(-1) ?? "";
  if (!PROJECT_NAME.test(projectName)) {
    throw new InitializerError(
      "KAF_INIT_TARGET_INVALID",
      "Use a lowercase npm-compatible project name with letters, numbers, dots, dashes, or underscores.",
    );
  }
  const absolute = path.resolve(cwd, ...segments);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InitializerError(
      "KAF_INIT_TARGET_INVALID",
      "Choose a target contained by the current directory.",
    );
  }
  return Object.freeze({ absolute, relative, projectName });
}

function validateFiles(files: readonly TemplateFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = path.posix.normalize(file.path);
    if (
      normalized !== file.path ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      path.posix.isAbsolute(normalized) ||
      seen.has(normalized) ||
      file.content.includes("\u0000") ||
      SECRET_ASSIGNMENT.test(file.content)
    ) {
      throw new InitializerError(
        "KAF_INIT_TEMPLATE_INVALID",
        "Use only normalized, unique, secret-free embedded template files.",
      );
    }
    seen.add(normalized);
  }
}

function warningList(options: InitializerOptions): readonly string[] {
  const warnings: string[] = [];
  if (options.store === "memory") {
    warnings.push("KAF_INIT_EPHEMERAL_STORE: memory state is process-local and not durable.");
  }
  if (options.model === "mock-only") {
    warnings.push("KAF_INIT_MOCK_MODEL: deterministic local model is not production-ready.");
  }
  if (options.template === "cloudflare-worker") {
    warnings.push("KAF_INIT_EXPERIMENTAL_HOST: Cloudflare support is a portable-subset preview.");
  }
  warnings.push(
    "KAF_INIT_DECLARED_EGRESS: the in-process executor does not provide network isolation.",
  );
  return Object.freeze(warnings.sort());
}

function commandPrefix(packageManager: PackageManagerName): string {
  return packageManager === "npm" ? "npm run" : `${packageManager} run`;
}

export function planProject(options: InitializerOptions): Promise<InitializerPlan> {
  return Promise.resolve().then(() => {
    abortIfNeeded(options.signal);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const target = validateTarget(cwd, options.target);
    const template = materializeTemplate({
      projectName: target.projectName,
      template: options.template,
      model: options.model,
      store: options.store,
      packageManager: options.packageManager,
    });
    validateFiles(template.files);
    const prefix = commandPrefix(options.packageManager);
    return Object.freeze({
      schemaVersion: "1",
      templateFormatVersion: TEMPLATE_FORMAT_VERSION,
      frameworkVersion: FRAMEWORK_VERSION,
      targetPath: target.absolute,
      projectName: target.projectName,
      template: options.template,
      model: options.model,
      store: options.store,
      packageManager: options.packageManager,
      install: options.install,
      initializeGit: options.git,
      files: Object.freeze(
        template.files.map((file) =>
          Object.freeze({ path: file.path, digest: digest(file.content) }),
        ),
      ),
      dependencies: template.dependencies,
      devDependencies: template.devDependencies,
      generatedScripts: template.scripts,
      warnings: warningList(options),
      nextCommands: Object.freeze([
        `cd ${target.relative}`,
        ...(options.install ? [] : [`${options.packageManager} install`]),
        `${prefix} doctor`,
        `${prefix} dev`,
      ]),
    });
  });
}

async function targetState(target: string): Promise<"missing" | "empty" | "occupied"> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) return "occupied";
    return (await readdir(target)).length === 0 ? "empty" : "occupied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function assertSafeParent(cwd: string, parent: string): Promise<void> {
  const relative = path.relative(cwd, parent);
  if (relative === "") return;
  let current = cwd;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new InitializerError(
          "KAF_INIT_TARGET_INVALID",
          "Every existing target parent must be a real directory, not a symbolic link.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new InitializerError(
          "KAF_INIT_TARGET_INVALID",
          "Create the target parent directory first.",
        );
      }
      throw error;
    }
  }
}

async function writeTemplate(temp: string, files: readonly TemplateFile[], signal?: AbortSignal) {
  for (const file of files) {
    abortIfNeeded(signal);
    const destination = path.join(temp, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: file.mode ?? 0o644,
    });
  }
}

async function validateMaterializedTemplate(
  temp: string,
  files: InitializerPlan["files"],
  signal?: AbortSignal,
): Promise<void> {
  const realTemp = await realpath(temp);
  for (const file of files) {
    abortIfNeeded(signal);
    const destination = path.join(temp, ...file.path.split("/"));
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe materialized file");
      const realDestination = await realpath(destination);
      const relativeDestination = path.relative(realTemp, realDestination);
      if (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination))
        throw new Error("materialized path escape");
      const content = await readFile(destination, "utf8");
      if (digest(content) !== file.digest) throw new Error("materialized digest mismatch");
    } catch {
      throw new InitializerError(
        "KAF_INIT_TEMPLATE_INVALID",
        "A generated template file changed before the atomic target commit.",
      );
    }
  }
}

function runLocalCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      stdio: "inherit",
      shell: false,
      ...(signal === undefined ? {} : { signal }),
    });
    child.once("error", reject);
    child.once("exit", (code, childSignal) => {
      if (code === 0) resolve();
      else if (childSignal !== null) {
        reject(new InitializerError("KAF_INIT_ABORTED", "Run the initializer again when ready."));
      } else {
        reject(
          new InitializerError(
            "KAF_INIT_COMMAND_FAILED",
            `${command} exited unsuccessfully. Retry with --no-install or --no-git.`,
          ),
        );
      }
    });
  });
}

const defaultRunner: CommandRunner = Object.freeze({
  run: runLocalCommand,
});

function installCommand(packageManager: PackageManagerName): readonly [string, readonly string[]] {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", ["install", "--ignore-scripts"]];
    case "npm":
      return ["npm", ["install", "--ignore-scripts"]];
    case "yarn":
      return ["yarn", ["install", "--mode=skip-builds"]];
    case "bun":
      return ["bun", ["install", "--ignore-scripts"]];
  }
}

export async function createProject(
  options: InitializerOptions,
  dependencies: InitializerDependencies = {},
): Promise<InitializerResult> {
  const plan = await planProject(options);
  if (options.dryRun) return Object.freeze({ ...plan, created: false });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const parent = path.dirname(plan.targetPath);
  await assertSafeParent(cwd, parent);
  const initialState = await targetState(plan.targetPath);
  if (initialState === "occupied") {
    throw new InitializerError(
      "KAF_INIT_TARGET_EXISTS",
      "Choose a missing or empty target directory.",
    );
  }

  const template = materializeTemplate({
    projectName: plan.projectName,
    template: plan.template,
    model: plan.model,
    store: plan.store,
    packageManager: plan.packageManager,
  });
  const runner = dependencies.commandRunner ?? defaultRunner;
  const temp = await mkdtemp(path.join(parent, `.${plan.projectName}.pactmark-`));
  try {
    await writeTemplate(temp, template.files, options.signal);
    abortIfNeeded(options.signal);
    if (options.install) {
      const [command, arguments_] = installCommand(options.packageManager);
      await runner.run(command, arguments_, temp, options.signal);
    }
    if (options.git) await runner.run("git", ["init", "--quiet"], temp, options.signal);
    abortIfNeeded(options.signal);
    await validateMaterializedTemplate(temp, plan.files, options.signal);
    if (initialState === "empty") await rmdir(plan.targetPath);
    await rename(temp, plan.targetPath);
    return Object.freeze({ ...plan, created: true });
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (initialState === "empty" && (await targetState(plan.targetPath)) === "missing") {
      try {
        await mkdir(plan.targetPath);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
      }
    }
    throw error;
  }
}

export const initializerInternals = Object.freeze({
  validateTarget,
  validateFiles,
  installCommand,
  runLocalCommand,
  targetState,
  validateMaterializedTemplate,
});
