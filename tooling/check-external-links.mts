import { readFileSync } from "node:fs";

import { isAccessRestrictedStatus } from "./lib/external-links.mjs";
import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const links = new Set<string>();
const markdownLink = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gu;
for (const path of gitFiles().filter((value) => value.endsWith(".md"))) {
  const content = readFileSync(`${repositoryRoot}/${path}`, "utf8");
  for (const match of content.matchAll(markdownLink)) {
    const link = match[1];
    if (link !== undefined) links.add(link);
  }
}

const failures: Readonly<{ url: string; status: number | "network_error" }>[] = [];
const accessRestricted: Readonly<{ url: string; status: number }>[] = [];
for (const url of [...links].sort()) {
  try {
    const request = (method: "HEAD" | "GET") =>
      fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "pactmark-link-check/0.1" },
      });
    const head = await request("HEAD");
    if (head.ok) continue;
    const response = await request("GET");
    await response.body?.cancel();
    if (response.ok) continue;
    if (isAccessRestrictedStatus(response.status)) {
      accessRestricted.push({ url, status: response.status });
    } else {
      failures.push({ url, status: response.status });
    }
  } catch {
    failures.push({ url, status: "network_error" });
  }
}
if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ code: "KAF_DOCS_EXTERNAL_LINKS_FAILED", failures })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({ accessRestricted, checked: links.size, status: "passed" })}\n`,
  );
}
