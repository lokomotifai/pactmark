import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot, sha256File } from "./lib/repository.mjs";

const manifestPath = join(repositoryRoot, "tooling", "registration-sources.json");
if (!existsSync(manifestPath)) {
  process.stdout.write(
    "No executable registrations exist before WP-01; source manifest is empty.\n",
  );
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly entries: readonly { readonly path: string; readonly digest: string }[];
  };
  const failures = manifest.entries.filter(
    (entry) => sha256File(join(repositoryRoot, entry.path)) !== entry.digest,
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`KAF_REGISTRATION_VERSION_DRIFT ${failure.path}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Verified ${String(manifest.entries.length)} registration source identities.\n`,
    );
  }
}
