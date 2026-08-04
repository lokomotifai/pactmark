import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const adrSlugs = [
  "product-thesis",
  "package-boundaries",
  "event-derived-runtime",
  "provider-and-platform-adapters",
  "default-deny-security",
  "evidence-model",
  "toolchain-and-version-baseline",
] as const;

const required = [
  "README.md",
  "README.tr.md",
  "LICENSE",
  "NOTICE",
  "ORIGIN_AND_ATTRIBUTION.md",
  "TRADEMARKS.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CHANGELOG.md",
  "docs/releases/naming-decision.md",
  "docs/accessibility-and-localization.md",
  "docs/site-manifest.json",
  "docs/translations.json",
  "docs/architecture/product-principles.md",
  ...adrSlugs.map((slug, index) => `docs/adr/ADR-${String(index + 1).padStart(4, "0")}-${slug}.md`),
];

const failures: string[] = [];
for (const path of required) {
  const absolute = join(repositoryRoot, path);
  if (!existsSync(absolute)) {
    failures.push(`Missing required document: ${path}`);
    continue;
  }
  if (readFileSync(absolute, "utf8").trim().length === 0) failures.push(`Empty document: ${path}`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`KAF_DOCS_INVALID ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${String(required.length)} required WP-00 documents.\n`);
}
