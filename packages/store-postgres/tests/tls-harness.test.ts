import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PostgresTlsHarness, type TlsToolRunner, type ToolOutput } from "../tests-tls/harness.js";

describe("Postgres TLS tooling harness", () => {
  it("uses an exact localhost SAN, an inspected image, a random loopback port, and bounded cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pactmark-postgres-tls-double-"));
    const runner = new RecordingRunner();
    const harness = new PostgresTlsHarness(runner, {
      certificateDirectory: directory,
      containerName: "pactmark-postgres-tls-double",
      canary: "PACTMARK_TLS_CANARY_DOUBLE",
      databasePassword: "double-password",
    });
    try {
      await harness.assertPrerequisites();
      await harness.generateCertificates();
      const serverConfig = await readFile(join(directory, "server.cnf"), "utf8");
      expect(serverConfig).toContain("subjectAltName = DNS:localhost");
      expect(serverConfig).not.toContain("IP:");
      await expect(harness.start()).resolves.toBe(55432);
      await harness.stop();
      expect(runner.calls[0]).toEqual(["openssl", "version"]);
      expect(runner.calls[1]).toEqual(["docker", "image", "inspect", "postgres:17"]);
      const run = runner.calls.find((call) => call[0] === "docker" && call[1] === "run");
      expect(run).toEqual(expect.arrayContaining(["--pull=never", "127.0.0.1::5432"]));
      const setup = run?.at(-1);
      expect(setup).toContain(
        'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key -c "listen_addresses=*"',
      );
      expect(setup).not.toContain("ssl=on && -c");
      expect(runner.calls).toContainEqual(["docker", "rm", "-f", "pactmark-postgres-tls-double"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class RecordingRunner implements TlsToolRunner {
  readonly calls: string[][] = [];

  async run(command: string, args: readonly string[]): Promise<ToolOutput> {
    await Promise.resolve();
    this.calls.push([command, ...args]);
    if (command === "docker" && args[0] === "port") {
      return { stdout: "127.0.0.1:55432\n", stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  }
}
