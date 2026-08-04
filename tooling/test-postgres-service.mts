import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const inheritedUrl = process.env["PACTMARK_TEST_POSTGRES_URL"];

function runPackageIntegration(
  packageName: "@pactmark/store-postgres" | "@pactmark/driver-postgres-worker",
  connectionString: string,
  tlsMode: string,
): number {
  const result = spawnSync(
    join(repositoryRoot, "node_modules", ".bin", "pnpm"),
    ["--filter", packageName, "test:integration"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PACTMARK_TEST_POSTGRES_URL: connectionString,
        PACTMARK_TEST_POSTGRES_TLS: tlsMode,
      },
      stdio: "inherit",
    },
  );
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function runIntegrations(connectionString: string, tlsMode: string): number {
  const storeStatus = runPackageIntegration("@pactmark/store-postgres", connectionString, tlsMode);
  if (storeStatus !== 0) return storeStatus;
  const workerStatus = runPackageIntegration(
    "@pactmark/driver-postgres-worker",
    connectionString,
    tlsMode,
  );
  if (workerStatus !== 0) return workerStatus;
  const durable = spawnSync(
    process.execPath,
    ["--import", "tsx", "tooling/durable-resume/run-gate.mts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PACTMARK_TEST_POSTGRES_URL: connectionString,
        PACTMARK_TEST_POSTGRES_TLS: tlsMode,
      },
      stdio: "inherit",
    },
  );
  if (durable.error !== undefined) throw durable.error;
  return durable.status ?? 1;
}

function docker(arguments_: readonly string[], capture = false) {
  const result = spawnSync("docker", arguments_, {
    cwd: repositoryRoot,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

if (inheritedUrl !== undefined && inheritedUrl.length > 0) {
  process.exitCode = runIntegrations(
    inheritedUrl,
    process.env["PACTMARK_TEST_POSTGRES_TLS"] ?? "verify-full",
  );
} else {
  const available = docker(["info", "--format", "{{.ServerVersion}}"], true);
  if (available.status !== 0) {
    throw new Error("KAF_POSTGRES_SERVICE_CONTAINER_UNAVAILABLE");
  }

  const suffix = randomBytes(6).toString("hex");
  const name = `pactmark-postgres-test-${suffix}`;
  const password = `pactmark_test_${suffix}`;
  const started = docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_USER=pactmark",
    "-e",
    "POSTGRES_DB=pactmark",
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  ]);
  if (started.status !== 0) throw new Error("KAF_POSTGRES_SERVICE_CONTAINER_START_FAILED");

  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const probe = docker(["exec", name, "pg_isready", "-U", "pactmark", "-d", "pactmark"], true);
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("KAF_POSTGRES_SERVICE_CONTAINER_NOT_READY");

    const port = docker(["port", name, "5432/tcp"], true);
    if (port.status !== 0 || typeof port.stdout !== "string") {
      throw new Error("KAF_POSTGRES_SERVICE_CONTAINER_PORT_MISSING");
    }
    const match = /127\.0\.0\.1:(\d+)/u.exec(port.stdout);
    if (match?.[1] === undefined) {
      throw new Error("KAF_POSTGRES_SERVICE_CONTAINER_PORT_INVALID");
    }
    process.exitCode = runIntegrations(
      `postgresql://pactmark:${password}@127.0.0.1:${match[1]}/pactmark`,
      "disable",
    );
  } finally {
    const stopped = docker(["stop", "--timeout", "5", name], true);
    if (stopped.status !== 0 && process.exitCode === undefined) process.exitCode = 1;
  }
}
