import { createHash } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const hostSecretPath = process.argv[3];

async function cannotRead(target) {
  try {
    await readFile(target);
    return false;
  } catch {
    return true;
  }
}

function cannotConnect(options) {
  return new Promise((resolve) => {
    const socket = net.createConnection(options);
    const finish = (failed) => {
      socket.destroy();
      resolve(failed);
    };
    socket.setTimeout(250, () => finish(true));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

async function isolationProbe() {
  if (typeof hostSecretPath !== "string" || !hostSecretPath.startsWith("/")) {
    throw new Error("KAF_SANDBOX_HOST_CANARY_PATH_INVALID");
  }
  const workspace = "/workspace";
  const artifactPath = path.join(workspace, "artifact.json");
  const artifact = JSON.stringify({ schemaVersion: "1", result: "workspace-export-ok" });
  await writeFile(artifactPath, artifact, { encoding: "utf8", mode: 0o600 });
  const exported = await readFile(artifactPath, "utf8");
  const symlinkPath = path.join(workspace, "host-secret-link");
  await symlink(hostSecretPath, symlinkPath);
  const traversalPath = `${workspace}/..${hostSecretPath}`;
  const result = {
    schemaVersion: "1",
    mode: "isolation",
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    checks: {
      hostSecretDenied: await cannotRead(hostSecretPath),
      parentTraversalDenied: await cannotRead(traversalPath),
      symlinkEscapeDenied: await cannotRead(symlinkPath),
      dockerSocketDenied: await cannotConnect({ path: "/var/run/docker.sock" }),
      loopbackDenied: await cannotConnect({ host: "127.0.0.1", port: 9 }),
      metadataDenied: await cannotConnect({ host: "169.254.169.254", port: 80 }),
      workspaceWrite: exported === artifact,
    },
    artifact: {
      path: "artifact.json",
      bytes: Buffer.byteLength(exported),
      sha256: createHash("sha256").update(exported).digest("hex"),
      body: JSON.parse(exported),
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function spawnOne() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: "ignore",
    });
    child.once("spawn", () => resolve(child));
    child.once("error", () => resolve(undefined));
  });
}

async function forkProbe() {
  const children = [];
  let limited = false;
  for (let index = 0; index < 256; index += 1) {
    const child = await spawnOne();
    if (child === undefined) {
      limited = true;
      break;
    }
    children.push(child);
  }
  for (const child of children) child.kill("SIGKILL");
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: "1", mode: "fork", limited, spawned: children.length })}\n`,
  );
}

if (mode === "isolation") await isolationProbe();
else if (mode === "fork") await forkProbe();
else if (mode === "loop") for (;;) Math.sqrt(2);
else if (mode === "output") for (;;) process.stdout.write("x".repeat(4096));
else throw new Error("KAF_SANDBOX_PROBE_MODE_INVALID");
