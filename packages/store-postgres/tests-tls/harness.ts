import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ToolOutput = Readonly<{ stdout: string; stderr: string }>;
export interface TlsToolRunner {
  run(command: string, args: readonly string[]): Promise<ToolOutput>;
}

export class RealTlsToolRunner implements TlsToolRunner {
  readonly outputs: ToolOutput[] = [];

  async run(command: string, args: readonly string[]): Promise<ToolOutput> {
    const result = await execFileAsync(command, [...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const output = { stdout: result.stdout, stderr: result.stderr };
    this.outputs.push(output);
    return output;
  }
}

export type TlsHarnessOptions = Readonly<{
  certificateDirectory: string;
  containerName: string;
  canary: string;
  databasePassword: string;
}>;

export class PostgresTlsHarness {
  readonly #runner: TlsToolRunner;
  readonly #options: TlsHarnessOptions;

  constructor(runner: TlsToolRunner, options: TlsHarnessOptions) {
    this.#runner = runner;
    this.#options = options;
  }

  async assertPrerequisites(): Promise<void> {
    await this.#runner.run("openssl", ["version"]);
    // Inspect only: absence is a hard bootstrap failure. Never let `docker run`
    // silently pull an image from the network in this verification gate.
    await this.#runner.run("docker", ["image", "inspect", "postgres:17"]);
  }

  async generateCertificates(): Promise<Readonly<{ ca: string; untrustedCa: string }>> {
    const directory = this.#options.certificateDirectory;
    const serverConfig = `${directory}/server.cnf`;
    await writeFile(
      serverConfig,
      `[req]\nprompt = no\ndistinguished_name = dn\nreq_extensions = server_ext\n[dn]\nCN = localhost\n[server_ext]\nsubjectAltName = DNS:localhost\nextendedKeyUsage = serverAuth\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await this.#runner.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-keyout",
      `${directory}/ca.key`,
      "-out",
      `${directory}/ca.crt`,
      "-subj",
      `/CN=${this.#options.canary}`,
    ]);
    await this.#runner.run("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      `${directory}/server.key`,
      "-out",
      `${directory}/server.csr`,
      "-config",
      serverConfig,
    ]);
    await this.#runner.run("openssl", [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "1",
      "-in",
      `${directory}/server.csr`,
      "-CA",
      `${directory}/ca.crt`,
      "-CAkey",
      `${directory}/ca.key`,
      "-CAcreateserial",
      "-out",
      `${directory}/server.crt`,
      "-extensions",
      "server_ext",
      "-extfile",
      serverConfig,
    ]);
    await this.#runner.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-keyout",
      `${directory}/untrusted-ca.key`,
      "-out",
      `${directory}/untrusted-ca.crt`,
      "-subj",
      "/CN=pactmark-untrusted-test-ca",
    ]);
    return { ca: `${directory}/ca.crt`, untrustedCa: `${directory}/untrusted-ca.crt` };
  }

  async start(): Promise<number> {
    const setup = [
      "cp /pactmark-tls/server.crt /var/lib/postgresql/server.crt",
      "cp /pactmark-tls/server.key /var/lib/postgresql/server.key",
      "chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key",
      "chmod 600 /var/lib/postgresql/server.key",
      "chmod 644 /var/lib/postgresql/server.crt",
      [
        "exec docker-entrypoint.sh postgres",
        "-c ssl=on",
        "-c ssl_cert_file=/var/lib/postgresql/server.crt",
        "-c ssl_key_file=/var/lib/postgresql/server.key",
        '-c "listen_addresses=*"',
      ].join(" "),
    ].join(" && ");
    await this.#runner.run("docker", [
      "run",
      "--rm",
      "-d",
      "--pull=never",
      "--name",
      this.#options.containerName,
      "-e",
      `POSTGRES_PASSWORD=${this.#options.databasePassword}`,
      "-e",
      "POSTGRES_DB=pactmark_tls",
      "-v",
      `${this.#options.certificateDirectory}:/pactmark-tls:ro`,
      "-p",
      "127.0.0.1::5432",
      "postgres:17",
      "bash",
      "-ceu",
      setup,
    ]);
    const portOutput = await this.#runner.run("docker", [
      "port",
      this.#options.containerName,
      "5432/tcp",
    ]);
    const match = /127\.0\.0\.1:(\d+)/u.exec(portOutput.stdout);
    if (match?.[1] === undefined) throw new Error("TLS_POSTGRES_RANDOM_PORT_NOT_FOUND");
    await this.#waitUntilReady();
    return Number(match[1]);
  }

  async stop(): Promise<void> {
    await this.#runner.run("docker", ["rm", "-f", this.#options.containerName]);
  }

  async #waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.#runner.run("docker", [
          "exec",
          this.#options.containerName,
          "pg_isready",
          "-h",
          "localhost",
          "-U",
          "postgres",
          "-d",
          "pactmark_tls",
        ]);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("TLS_POSTGRES_READINESS_TIMEOUT", { cause: lastError });
  }
}

export function assertNoCanary(value: string, canary: string, location: string): void {
  if (value.includes(canary)) throw new Error(`TLS_CANARY_LEAK:${location}`);
}
