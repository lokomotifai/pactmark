import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { repositoryRoot } from "../lib/repository.mjs";

type Language = "en" | "tr";
type Page = Readonly<{ language: Language; source: string; route: string }>;
type SiteManifest = Readonly<{
  schemaVersion: "1";
  compatibility: string;
  pages: readonly Page[];
}>;

const docsApp = join(repositoryRoot, "apps", "docs");
const generatedDocs = join(docsApp, "src", "content", "docs");
const publicDirectory = join(docsApp, "public");
const manifestPath = join(repositoryRoot, "docs", "site-manifest.json");

function parseSiteManifest(value: unknown): SiteManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("KAF_DOCS_MANIFEST_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== "1" ||
    typeof record.compatibility !== "string" ||
    !Array.isArray(record.pages)
  ) {
    throw new Error("KAF_DOCS_MANIFEST_INVALID");
  }
  const pages: Page[] = record.pages.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("KAF_DOCS_PAGE_INVALID");
    }
    const page = entry as Record<string, unknown>;
    if (
      (page.language !== "en" && page.language !== "tr") ||
      typeof page.source !== "string" ||
      typeof page.route !== "string"
    ) {
      throw new Error("KAF_DOCS_PAGE_INVALID");
    }
    return { language: page.language, source: page.source, route: page.route };
  });
  return { schemaVersion: "1", compatibility: record.compatibility, pages };
}

const manifest = parseSiteManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);

const destinations = new Set<string>();
const caseFolded = new Set<string>();
for (const page of manifest.pages) {
  const destination = `${page.language}/${page.route}`;
  if (destinations.has(destination)) throw new Error(`KAF_DOCS_ROUTE_DUPLICATE:${destination}`);
  const folded = destination.toLocaleLowerCase("en-US");
  if (caseFolded.has(folded)) throw new Error(`KAF_DOCS_ROUTE_CASE_COLLISION:${destination}`);
  destinations.add(destination);
  caseFolded.add(folded);
  const source = join(repositoryRoot, page.source);
  if (!existsSync(source)) throw new Error(`KAF_DOCS_SOURCE_MISSING:${page.source}`);
}

rmSync(generatedDocs, { recursive: true, force: true });
mkdirSync(generatedDocs, { recursive: true });
mkdirSync(publicDirectory, { recursive: true });

function materializeSnippets(source: string): string {
  return source.replace(
    /<!-- pactmark:snippet source=([^\s]+) language=([a-z0-9-]+) -->/gu,
    (_match, relativeSource: string, language: string) => {
      const snippetPath = join(repositoryRoot, relativeSource);
      if (!existsSync(snippetPath)) throw new Error(`KAF_DOCS_SNIPPET_MISSING:${relativeSource}`);
      const snippet = readFileSync(snippetPath, "utf8").trimEnd();
      return `\`\`\`${language} source=${JSON.stringify(relativeSource)}\n${snippet}\n\`\`\``;
    },
  );
}

for (const page of manifest.pages) {
  const destination = join(generatedDocs, page.language, page.route);
  mkdirSync(dirname(destination), { recursive: true });
  const source = readFileSync(join(repositoryRoot, page.source), "utf8");
  writeFileSync(destination, materializeSnippets(source));
}

const apiReports = [
  ["@pactmark/agent", "packages/agent/etc/agent.api.md"],
  ["@pactmark/core", "packages/core/etc/core.api.md"],
  ["@pactmark/testing", "packages/testing/etc/testing.api.md"],
] as const;
const apiBody = apiReports
  .map(([packageName, path]) => {
    const report = readFileSync(join(repositoryRoot, path), "utf8");
    return `## ${packageName}\n\nGenerated from the committed API Extractor report \`${path}\`.\n\n${report}`;
  })
  .join("\n\n");
const generatedApi = join(generatedDocs, "en", "reference", "api.md");
mkdirSync(dirname(generatedApi), { recursive: true });
writeFileSync(
  generatedApi,
  `---\ntitle: Generated API surface\ndescription: Public declarations generated from API Extractor reports.\n---\n\n> Compatibility: ${manifest.compatibility}. The reports, not this wrapper, are the signature authority.\n\n${apiBody}\n`,
);

function frontmatterField(source: string, field: string): string {
  const match = new RegExp(`^${field}:\\s*(.+)$`, "mu").exec(source);
  if (match?.[1] === undefined) throw new Error(`KAF_DOCS_FRONTMATTER_MISSING:${field}`);
  return match[1].replace(/^['"]|['"]$/gu, "").trim();
}

const publicDocsBasePath = "/pactmark";
const llmsPages = manifest.pages.map((page) => {
  const source = readFileSync(join(repositoryRoot, page.source), "utf8");
  return {
    language: page.language,
    title: frontmatterField(source, "title"),
    description: frontmatterField(source, "description"),
    path: `${publicDocsBasePath}/${page.language}/${page.route.replace(/(?:index)?\.md$/u, "")}`,
  };
});
const llms = [
  "# Pactmark documentation",
  "",
  `Compatibility: ${manifest.compatibility}`,
  "Publication status: Pactmark 0.2.0 is a verified candidate; protected publication and independent registry-byte verification are pending.",
  "",
  ...llmsPages.map(
    ({ language, title, description, path }) =>
      `- [${language}] ${title}: ${description} (${path})`,
  ),
  "",
].join("\n");
writeFileSync(join(publicDirectory, "llms.txt"), llms);

const packageIndexes = {
  schemaVersion: "1",
  compatibility: manifest.compatibility,
  packages: {
    "@pactmark/agent": [
      `${publicDocsBasePath}/en/getting-started/first-agent/`,
      `${publicDocsBasePath}/en/concepts/agent-and-work-order/`,
    ],
    "@pactmark/core": [
      `${publicDocsBasePath}/en/concepts/run-lifecycle-and-durability/`,
      `${publicDocsBasePath}/en/reference/api/`,
    ],
    "@pactmark/runtime": [
      `${publicDocsBasePath}/en/concepts/run-lifecycle-and-durability/`,
      `${publicDocsBasePath}/en/guides/testing-agents/`,
    ],
    "@pactmark/store-postgres": [
      `${publicDocsBasePath}/en/guides/postgres/`,
      `${publicDocsBasePath}/en/production/reliability-and-recovery/`,
    ],
    "@pactmark/vercel": [`${publicDocsBasePath}/en/getting-started/vercel/`],
    "@pactmark/cloudflare": [`${publicDocsBasePath}/en/getting-started/cloudflare-preview/`],
  },
};
writeFileSync(
  join(publicDirectory, "package-docs-index.json"),
  `${JSON.stringify(packageIndexes, null, 2)}\n`,
);

const formattedTargets = [generatedDocs, join(publicDirectory, "package-docs-index.json")];
execFileSync(
  process.execPath,
  [
    join(repositoryRoot, "node_modules", "prettier", "bin", "prettier.cjs"),
    "--write",
    ...formattedTargets,
  ],
  {
    cwd: repositoryRoot,
    stdio: "ignore",
  },
);
process.stdout.write(
  `KAF_DOCS_PREPARED pages=${String(manifest.pages.length + 1)} compatibility=${manifest.compatibility}\n`,
);
