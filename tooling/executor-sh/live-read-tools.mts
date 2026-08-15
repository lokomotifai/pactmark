import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  availableLoopbackPort,
  execute,
  initializeMcp,
  mintApiKey,
  signIn,
  waitForHealth,
} from "./conformance.mjs";
import {
  ExecutorConformanceError,
  assertPinnedImage,
  executorDockerPlatform,
  executorPlatformImage,
  runDocker,
} from "./docker.mjs";

const expectedOperationCount = 6;

function ensureObject(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutorConformanceError(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function responseJson(
  response: Response,
  code: string,
): Promise<Readonly<Record<string, unknown>>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new ExecutorConformanceError(code, { cause });
  }
  return ensureObject(value, code);
}

function expectSuccess(response: Response, code: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new ExecutorConformanceError(code, {
      safeDetail: `unexpected HTTP status ${String(response.status)}`,
    });
  }
}

function liveReadSpec(): Readonly<Record<string, unknown>> {
  const operations = [
    ["/point/last-day/{package}", "getPointLastDay", "NPM point downloads for the last day"],
    ["/point/last-week/{package}", "getPointLastWeek", "NPM point downloads for the last week"],
    ["/point/last-month/{package}", "getPointLastMonth", "NPM point downloads for the last month"],
    ["/range/last-day/{package}", "getRangeLastDay", "NPM range downloads for the last day"],
    ["/range/last-week/{package}", "getRangeLastWeek", "NPM range downloads for the last week"],
    ["/range/last-month/{package}", "getRangeLastMonth", "NPM range downloads for the last month"],
  ] as const;
  return {
    openapi: "3.0.3",
    info: { title: "Pactmark NPM read-only conformance", version: "1" },
    servers: [{ url: "https://api.npmjs.org/downloads" }],
    paths: Object.fromEntries(
      operations.map(([path, operationId, summary]) => [
        path,
        {
          get: {
            operationId,
            summary,
            parameters: [
              {
                name: "package",
                in: "path",
                required: true,
                schema: { type: "string", minLength: 1 },
              },
            ],
            responses: { "200": { description: "Successful read" } },
          },
        },
      ]),
    ),
  };
}

async function removeContainer(name: string): Promise<void> {
  try {
    await runDocker(["rm", "--force", name], { timeoutMs: 15_000 });
  } catch {
    // Exact-target cleanup is verified after the attempt.
  }
}

export interface ExecutorLiveReadToolMatrixResult {
  readonly schemaVersion: "1";
  readonly claim: "network_authorized_public_read_only_tool_matrix";
  readonly image: string;
  readonly publicApiOrigin: "https://api.npmjs.org";
  readonly package: "typescript";
  readonly discoveredTools: 6;
  readonly invokedTools: 6;
  readonly pointResponses: 3;
  readonly rangeResponses: 3;
  readonly httpStatuses: readonly [200, 200, 200, 200, 200, 200];
  readonly credentialCanariesAbsent: true;
  readonly cleanupVerified: true;
}

export async function runExecutorLiveReadToolMatrix(): Promise<ExecutorLiveReadToolMatrixResult> {
  const id = randomBytes(6).toString("hex");
  const platform = await executorDockerPlatform();
  const image = executorPlatformImage(platform);
  const name = `pactmark-executor-live-read-${id}`;
  const dataRoot = await mkdtemp(join(tmpdir(), `pactmark-executor-live-read-${id}-`));
  const dataDirectory = join(dataRoot, "data");
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const email = `pactmark-live-read-${id}@example.invalid`;
  const password = `Password-live-read-${id}-canary`;
  const authSecret = `auth-live-read-${id}-${"0".repeat(40)}`;
  const slug = `npm-read-${id}`;
  let primaryError: unknown;
  let result: ExecutorLiveReadToolMatrixResult | undefined;
  try {
    await assertPinnedImage(platform);
    await mkdir(dataDirectory);
    await chmod(dataDirectory, 0o770);
    await runDocker([
      "run",
      "--detach",
      "--name",
      name,
      "--pull",
      "never",
      "--network",
      "bridge",
      "--user",
      "65532:65532",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532,mode=0700",
      "--mount",
      `type=bind,source=${dataDirectory},target=/data`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--ulimit",
      "nofile=256:256",
      "--restart",
      "no",
      "--publish",
      `127.0.0.1:${String(port)}:4788`,
      "--env",
      "DO_NOT_TRACK=1",
      "--env",
      "EXECUTOR_DISABLE_ANALYTICS=1",
      "--env",
      "EXECUTOR_ALLOW_LOCAL_NETWORK=false",
      "--env",
      "EXECUTOR_ALLOW_STDIO_MCP=false",
      "--env",
      `EXECUTOR_WEB_BASE_URL=${origin}`,
      "--env",
      `BETTER_AUTH_SECRET=${authSecret}`,
      "--env",
      `EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=${email}`,
      "--env",
      `EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=${password}`,
      "--env",
      "EXECUTOR_ORG_NAME=Pactmark Live Read",
      "--env",
      `EXECUTOR_ORG_SLUG=${slug}`,
      image,
    ]);
    await waitForHealth(name);
    const signedIn = await signIn({ origin, email, password });
    const apiKey = await mintApiKey({ origin }, signedIn.token);
    const mcp = await initializeMcp(origin, apiKey);
    const authHeaders = {
      authorization: `Bearer ${signedIn.token}`,
      "content-type": "application/json",
      origin,
    };
    const addSpec = await fetch(`${origin}/api/openapi/specs`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        spec: { kind: "blob", value: JSON.stringify(liveReadSpec()) },
        slug,
        baseUrl: "https://api.npmjs.org/downloads",
        authenticationTemplate: [],
      }),
    });
    expectSuccess(addSpec, "KAF_EXECUTOR_LIVE_READ_SPEC_FAILED");
    const added = await responseJson(addSpec, "KAF_EXECUTOR_LIVE_READ_SPEC_MALFORMED");
    if (added["slug"] !== slug || added["toolCount"] !== expectedOperationCount) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_SPEC_MALFORMED");
    }
    const createConnection = await fetch(`${origin}/api/connections`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        owner: "org",
        name: "public-read",
        integration: slug,
        template: "none",
        values: {},
      }),
    });
    expectSuccess(createConnection, "KAF_EXECUTOR_LIVE_READ_CONNECTION_FAILED");
    const connection = await responseJson(
      createConnection,
      "KAF_EXECUTOR_LIVE_READ_CONNECTION_MALFORMED",
    );
    if (connection["integration"] !== slug || connection["name"] !== "publicRead") {
      throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_CONNECTION_MALFORMED", {
        safeDetail: JSON.stringify({
          integration: connection["integration"],
          name: connection["name"],
          owner: connection["owner"],
          address: connection["address"],
        }),
      });
    }
    const matrix = await execute(
      mcp,
      `const found=await tools.search({namespace:${JSON.stringify(slug)},query:"",limit:20}); if(found.total!==6||found.items.length!==6)return {ok:false,reason:"catalog",total:found.total}; const outcomes=[]; for(const item of found.items){ const r=await tools[item.path]({package:"typescript"}); if(!r.ok)return {ok:false,reason:"tool",path:item.path,code:r.error?.code}; const downloads=r.data?.downloads; const shape=typeof downloads==="number"?"point":Array.isArray(downloads)?"range":"invalid"; outcomes.push({path:item.path,status:r.http?.status,shape}); } return {ok:true,outcomes};`,
      30,
    );
    if (matrix["ok"] !== true || !Array.isArray(matrix["outcomes"])) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_MATRIX_FAILED");
    }
    const outcomes = matrix["outcomes"].map((value) =>
      ensureObject(value, "KAF_EXECUTOR_LIVE_READ_MATRIX_MALFORMED"),
    );
    const statuses = outcomes.map((value) => value["status"]);
    const pointResponses = outcomes.filter((value) => value["shape"] === "point").length;
    const rangeResponses = outcomes.filter((value) => value["shape"] === "range").length;
    if (
      outcomes.length !== expectedOperationCount ||
      !statuses.every((status) => status === 200) ||
      pointResponses !== 3 ||
      rangeResponses !== 3
    ) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_MATRIX_MALFORMED", {
        safeDetail: JSON.stringify({ statuses, pointResponses, rangeResponses }),
      });
    }
    const logs = await runDocker(["logs", name]);
    const combinedLogs = `${logs.stdout}\n${logs.stderr}`;
    if ([password, authSecret, apiKey].some((secret) => combinedLogs.includes(secret))) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_CREDENTIAL_LEAKED");
    }
    result = Object.freeze({
      schemaVersion: "1",
      claim: "network_authorized_public_read_only_tool_matrix",
      image,
      publicApiOrigin: "https://api.npmjs.org",
      package: "typescript",
      discoveredTools: 6,
      invokedTools: 6,
      pointResponses: 3,
      rangeResponses: 3,
      httpStatuses: [200, 200, 200, 200, 200, 200] as const,
      credentialCanariesAbsent: true,
      cleanupVerified: true,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    await removeContainer(name);
    await rm(dataRoot, { recursive: true, force: true });
    const containers = await runDocker(["ps", "--all", "--format", "{{.Names}}"]);
    const remaining = containers.stdout.split(/\s+/u).includes(name);
    let dataStillExists = false;
    try {
      await access(dataRoot);
      dataStillExists = true;
    } catch {
      // Expected: exact temporary data root has been removed.
    }
    if (remaining || dataStillExists) {
      primaryError ??= new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_CLEANUP_FAILED");
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) throw primaryError;
    throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_MATRIX_FAILED");
  }
  if (result === undefined) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_LIVE_READ_MATRIX_FAILED");
  }
  return result;
}
