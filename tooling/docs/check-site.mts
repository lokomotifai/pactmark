import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "../lib/repository.mjs";

type Page = Readonly<{ language: "en" | "tr"; source: string; route: string }>;
type Manifest = Readonly<{ schemaVersion: "1"; compatibility: string; pages: readonly Page[] }>;
type Translation = Readonly<{
  english: string;
  turkish: string;
  requiredTerms: readonly string[];
  requiredHeadings: readonly string[];
}>;

const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "docs", "site-manifest.json"), "utf8"),
) as Manifest;
const translations = JSON.parse(
  readFileSync(join(repositoryRoot, "docs", "translations.json"), "utf8"),
) as Readonly<{ schemaVersion: "1"; mappings: readonly Translation[] }>;
const failures: string[] = [];
const routes = new Set(
  manifest.pages.map(
    ({ language, route }) => `/${language}/${route.replace(/(?:index)?\.md$/u, "")}`,
  ),
);

for (const page of manifest.pages) {
  const absolute = join(repositoryRoot, page.source);
  if (!existsSync(absolute)) {
    failures.push(`KAF_DOCS_SOURCE_MISSING:${page.source}`);
    continue;
  }
  const source = readFileSync(absolute, "utf8");
  for (const field of ["title", "description"] as const) {
    if (!new RegExp(`^${field}:\\s*\\S`, "mu").test(source)) {
      failures.push(`KAF_DOCS_FRONTMATTER_MISSING:${page.source}:${field}`);
    }
  }
  if (!source.includes(`Compatibility: ${manifest.compatibility}`)) {
    failures.push(`KAF_DOCS_COMPATIBILITY_MISSING:${page.source}`);
  }
  for (const fence of source.matchAll(/^```([^\n]*)$/gmu)) {
    if (!fence[1]?.includes("source="))
      failures.push(`KAF_DOCS_CODE_SOURCE_MISSING:${page.source}`);
  }
  for (const link of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = link[1] ?? "";
    if (/^https?:/u.test(target)) {
      if (!target.startsWith("https://") || /(?:example|placeholder|your[-_]?org)/iu.test(target)) {
        failures.push(`KAF_DOCS_EXTERNAL_URL_INVALID:${page.source}:${target}`);
      }
      continue;
    }
    const internalTarget = target.replace(/^\/pactmark/u, "").replace(/#.*$/u, "");
    if (target.startsWith("/") && !routes.has(internalTarget)) {
      failures.push(`KAF_DOCS_INTERNAL_LINK_BROKEN:${page.source}:${target}`);
    }
  }
}

const englishRoutes = new Set(
  manifest.pages.filter(({ language }) => language === "en").map(({ route }) => route),
);
const turkishRoutes = new Set(
  manifest.pages.filter(({ language }) => language === "tr").map(({ route }) => route),
);
for (const mapping of translations.mappings) {
  if (!englishRoutes.has(mapping.english))
    failures.push(`KAF_DOCS_TRANSLATION_EN_MISSING:${mapping.english}`);
  if (!turkishRoutes.has(mapping.turkish))
    failures.push(`KAF_DOCS_TRANSLATION_TR_MISSING:${mapping.turkish}`);
  const page = manifest.pages.find(
    ({ language, route }) => language === "tr" && route === mapping.turkish,
  );
  if (page === undefined) continue;
  const source = readFileSync(join(repositoryRoot, page.source), "utf8");
  for (const term of mapping.requiredTerms) {
    if (!source.includes(term))
      failures.push(`KAF_DOCS_TRANSLATION_TERM_MISSING:${page.source}:${term}`);
  }
  for (const heading of mapping.requiredHeadings) {
    if (!source.includes(`## ${heading}`)) {
      failures.push(`KAF_DOCS_TRANSLATION_HEADING_MISSING:${page.source}:${heading}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `KAF_DOCS_CONFORMANCE_OK pages=${String(manifest.pages.length)} translations=${String(translations.mappings.length)}\n`,
  );
}
