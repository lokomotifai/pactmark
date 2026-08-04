import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { repositoryRoot } from "../lib/repository.mjs";

type Page = Readonly<{ language: "en" | "tr"; source: string; route: string }>;
type Manifest = Readonly<{ schemaVersion: "1"; pages: readonly Page[] }>;

const appRoot = join(repositoryRoot, "apps", "docs");
const distRoot = join(appRoot, "dist");
const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "docs", "site-manifest.json"), "utf8"),
) as Manifest;
const failures: string[] = [];

function filesBelow(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

for (const path of [
  "robots.txt",
  "llms.txt",
  "package-docs-index.json",
  "sitemap-index.xml",
  "pagefind/pagefind.js",
]) {
  if (!existsSync(join(distRoot, path))) failures.push(`KAF_DOCS_BUILD_ARTIFACT_MISSING:${path}`);
}

const expectedPages = [
  ...manifest.pages.map(({ language, route }) => {
    const routeWithoutExtension = route.replace(/\.md$/u, "");
    return routeWithoutExtension === "index"
      ? `${language}/index.html`
      : `${language}/${routeWithoutExtension}/index.html`;
  }),
  "en/reference/api/index.html",
];
for (const path of expectedPages) {
  if (!existsSync(join(distRoot, path))) failures.push(`KAF_DOCS_PAGE_MISSING:${path}`);
}

const htmlFiles = filesBelow(distRoot).filter((path) => extname(path) === ".html");
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const path = relative(distRoot, file).replaceAll("\\", "/");
  const language = path.startsWith("tr/") ? "tr" : "en";
  if (!new RegExp(`<html[^>]+lang=["']${language}["']`, "iu").test(html)) {
    failures.push(`KAF_DOCS_ACCESSIBILITY_LANG:${path}`);
  }
  if (!/<title>[^<]+<\/title>/iu.test(html)) failures.push(`KAF_DOCS_ACCESSIBILITY_TITLE:${path}`);
  if (!/<meta[^>]+name=["']viewport["']/iu.test(html)) {
    failures.push(`KAF_DOCS_ACCESSIBILITY_VIEWPORT:${path}`);
  }
  if (!/<main[\s>]/iu.test(html)) failures.push(`KAF_DOCS_ACCESSIBILITY_MAIN:${path}`);
  for (const image of html.matchAll(/<img\b[^>]*>/giu)) {
    if (!/\balt=["'][^"']*["']/iu.test(image[0])) {
      failures.push(`KAF_DOCS_ACCESSIBILITY_IMAGE_ALT:${path}`);
    }
  }
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/giu)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => id !== undefined && ids.indexOf(id) !== index);
  const firstDuplicateId = duplicateIds[0];
  if (firstDuplicateId !== undefined) {
    failures.push(`KAF_DOCS_ACCESSIBILITY_DUPLICATE_ID:${path}:${firstDuplicateId}`);
  }
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/iu.exec(html)?.[1];
  if (canonical === undefined || !canonical.startsWith("https://pactmark.github.io/pactmark/")) {
    failures.push(`KAF_DOCS_CANONICAL_INVALID:${path}`);
  }
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/giu)) {
    const href = match[1] ?? "";
    if (/^(?:#|mailto:|tel:)/u.test(href)) continue;
    if (/^(?:javascript|data):/iu.test(href)) {
      failures.push(`KAF_DOCS_LINK_SCHEME_INVALID:${path}:${href}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(href, "https://pactmark.github.io/pactmark/");
    } catch {
      failures.push(`KAF_DOCS_LINK_INVALID:${path}:${href}`);
      continue;
    }
    if (url.origin !== "https://pactmark.github.io" || !url.pathname.startsWith("/pactmark/")) {
      continue;
    }
    const target = decodeURIComponent(url.pathname.slice("/pactmark/".length));
    const candidates = [
      join(distRoot, target),
      join(distRoot, `${target.replace(/\/$/u, "")}.html`),
      join(distRoot, target, "index.html"),
    ];
    if (!candidates.some(existsSync))
      failures.push(`KAF_DOCS_INTERNAL_LINK_BROKEN:${path}:${href}`);
  }
}

const css = readFileSync(join(appRoot, "src", "styles", "docs.css"), "utf8");
if (!css.includes("prefers-reduced-motion: reduce")) {
  failures.push("KAF_DOCS_REDUCED_MOTION_MISSING");
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `KAF_DOCS_BUILD_OK html=${String(htmlFiles.length)} internalLinks=valid accessibilitySeriousCritical=0\n`,
  );
}
