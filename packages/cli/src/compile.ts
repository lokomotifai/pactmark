import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  InstructionBundleSchema,
  SkillManifestSchema,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
} from "@pactmark/core";
import { z } from "zod";

import { CliError } from "./error.js";
import type { CompileResult } from "./types.js";

const SkillAuthoringSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    compatibility: z
      .object({
        pactmarkCore: z.string().min(1).default("^0.1.0"),
        runtimes: z.array(z.enum(["portable", "node", "vercel", "cloudflare_preview"])).min(1),
      })
      .strict(),
    requiredCapabilities: z.array(z.string().min(1)).optional(),
  })
  .strict();

const CapabilityRegistrySchema = z
  .object({ schemaVersion: z.literal("1"), capabilities: z.array(z.string().min(1)) })
  .strict();

const FORBIDDEN_SECRET =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^\s"']{8,})/i;

function fail(reason: string): never {
  throw new CliError("KAF_CLI_COMPILE_INVALID", { details: { reason } });
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`))
  )
    return;
  fail("path_escape");
}

function normalizedText(bytes: Uint8Array, sourceName: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`unsupported_encoding:${sourceName}`);
  }
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (normalized.length === 0) fail(`empty_source:${sourceName}`);
  if (FORBIDDEN_SECRET.test(normalized))
    throw new CliError("KAF_CLI_COMPILE_SECRET_DETECTED", { details: { source: sourceName } });
  return normalized;
}

async function safeFile(root: string, path: string): Promise<Uint8Array> {
  assertInside(root, path);
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail(`missing_file:${relative(root, path)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`unsafe_file:${relative(root, path)}`);
  assertInside(await realpath(root), await realpath(path));
  return readFile(path);
}

async function filesRecursively(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    assertInside(root, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink:${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
      else fail(`unsupported_entry:${relative(root, path)}`);
    }
  }
  await visit(root);
  return result;
}

async function ensureContainedDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  const resolvedRoot = await realpath(root);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await lstat(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST"))
          throw mkdirError;
      }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`unsafe_output_directory:${segment}`);
    assertInside(resolvedRoot, await realpath(current));
  }
  return current;
}

async function compileAgentPackageUnchecked(rootDirectory: string): Promise<CompileResult> {
  const root = resolve(rootDirectory);
  const agentPath = join(root, "AGENT.md");
  const agentText = normalizedText(await safeFile(root, agentPath), "AGENT.md");
  const instructionEntry = {
    schemaVersion: "1" as const,
    sourceName: "AGENT.md",
    text: agentText,
    contentDigest: digestBytes(new TextEncoder().encode(agentText)),
  };
  const instructions = InstructionBundleSchema.parse({
    schemaVersion: "1",
    entries: [instructionEntry],
    bundleDigest: digestCanonicalJson({ schemaVersion: "1", entries: [instructionEntry] }),
  });

  let availableCapabilities: readonly string[] = [];
  try {
    const capabilitiesPath = join(root, ".pactmark", "capabilities.json");
    const parsed = JSON.parse(
      normalizedText(await safeFile(root, capabilitiesPath), ".pactmark/capabilities.json"),
    ) as unknown;
    availableCapabilities = CapabilityRegistrySchema.parse(parsed).capabilities;
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      !error.details?.reason?.toString().startsWith("missing_file:")
    )
      throw error;
  }

  const skillsRoot = join(root, "skills");
  const skillManifests = [];
  try {
    const skillsInfo = await lstat(skillsRoot);
    if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) fail("unsafe_skills_directory");
    assertInside(await realpath(root), await realpath(skillsRoot));
    const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (skillDirectories.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()))
      fail("unsafe_skill_entry");
    for (const directory of skillDirectories) {
      const skillRoot = join(skillsRoot, directory.name);
      const authoring = SkillAuthoringSchema.parse(
        JSON.parse(
          normalizedText(
            await safeFile(root, join(skillRoot, "skill.json")),
            `skills/${directory.name}/skill.json`,
          ),
        ),
      );
      const sourceFiles = (await filesRecursively(skillRoot)).filter(
        (path) => basename(path) !== "skill.json",
      );
      if (!sourceFiles.some((path) => relative(skillRoot, path) === "SKILL.md"))
        fail(`missing_file:skills/${directory.name}/SKILL.md`);
      const entries = [];
      for (const sourcePath of sourceFiles) {
        const path = relative(skillRoot, sourcePath).split(sep).join("/");
        const bytes = await safeFile(root, sourcePath);
        if (path === "SKILL.md") {
          const content = normalizedText(bytes, `skills/${directory.name}/${path}`);
          entries.push({
            schemaVersion: "1" as const,
            kind: "instruction" as const,
            path,
            mediaType: "text/markdown" as const,
            content,
            contentDigest: digestBytes(new TextEncoder().encode(content)),
            textNormalization: "utf8-bom-lf" as const,
          });
        } else {
          entries.push({
            schemaVersion: "1" as const,
            kind: "resource" as const,
            path,
            mediaType: "application/octet-stream",
            contentDigest: digestBytes(bytes),
            byteSize: bytes.byteLength,
            textNormalization: "none" as const,
          });
        }
      }
      const required = authoring.requiredCapabilities ?? [];
      const unresolved = required.find((capability) => !availableCapabilities.includes(capability));
      if (unresolved !== undefined) fail(`unresolved_capability:${unresolved}`);
      const sourceDigest = digestCanonicalJson({ authoring, entries });
      skillManifests.push(
        SkillManifestSchema.parse({
          schemaVersion: "1",
          id: authoring.id,
          version: authoring.version,
          description: authoring.description,
          entries,
          contentDigest: digestCanonicalJson(entries),
          provenance: {
            sourceType: "workspace_compiled",
            sourceName: `skills/${directory.name}`,
            sourceDigest,
          },
          compatibility: authoring.compatibility,
          ...(required.length === 0 ? {} : { requiredCapabilities: required }),
        }),
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const requiredCapabilities = [
    ...new Set(skillManifests.flatMap((skill) => skill.requiredCapabilities ?? [])),
  ].sort();
  const material = {
    schemaVersion: "1" as const,
    formatVersion: "1" as const,
    instructions,
    skills: skillManifests,
    requiredCapabilities,
  };
  const sourceDigest = digestCanonicalJson(material);
  const output = { ...material, sourceDigest };
  const outputDirectory = await ensureContainedDirectory(root, [".pactmark", "generated"]);
  const manifestPath = join(outputDirectory, "agent-manifest.json");
  const temporaryDirectory = await mkdtemp(join(outputDirectory, ".compile-"));
  const temporaryPath = join(temporaryDirectory, "agent-manifest.json");
  try {
    assertInside(await realpath(root), await realpath(temporaryDirectory));
    await writeFile(temporaryPath, `${canonicalJsonStringify(output)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    assertInside(await realpath(root), await realpath(outputDirectory));
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    schemaVersion: "1",
    command: "compile",
    manifestPath: relative(root, manifestPath).split(sep).join("/"),
    sourceDigest,
    instructionBundleDigest: instructions.bundleDigest,
    skillManifestDigests: skillManifests.map((skill) => skill.contentDigest),
    requiredCapabilities,
    fileCount: 1 + skillManifests.reduce((total, skill) => total + skill.entries.length + 1, 0),
    summary: `Compiled ${String(1 + skillManifests.length)} Pactmark instruction source(s).`,
  };
}

export async function compileAgentPackage(rootDirectory: string): Promise<CompileResult> {
  try {
    return await compileAgentPackageUnchecked(rootDirectory);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("KAF_CLI_COMPILE_INVALID", {
      details: { reason: "invalid_authoring_input" },
    });
  }
}
