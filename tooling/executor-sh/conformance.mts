import { randomBytes, webcrypto } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  defineExecutorSelfHostConformanceReceipt,
  type ExecutorSelfHostConformanceReceipt,
  type ExecutorSelfHostPlatform,
} from "../../packages/executor-sh/src/deployment.js";
import { digestCanonicalJson, type JsonValue } from "@pactmark/core";

import {
  ExecutorConformanceError,
  assertPinnedImage,
  executorDockerPlatform,
  executorPlatformImage,
  runDocker,
} from "./docker.mjs";

const imageMemoryBytes = 512 * 1024 * 1024;
const imageNanoCpus = 1_000_000_000;
const imagePidsLimit = 128;
const maximumWaitMs = 60_000;

function recursiveChownProgram(uid: number, gid: number): string {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const uid = ${String(uid)};`,
    `const gid = ${String(gid)};`,
    "const visit = (directory) => {",
    "  for (const name of fs.readdirSync(directory)) {",
    "    const target = path.join(directory, name);",
    "    const stat = fs.lstatSync(target);",
    "    if (stat.isDirectory()) visit(target);",
    "    fs.lchownSync(target, uid, gid);",
    "  }",
    "};",
    'visit("/data");',
  ].join("\n");
}

async function chownLinuxBindMountContents(input: {
  readonly dataRoot: string;
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
}): Promise<void> {
  if (process.platform !== "linux") return;
  await runDocker(
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--user",
      "0:0",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=8m,mode=0700",
      "--mount",
      `type=bind,source=${input.dataRoot},target=/data`,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "16",
      "--memory",
      "64m",
      "--memory-swap",
      "64m",
      "--cpus",
      "0.25",
      "--entrypoint",
      "bun",
      input.image,
      "-e",
      recursiveChownProgram(input.uid, input.gid),
    ],
    { timeoutMs: maximumWaitMs },
  );
}

export type JsonObject = Readonly<Record<string, JsonValue>>;

interface TenantRuntime {
  readonly label: "a" | "b" | "restore";
  readonly name: string;
  readonly ingressName: string;
  readonly dataDirectory: string;
  readonly email: string;
  readonly password: string;
  readonly authSecret: string;
  readonly orgSlug: string;
  readonly port: number;
  readonly origin: string;
}

export interface McpSession {
  readonly token: string;
  readonly sessionId: string;
  readonly origin: string;
}

function ensureObject(value: unknown, code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutorConformanceError(code);
  }
  return value as JsonObject;
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new ExecutorConformanceError(code, { cause });
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExecutorConformanceError(code);
  }
  return value;
}

async function responseJson(response: Response, code: string): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new ExecutorConformanceError(code, { cause });
  }
  return ensureObject(value, code);
}

function expectStatus(
  response: Response,
  expected: number | readonly number[],
  code: string,
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new ExecutorConformanceError(code, {
      safeDetail: `unexpected HTTP status ${String(response.status)}`,
    });
  }
}

export async function waitForHealth(name: string): Promise<void> {
  const deadline = Date.now() + maximumWaitMs;
  while (Date.now() < deadline) {
    const state = (
      await runDocker([
        "inspect",
        "--format",
        "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
        name,
      ])
    ).stdout.trim();
    if (state === "running healthy") return;
    if (state.startsWith("exited") || state.startsWith("dead")) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_CONTAINER_EXITED");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ExecutorConformanceError("KAF_EXECUTOR_HEALTH_TIMEOUT");
}

async function publishedPort(name: string): Promise<number> {
  const output = (
    await runDocker([
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "4788/tcp") 0).HostPort}}',
      name,
    ])
  ).stdout.trim();
  const port = Number(output);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PUBLISHED_PORT_INVALID");
  }
  return port;
}

async function startIngress(input: {
  readonly name: string;
  readonly targetName: string;
  readonly image: string;
  readonly network: string;
  readonly port: number;
}): Promise<void> {
  const proxyCode = [
    `const target=${JSON.stringify(`http://${input.targetName}:4788`)};`,
    'Bun.serve({hostname:"0.0.0.0",port:4788,async fetch(request){',
    "const source=new URL(request.url);",
    "const url=target+source.pathname+source.search;",
    'const body=request.method==="GET"||request.method==="HEAD"?undefined:request.body;',
    'return fetch(url,{method:request.method,headers:request.headers,body,redirect:"manual"});',
    "}});",
  ].join("");
  await runDocker([
    "create",
    "--name",
    input.name,
    "--network",
    "bridge",
    "--user",
    "65532:65532",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=8m,uid=65532,gid=65532,mode=0700",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "0.25",
    "--ulimit",
    "nofile=128:128",
    "--restart",
    "no",
    "--publish",
    `127.0.0.1:${String(input.port)}:4788`,
    input.image,
    "bun",
    "-e",
    proxyCode,
  ]);
  await runDocker(["network", "connect", input.network, input.name]);
  await runDocker(["start", input.name]);
  await waitForHealth(input.name);
  if ((await publishedPort(input.name)) !== input.port) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PUBLISHED_PORT_INVALID");
  }
}

export function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else if (port <= 0)
          reject(new ExecutorConformanceError("KAF_EXECUTOR_PUBLISHED_PORT_INVALID"));
        else resolve(port);
      });
    });
  });
}

async function startTenant(input: {
  readonly id: string;
  readonly label: TenantRuntime["label"];
  readonly dataDirectory: string;
  readonly image: string;
  readonly network: string;
  readonly credentialsFrom?: TenantRuntime;
}): Promise<TenantRuntime> {
  const credentials = input.credentialsFrom;
  const name = `pactmark-executor-${input.label}-${input.id}`;
  const ingressName = `${name}-ingress`;
  const email = credentials?.email ?? `pactmark-${input.label}-${input.id}@example.invalid`;
  const password = credentials?.password ?? `Password-${input.label}-${input.id}-canary`;
  const authSecret = credentials?.authSecret ?? `auth-${input.label}-${input.id}-${"0".repeat(40)}`;
  const orgSlug = credentials?.orgSlug ?? `pactmark-${input.label}-${input.id}`;
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${String(port)}`;
  await runDocker([
    "run",
    "--detach",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    input.network,
    "--user",
    "65532:65532",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532,mode=0700",
    "--mount",
    `type=bind,source=${input.dataDirectory},target=/data`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(imagePidsLimit),
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
    `EXECUTOR_ORG_NAME=Pactmark ${input.label.toUpperCase()}`,
    "--env",
    `EXECUTOR_ORG_SLUG=${orgSlug}`,
    input.image,
  ]);
  await waitForHealth(name);
  await startIngress({
    name: ingressName,
    targetName: name,
    image: input.image,
    network: input.network,
    port,
  });
  return Object.freeze({
    label: input.label,
    name,
    ingressName,
    dataDirectory: input.dataDirectory,
    email,
    password,
    authSecret,
    orgSlug,
    port,
    origin,
  });
}

async function assertContainerSecurity(runtime: TenantRuntime, network: string): Promise<void> {
  const [hostRaw, configRaw, mountsRaw] = await Promise.all([
    runDocker(["inspect", "--format", "{{json .HostConfig}}", runtime.name]),
    runDocker(["inspect", "--format", "{{json .Config}}", runtime.name]),
    runDocker(["inspect", "--format", "{{json .Mounts}}", runtime.name]),
  ]);
  const host = ensureObject(
    parseJson(hostRaw.stdout, "KAF_EXECUTOR_HOST_CONFIG_INVALID"),
    "KAF_EXECUTOR_HOST_CONFIG_INVALID",
  );
  const config = ensureObject(
    parseJson(configRaw.stdout, "KAF_EXECUTOR_IMAGE_CONFIG_INVALID"),
    "KAF_EXECUTOR_IMAGE_CONFIG_INVALID",
  );
  const mountsValue = parseJson(mountsRaw.stdout, "KAF_EXECUTOR_MOUNTS_INVALID");
  const mounts = Array.isArray(mountsValue)
    ? (mountsValue as readonly unknown[]).map((mount) =>
        ensureObject(mount, "KAF_EXECUTOR_MOUNTS_INVALID"),
      )
    : [];
  const capDrop = host["CapDrop"];
  const securityOpt = host["SecurityOpt"];
  const portBindings = host["PortBindings"];
  const onlyMount = mounts.length === 1 ? mounts[0] : undefined;
  const onlyDataVolume =
    onlyMount !== undefined &&
    onlyMount["Type"] === "bind" &&
    onlyMount["Source"] === runtime.dataDirectory &&
    onlyMount["Destination"] === "/data" &&
    onlyMount["RW"] === true;
  const hasNoPublishedPorts =
    portBindings === null ||
    (typeof portBindings === "object" &&
      !Array.isArray(portBindings) &&
      Object.keys(portBindings).length === 0);
  if (
    config["User"] !== "65532:65532" ||
    host["ReadonlyRootfs"] !== true ||
    host["NetworkMode"] !== network ||
    !Array.isArray(capDrop) ||
    capDrop.length !== 1 ||
    capDrop[0] !== "ALL" ||
    !Array.isArray(securityOpt) ||
    !securityOpt.some((item) => typeof item === "string" && item.startsWith("no-new-privileges")) ||
    host["PidsLimit"] !== imagePidsLimit ||
    host["Memory"] !== imageMemoryBytes ||
    host["MemorySwap"] !== imageMemoryBytes ||
    host["NanoCpus"] !== imageNanoCpus ||
    !onlyDataVolume ||
    !hasNoPublishedPorts
  ) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_CONTAINER_SECURITY_INVALID");
  }
  await assertIngressSecurity(runtime, network);
}

async function assertIngressSecurity(runtime: TenantRuntime, network: string): Promise<void> {
  const [hostRaw, configRaw, networksRaw] = await Promise.all([
    runDocker(["inspect", "--format", "{{json .HostConfig}}", runtime.ingressName]),
    runDocker(["inspect", "--format", "{{json .Config}}", runtime.ingressName]),
    runDocker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", runtime.ingressName]),
  ]);
  const host = ensureObject(JSON.parse(hostRaw.stdout), "KAF_EXECUTOR_INGRESS_CONFIG_INVALID");
  const config = ensureObject(JSON.parse(configRaw.stdout), "KAF_EXECUTOR_INGRESS_CONFIG_INVALID");
  const networks = ensureObject(
    JSON.parse(networksRaw.stdout),
    "KAF_EXECUTOR_INGRESS_CONFIG_INVALID",
  );
  const portBindings = ensureObject(host["PortBindings"], "KAF_EXECUTOR_PORT_BINDING_INVALID");
  const published = portBindings["4788/tcp"];
  const capDrop = host["CapDrop"];
  const securityOpt = host["SecurityOpt"];
  const loopbackOnly =
    Array.isArray(published) &&
    published.length === 1 &&
    ensureObject(published[0], "KAF_EXECUTOR_PORT_BINDING_INVALID")["HostIp"] === "127.0.0.1";
  if (
    config["User"] !== "65532:65532" ||
    host["ReadonlyRootfs"] !== true ||
    host["NetworkMode"] !== "bridge" ||
    networks[network] === undefined ||
    networks["bridge"] === undefined ||
    !Array.isArray(capDrop) ||
    capDrop.length !== 1 ||
    capDrop[0] !== "ALL" ||
    !Array.isArray(securityOpt) ||
    !securityOpt.some((item) => String(item).startsWith("no-new-privileges")) ||
    !loopbackOnly
  ) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_INGRESS_SECURITY_INVALID");
  }
}

export async function signIn(
  runtime: Pick<TenantRuntime, "origin" | "email" | "password">,
): Promise<Readonly<{ token: string; cookie: string }>> {
  const response = await fetch(`${runtime.origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: runtime.origin },
    body: JSON.stringify({ email: runtime.email, password: runtime.password }),
    redirect: "manual",
  });
  expectStatus(response, 200, "KAF_EXECUTOR_SIGN_IN_FAILED");
  const token = response.headers.get("set-auth-token") ?? "";
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (token.length < 20 || cookie.length < 10) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_SIGN_IN_CREDENTIAL_MISSING");
  }
  return Object.freeze({ token, cookie });
}

export async function mintApiKey(
  runtime: Pick<TenantRuntime, "origin">,
  sessionToken: string,
): Promise<string> {
  const response = await fetch(`${runtime.origin}/api/account/api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      origin: runtime.origin,
    },
    body: JSON.stringify({ name: "Pactmark production conformance" }),
  });
  expectStatus(response, 200, "KAF_EXECUTOR_API_KEY_MINT_FAILED");
  const value = requiredString(
    (await responseJson(response, "KAF_EXECUTOR_API_KEY_MALFORMED"))["value"],
    "KAF_EXECUTOR_API_KEY_MALFORMED",
  );
  if (value.length < 20) throw new ExecutorConformanceError("KAF_EXECUTOR_API_KEY_MALFORMED");
  return value;
}

async function mcpRequest(
  origin: string,
  token: string | undefined,
  body: JsonObject,
  sessionId?: string,
): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

const initializeBody = Object.freeze({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "pactmark-production-conformance", version: "1" },
  },
}) satisfies JsonObject;

export async function initializeMcp(origin: string, token: string): Promise<McpSession> {
  const response = await mcpRequest(origin, token, initializeBody);
  expectStatus(response, 200, "KAF_EXECUTOR_MCP_INITIALIZE_FAILED");
  const body = await responseJson(response, "KAF_EXECUTOR_MCP_INITIALIZE_MALFORMED");
  const result = ensureObject(body["result"], "KAF_EXECUTOR_MCP_INITIALIZE_MALFORMED");
  const info = ensureObject(result["serverInfo"], "KAF_EXECUTOR_MCP_INITIALIZE_MALFORMED");
  const sessionId = response.headers.get("mcp-session-id") ?? "";
  if (sessionId.length === 0 || info["name"] !== "executor" || info["version"] !== "1.0.0") {
    throw new ExecutorConformanceError("KAF_EXECUTOR_MCP_IDENTITY_DRIFT");
  }
  const initialized = await mcpRequest(
    origin,
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  expectStatus(initialized, 202, "KAF_EXECUTOR_MCP_INITIALIZED_FAILED");
  return Object.freeze({ token, sessionId, origin });
}

export async function execute(session: McpSession, code: string, id = 10): Promise<JsonObject> {
  const response = await mcpRequest(
    session.origin,
    session.token,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "execute", arguments: { code } },
    },
    session.sessionId,
  );
  expectStatus(response, 200, "KAF_EXECUTOR_EXECUTE_FAILED");
  const body = await responseJson(response, "KAF_EXECUTOR_EXECUTE_MALFORMED");
  const result = ensureObject(body["result"], "KAF_EXECUTOR_EXECUTE_MALFORMED");
  const structured = ensureObject(result["structuredContent"], "KAF_EXECUTOR_EXECUTE_MALFORMED");
  if (structured["status"] !== "completed") {
    const executionError =
      typeof structured["error"] === "object" && structured["error"] !== null
        ? ensureObject(structured["error"], "KAF_EXECUTOR_EXECUTE_NOT_COMPLETED")
        : undefined;
    throw new ExecutorConformanceError("KAF_EXECUTOR_EXECUTE_NOT_COMPLETED", {
      safeDetail: JSON.stringify({
        status: stringOrEmpty(structured["status"]).slice(0, 100),
        code: stringOrEmpty(executionError?.["code"]).slice(0, 100),
      }),
    });
  }
  return ensureObject(structured["result"], "KAF_EXECUTOR_EXECUTE_RESULT_MALFORMED");
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function verifyOAuth(runtime: TenantRuntime, cookie: string): Promise<string> {
  const registration = await fetch(`${runtime.origin}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Pactmark production conformance",
      redirect_uris: ["http://127.0.0.1:9/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expectStatus(registration, [200, 201], "KAF_EXECUTOR_OAUTH_REGISTER_FAILED");
  const clientId = requiredString(
    (await responseJson(registration, "KAF_EXECUTOR_OAUTH_REGISTER_MALFORMED"))["client_id"],
    "KAF_EXECUTOR_OAUTH_REGISTER_MALFORMED",
  );
  const verifier = base64Url(webcrypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorizeUrl = new URL(`${runtime.origin}/api/auth/mcp/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid",
  }).toString();
  const authorize = await fetch(authorizeUrl, {
    headers: { cookie },
    redirect: "manual",
  });
  expectStatus(authorize, 302, "KAF_EXECUTOR_OAUTH_AUTHORIZE_FAILED");
  const consentUrl = new URL(authorize.headers.get("location") ?? "", runtime.origin);
  const consentCode = consentUrl.searchParams.get("consent_code") ?? "";
  if (consentUrl.pathname !== "/mcp-consent" || consentCode.length === 0) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_OAUTH_CONSENT_MALFORMED");
  }
  const consent = await fetch(`${runtime.origin}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: runtime.origin },
    body: JSON.stringify({ accept: true, consent_code: consentCode }),
  });
  expectStatus(consent, 200, "KAF_EXECUTOR_OAUTH_CONSENT_FAILED");
  const redirectUri = requiredString(
    (await responseJson(consent, "KAF_EXECUTOR_OAUTH_CONSENT_MALFORMED"))["redirectURI"],
    "KAF_EXECUTOR_OAUTH_CONSENT_MALFORMED",
  );
  const code = new URL(redirectUri).searchParams.get("code") ?? "";
  const token = await fetch(`${runtime.origin}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:9/callback",
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  expectStatus(token, 200, "KAF_EXECUTOR_OAUTH_TOKEN_FAILED");
  const accessToken = requiredString(
    (await responseJson(token, "KAF_EXECUTOR_OAUTH_TOKEN_MALFORMED"))["access_token"],
    "KAF_EXECUTOR_OAUTH_TOKEN_MALFORMED",
  );
  await initializeMcp(runtime.origin, accessToken);
  return accessToken;
}

async function verifyPrivateNetworkDenied(
  runtime: TenantRuntime,
  session: McpSession,
  sessionToken: string,
  slug: string,
): Promise<void> {
  const isNetworkDenial = (value: unknown): boolean => {
    const reason = stringOrEmpty(value).toLowerCase();
    return (
      reason.includes("private") ||
      reason.includes("local") ||
      reason.includes("blocked") ||
      reason.includes("denied")
    );
  };
  const spec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pactmark private-network canary", version: "1" },
    servers: [{ url: "http://127.0.0.1:4788" }],
    paths: {
      "/api/health": {
        get: {
          operationId: "getPrivateHealth",
          responses: { "200": { description: "Never reachable" } },
        },
      },
    },
  });
  const authHeaders = {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
    origin: runtime.origin,
  };
  const added = await fetch(`${runtime.origin}/api/openapi/specs`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      spec: { kind: "blob", value: spec },
      slug,
      baseUrl: "http://127.0.0.1:4788",
      authenticationTemplate: [],
    }),
  });
  expectStatus(added, [200, 201], "KAF_EXECUTOR_PRIVATE_SPEC_FAILED");
  if ((await responseJson(added, "KAF_EXECUTOR_PRIVATE_SPEC_FAILED"))["slug"] !== slug) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PRIVATE_SPEC_FAILED");
  }
  const created = await fetch(`${runtime.origin}/api/connections`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      owner: "org",
      name: "private",
      integration: slug,
      template: "none",
      values: {},
    }),
  });
  expectStatus(created, [200, 201], "KAF_EXECUTOR_PRIVATE_CONNECTION_FAILED");
  if (
    (await responseJson(created, "KAF_EXECUTOR_PRIVATE_CONNECTION_FAILED"))["integration"] !== slug
  ) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PRIVATE_CONNECTION_FAILED");
  }
  const logsBefore = await runDocker(["logs", runtime.name]);
  const invoked = await execute(
    session,
    `const f=await tools.search({namespace:${JSON.stringify(slug)},query:"private health",limit:5}); const p=f.items[0]?.path; if(!p)return {blocked:false,reason:"tool_missing"}; try { const r=await tools[p]({}); return {blocked:!r.ok,reason:r.ok?"request_succeeded":String(r.error?.message??r.error?.code??"tool_error")}; } catch(e) { return {blocked:true,reason:String(e?.message??e)}; }`,
    22,
  );
  const reason = stringOrEmpty(invoked["reason"]);
  let networkDenied = isNetworkDenial(reason);
  const correlationId = /^Internal tool error \[([0-9a-f]{8})\]$/u.exec(reason)?.[1];
  if (!networkDenied && correlationId !== undefined) {
    for (let attempt = 0; attempt < 10 && !networkDenied; attempt += 1) {
      const logsAfter = await runDocker(["logs", runtime.name]);
      const newLogs = `${logsAfter.stdout.slice(logsBefore.stdout.length)}\n${logsAfter.stderr.slice(logsBefore.stderr.length)}`;
      networkDenied = newLogs.includes("Local and private network addresses are not allowed");
      if (!networkDenied) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (invoked["blocked"] !== true || !networkDenied) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_PRIVATE_NETWORK_NOT_BLOCKED", {
      safeDetail: JSON.stringify({
        blocked: invoked["blocked"],
        reason: reason.slice(0, 400),
      }),
    });
  }
}

async function verifyStdioDisabled(runtime: TenantRuntime, sessionToken: string): Promise<void> {
  const slug = `stdio-denied-${randomBytes(4).toString("hex")}`;
  const canaryPath = "/data/stdio-executed-canary";
  const response = await fetch(`${runtime.origin}/api/mcp/servers`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      origin: runtime.origin,
    },
    body: JSON.stringify({
      transport: "stdio",
      name: "Pactmark stdio denial canary",
      slug,
      command: "/bin/sh",
      args: ["-c", `touch ${canaryPath}`],
    }),
  });
  expectStatus(response, [200, 201], "KAF_EXECUTOR_STDIO_REGISTRATION_FAILED");
  const registered = await responseJson(response, "KAF_EXECUTOR_STDIO_REGISTRATION_MALFORMED");
  if (registered["slug"] !== slug) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_STDIO_REGISTRATION_MALFORMED");
  }
  const health = await fetch(
    `${runtime.origin}/api/connections/org/${encodeURIComponent(slug)}/default/health?ifStaleMs=0`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, origin: runtime.origin },
    },
  );
  expectStatus(health, 200, "KAF_EXECUTOR_STDIO_HEALTH_FAILED");
  const result = await responseJson(health, "KAF_EXECUTOR_STDIO_HEALTH_MALFORMED");
  const detail = stringOrEmpty(result["detail"]).toLowerCase();
  if (result["status"] === "healthy" || !detail.includes("stdio") || !detail.includes("disabled")) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_STDIO_NOT_BLOCKED");
  }
  const probe = await runDocker([
    "exec",
    runtime.name,
    "bun",
    "-e",
    `console.log(await Bun.file(${JSON.stringify(canaryPath)}).exists())`,
  ]);
  if (probe.stdout.trim() !== "false") {
    throw new ExecutorConformanceError("KAF_EXECUTOR_STDIO_EFFECT_OCCURRED");
  }
}

async function assertAnalyticsAndOutboundDenied(runtime: TenantRuntime): Promise<void> {
  const code = [
    'const files=[...new Bun.Glob("**/*").scanSync("/data")].sort();',
    'let outboundDenied=false; try { await fetch("https://us.i.posthog.com",{signal:AbortSignal.timeout(3000)}); } catch { outboundDenied=true; }',
    'console.log(JSON.stringify({uid:process.getuid?.(),gid:process.getgid?.(),analyticsIdPresent:files.includes("analytics-id"),outboundDenied}));',
  ].join(" ");
  const output = await runDocker(["exec", runtime.name, "bun", "-e", code]);
  const result = ensureObject(
    parseJson(output.stdout, "KAF_EXECUTOR_CONTAINER_PROBE_MALFORMED"),
    "KAF_EXECUTOR_CONTAINER_PROBE_MALFORMED",
  );
  if (
    result["uid"] !== 65_532 ||
    result["gid"] !== 65_532 ||
    result["analyticsIdPresent"] !== false ||
    result["outboundDenied"] !== true
  ) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_CONTAINER_PROBE_FAILED");
  }
}

async function backupDataDirectory(input: {
  readonly containerName: string;
  readonly source: string;
  readonly target: string;
  readonly image: string;
}): Promise<void> {
  const copyProgram = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'for (const name of fs.readdirSync("/source")) {',
    '  fs.cpSync(path.join("/source", name), path.join("/target", name), {',
    "    recursive: true,",
    "    force: true,",
    "  });",
    "}",
  ].join("\n");
  await runDocker(
    [
      "run",
      "--name",
      input.containerName,
      "--pull",
      "never",
      "--network",
      "none",
      "--user",
      "65532:65532",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=8m,uid=65532,gid=65532,mode=0700",
      "--mount",
      `type=bind,source=${input.source},target=/source,readonly`,
      "--mount",
      `type=bind,source=${input.target},target=/target`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "32",
      "--memory",
      "128m",
      "--memory-swap",
      "128m",
      "--cpus",
      "0.5",
      "--entrypoint",
      "bun",
      input.image,
      "-e",
      copyProgram,
    ],
    { timeoutMs: maximumWaitMs },
  );
}

async function assertNoCanaryLeak(
  runtime: TenantRuntime,
  secrets: readonly string[],
): Promise<void> {
  const output = await runDocker(["logs", runtime.name]);
  const logs = `${output.stdout}\n${output.stderr}`;
  if (secrets.some((secret) => secret.length > 0 && logs.includes(secret))) {
    throw new ExecutorConformanceError("KAF_EXECUTOR_CREDENTIAL_CANARY_LEAKED");
  }
}

async function removeIfPresent(kind: "container" | "network", name: string): Promise<void> {
  try {
    await runDocker(kind === "container" ? ["rm", "--force", name] : ["network", "rm", name], {
      timeoutMs: 15_000,
    });
  } catch {
    // Cleanup is verified after all exact targets have been attempted.
  }
}

async function assertCleanup(
  containers: readonly string[],
  network: string,
  dataRoot: string,
  image: string,
  restoreLinuxOwnership: boolean,
): Promise<void> {
  for (const name of containers) await removeIfPresent("container", name);
  await removeIfPresent("network", network);
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (restoreLinuxOwnership && hostUid !== undefined && hostGid !== undefined) {
    await chownLinuxBindMountContents({ dataRoot, image, uid: hostUid, gid: hostGid });
  }
  await rm(dataRoot, { recursive: true, force: true });
  const [containerList, networkList] = await Promise.all([
    runDocker(["ps", "--all", "--format", "{{.Names}}"]),
    runDocker(["network", "ls", "--format", "{{.Name}}"]),
  ]);
  const remaining = [
    ...containers.filter((name) => containerList.stdout.split(/\s+/u).includes(name)),
    ...(networkList.stdout.split(/\s+/u).includes(network) ? [network] : []),
  ];
  try {
    await access(dataRoot);
    remaining.push(dataRoot);
  } catch {
    // Expected: the exact temporary data root was removed.
  }
  if (remaining.length > 0) throw new ExecutorConformanceError("KAF_EXECUTOR_CLEANUP_FAILED");
}

export interface ExecutorContainerConformanceResult {
  readonly schemaVersion: "1";
  readonly claim: "production_guarded_read_only_gateway_fixture";
  readonly platform: ExecutorSelfHostPlatform;
  readonly image: string;
  readonly sourceRevision: string;
  readonly security: Readonly<{
    processUser: "65532:65532";
    readOnlyRootFilesystem: true;
    capabilitiesDropped: "ALL";
    noNewPrivileges: true;
    internalNetwork: true;
    loopbackPublishedPort: true;
    pidsLimit: 128;
    memoryBytes: number;
    nanoCpus: number;
  }>;
  readonly receipt: ExecutorSelfHostConformanceReceipt;
  readonly cleanup: Readonly<{
    containersRemoved: 7;
    dataDirectoriesRemoved: 3;
    networkRemoved: true;
  }>;
}

export async function runExecutorContainerConformance(): Promise<ExecutorContainerConformanceResult> {
  const id = randomBytes(6).toString("hex");
  const platform = await executorDockerPlatform();
  const image = executorPlatformImage(platform);
  const network = `pactmark-executor-net-${id}`;
  const dataRoot = await mkdtemp(join(tmpdir(), `pactmark-executor-${id}-`));
  const dataDirectories = {
    a: join(dataRoot, "a"),
    b: join(dataRoot, "b"),
    restore: join(dataRoot, "restore"),
  } as const;
  const allDataDirectories = Object.values(dataDirectories);
  const tenantContainers = [
    `pactmark-executor-a-${id}`,
    `pactmark-executor-b-${id}`,
    `pactmark-executor-restore-${id}`,
  ] as const;
  const backupContainer = `pactmark-executor-backup-${id}`;
  const containers = [
    ...tenantContainers,
    ...tenantContainers.map((name) => `${name}-ingress`),
    backupContainer,
  ];
  let primaryError: unknown;
  let result: ExecutorContainerConformanceResult | undefined;
  let linuxOwnershipPrepared = false;
  try {
    await assertPinnedImage(platform);
    const runtimeVersion = (
      await runDocker(["version", "--format", "{{.Server.Version}}"])
    ).stdout.trim();
    await runDocker(["network", "create", "--internal", network]);
    for (const dataDirectory of allDataDirectories) {
      await mkdir(dataDirectory);
      await chmod(dataDirectory, 0o770);
    }
    await chownLinuxBindMountContents({ dataRoot, image, uid: 65_532, gid: 65_532 });
    linuxOwnershipPrepared = process.platform === "linux";
    const tenantA = await startTenant({
      id,
      label: "a",
      dataDirectory: dataDirectories.a,
      image,
      network,
    });
    const tenantB = await startTenant({
      id,
      label: "b",
      dataDirectory: dataDirectories.b,
      image,
      network,
    });
    await Promise.all([
      assertContainerSecurity(tenantA, network),
      assertContainerSecurity(tenantB, network),
      assertAnalyticsAndOutboundDenied(tenantA),
      assertAnalyticsAndOutboundDenied(tenantB),
    ]);
    const [health, setup, unauthenticated] = await Promise.all([
      fetch(`${tenantA.origin}/api/health`),
      fetch(`${tenantA.origin}/api/setup-status`),
      mcpRequest(tenantA.origin, undefined, initializeBody),
    ]);
    expectStatus(health, 200, "KAF_EXECUTOR_HEALTH_FAILED");
    expectStatus(setup, 200, "KAF_EXECUTOR_SETUP_STATUS_FAILED");
    if (
      (await responseJson(setup, "KAF_EXECUTOR_SETUP_STATUS_MALFORMED"))["needsSetup"] !== false
    ) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_BOOTSTRAP_INCOMPLETE");
    }
    expectStatus(unauthenticated, 401, "KAF_EXECUTOR_UNAUTHENTICATED_MCP_NOT_DENIED");

    const signInA = await signIn(tenantA);
    const apiKeyA = await mintApiKey(tenantA, signInA.token);
    const apiSessionA = await initializeMcp(tenantA.origin, apiKeyA);
    const envelope = await execute(apiSessionA, "return { value: 1 };", 2);
    if (envelope["value"] !== 1) {
      throw new ExecutorConformanceError("KAF_EXECUTOR_EXECUTE_ENVELOPE_DRIFT");
    }
    const oauthToken = await verifyOAuth(tenantA, signInA.cookie);
    const crossTenant = await mcpRequest(tenantB.origin, apiKeyA, initializeBody);
    expectStatus(crossTenant, 401, "KAF_EXECUTOR_CROSS_TENANT_CREDENTIAL_ACCEPTED");
    await verifyStdioDisabled(tenantA, signInA.token);
    await verifyPrivateNetworkDenied(tenantA, apiSessionA, signInA.token, `private-${id}`);

    await runDocker(["restart", tenantA.name], { timeoutMs: maximumWaitMs });
    await waitForHealth(tenantA.name);
    await signIn(tenantA);
    await runDocker(["stop", tenantA.name], { timeoutMs: maximumWaitMs });
    await backupDataDirectory({
      containerName: backupContainer,
      source: tenantA.dataDirectory,
      target: dataDirectories.restore,
      image,
    });
    const restored = await startTenant({
      id,
      label: "restore",
      dataDirectory: dataDirectories.restore,
      image,
      network,
      credentialsFrom: tenantA,
    });
    await assertContainerSecurity(restored, network);
    await signIn(restored);
    await initializeMcp(restored.origin, apiKeyA);
    await Promise.all([
      assertNoCanaryLeak(tenantA, [tenantA.password, tenantA.authSecret, apiKeyA, oauthToken]),
      assertNoCanaryLeak(tenantB, [tenantA.password, tenantA.authSecret, apiKeyA, oauthToken]),
      assertNoCanaryLeak(restored, [tenantA.password, tenantA.authSecret, apiKeyA, oauthToken]),
    ]);

    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(observedAt) + 7 * 24 * 60 * 60 * 1_000 - 1).toISOString();
    const receipt = defineExecutorSelfHostConformanceReceipt({
      platform,
      containerRuntimeVersion: runtimeVersion,
      environmentDigest: digestCanonicalJson({
        platform,
        image,
        processUser: "65532:65532" as const,
        readOnlyRootFilesystem: true,
        capabilitiesDropped: "ALL" as const,
        noNewPrivileges: true,
        network: "internal_with_hardened_loopback_ingress",
        pidsLimit: 128,
        memoryBytes: imageMemoryBytes,
        nanoCpus: imageNanoCpus,
      }),
      observedAt,
      expiresAt,
      checks: {
        imagePinMatched: true,
        sourceRevisionMatched: true,
        mainProcessNonRoot: true,
        readOnlyRootFilesystem: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        resourceLimitsApplied: true,
        dedicatedDataVolume: true,
        restartPersistence: true,
        backupRestore: true,
        telemetryDisabled: true,
        analyticsIdAbsent: true,
        outboundNetworkDenied: true,
        privateNetworkDenied: true,
        stdioMcpDisabled: true,
        bootstrapCompleted: true,
        unauthenticatedMcpDenied: true,
        apiKeyMcpAuthenticated: true,
        oauthPkceAuthenticated: true,
        crossTenantCredentialDenied: true,
        credentialCanariesAbsent: true,
        executeEnvelopeMatched: true,
      },
    });
    result = Object.freeze({
      schemaVersion: "1",
      claim: "production_guarded_read_only_gateway_fixture",
      platform,
      image,
      sourceRevision: "b029643641832ef5f9b0d4ff263d96e1a5b2739c",
      security: {
        processUser: "65532:65532" as const,
        readOnlyRootFilesystem: true as const,
        capabilitiesDropped: "ALL" as const,
        noNewPrivileges: true as const,
        internalNetwork: true as const,
        loopbackPublishedPort: true as const,
        pidsLimit: 128,
        memoryBytes: imageMemoryBytes,
        nanoCpus: imageNanoCpus,
      } satisfies ExecutorContainerConformanceResult["security"],
      receipt,
      cleanup: {
        containersRemoved: 7 as const,
        dataDirectoriesRemoved: 3 as const,
        networkRemoved: true as const,
      },
    });
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await assertCleanup(containers, network, dataRoot, image, linuxOwnershipPrepared);
    } catch (cleanupError) {
      if (primaryError === undefined) primaryError = cleanupError;
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) throw primaryError;
    throw new ExecutorConformanceError("KAF_EXECUTOR_CONFORMANCE_FAILED");
  }
  if (result === undefined) throw new ExecutorConformanceError("KAF_EXECUTOR_CONFORMANCE_FAILED");
  return result;
}
