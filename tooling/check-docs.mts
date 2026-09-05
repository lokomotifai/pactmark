import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const canonicalDocs = "https://pactmark-docs.lokomotif.ai";
const tracked = gitFiles();
const failures: string[] = [];

const requiredProjectRecords = [
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
  "docs/README.md",
  "docs/architecture/product-principles.md",
  "docs/releases/naming-decision.md",
  "docs/adr/ADR-0001-product-thesis.md",
  "docs/adr/ADR-0002-package-boundaries.md",
  "docs/adr/ADR-0003-event-derived-runtime.md",
  "docs/adr/ADR-0004-provider-and-platform-adapters.md",
  "docs/adr/ADR-0005-default-deny-security.md",
  "docs/adr/ADR-0006-evidence-model.md",
  "docs/adr/ADR-0007-toolchain-and-version-baseline.md",
  "docs/adr/ADR-0008-executor-gateway-adapter.md",
] as const;

for (const path of requiredProjectRecords) {
  const absolute = join(repositoryRoot, path);
  if (!existsSync(absolute)) {
    failures.push(`required project record is missing: ${path}`);
  } else if (readFileSync(absolute, "utf8").trim().length === 0) {
    failures.push(`required project record is empty: ${path}`);
  }
}

const forbiddenPaths = [
  /^apps\/docs\//u,
  /^docs\/(?:concepts|getting-started|guides|production|reference|snippets|tr)\//u,
  /^docs\/(?:404|accessibility-and-localization|index|terminology)\.md$/u,
  /^docs\/(?:site-manifest|translations)\.json$/u,
  /^tooling\/docs\//u,
];

for (const path of tracked) {
  if (
    existsSync(join(repositoryRoot, path)) &&
    forbiddenPaths.some((pattern) => pattern.test(path))
  ) {
    failures.push(`obsolete documentation surface remains tracked: ${path}`);
  }
}

const localMarkdownLink = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]+)?\)(?!`)/gu;
for (const path of tracked.filter((value) => value.endsWith(".md"))) {
  const sourcePath = join(repositoryRoot, path);
  if (!existsSync(sourcePath)) continue;
  const content = readFileSync(sourcePath, "utf8");
  for (const match of content.matchAll(localMarkdownLink)) {
    const target = match[1];
    if (target === undefined || target.startsWith("/")) continue;
    const resolved = resolve(dirname(sourcePath), decodeURIComponent(target));
    if (!existsSync(resolved)) {
      failures.push(`${path} references missing local target ${target}`);
    }
  }
}

const requiredLinks: Readonly<Record<string, readonly string[]>> = {
  ".github/ISSUE_TEMPLATE/config.yml": [canonicalDocs],
  "README.md": [
    canonicalDocs,
    `${canonicalDocs}/getting-started/first-agent`,
    "docs/security/README.md",
    `${canonicalDocs}/tr`,
  ],
  "README.tr.md": [
    `${canonicalDocs}/tr`,
    `${canonicalDocs}/tr/getting-started/first-agent`,
    "docs/security/README.md",
  ],
  "SECURITY.md": [
    "docs/security/security-model.md",
    "docs/security/threat-model.md",
    "docs/security/README.md",
  ],
  "SUPPORT.md": [canonicalDocs, `${canonicalDocs}/tr`],
  "docs/README.md": [canonicalDocs],
};

const obsoletePublicTargets = [
  "docs/index.md",
  "docs/tr/index.md",
  "github.io/pactmark",
  "/blob/main/docs/index.md",
];

for (const [path, required] of Object.entries(requiredLinks)) {
  const content = readFileSync(join(repositoryRoot, path), "utf8");
  for (const url of required) {
    if (!content.includes(url)) {
      failures.push(`${path} does not reference ${url}`);
    }
  }
  for (const target of obsoletePublicTargets) {
    if (content.includes(target)) {
      failures.push(`${path} still references obsolete target ${target}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ code: "KAF_DOCS_BOUNDARY_FAILED", failures })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      canonicalDocs,
      checkedPublicFiles: Object.keys(requiredLinks).length,
      status: "passed",
    })}\n`,
  );
}
