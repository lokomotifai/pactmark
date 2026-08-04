import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

import type { CliIo, PactmarkCliHost } from "./types.js";
import { compileAgentPackage } from "./compile.js";

type HostModule = Readonly<{ default?: unknown; host?: unknown }>;

function isHost(value: unknown): value is PactmarkCliHost {
  return typeof value === "object" && value !== null && "runtime" in value && "authority" in value;
}

export interface NodeCliEnvironmentOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly isTty?: boolean;
}

export function createNodeCliIo(options: NodeCliEnvironmentOptions = {}): CliIo {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? process.env.PACTMARK_CLI_CONFIG;
  return Object.freeze({
    isTty: options.isTty ?? process.stdout.isTTY,
    writeStdout: options.stdout ?? ((value: string) => process.stdout.write(value)),
    writeStderr: options.stderr ?? ((value: string) => process.stderr.write(value)),
    readTextFile: (path: string) => readFile(path, "utf8"),
    resolvePath: (path: string) => (isAbsolute(path) ? path : resolve(cwd, path)),
    compileAgentPackage: () => compileAgentPackage(cwd),
    probeReadiness: () => {
      const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
      const supported = (major === 22 && minor >= 14) || major === 24;
      return Promise.resolve([
        {
          schemaVersion: "1" as const,
          id: "host.node-version",
          status: supported ? ("pass" as const) : ("fail" as const),
          code: supported ? "KAF_CLI_NODE_SUPPORTED" : "KAF_CLI_NODE_UNSUPPORTED",
          safeMessage: supported
            ? "The Node.js release line is supported."
            : "The Node.js release line is not supported.",
          remediationSlug: "use-supported-node",
          evidence: { major, minor, patch },
        },
      ]);
    },
    async loadHost(): Promise<PactmarkCliHost | undefined> {
      if (configPath === undefined || configPath.length === 0) return undefined;
      const absolute = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
      const loaded = (await import(pathToFileURL(absolute).href)) as HostModule;
      const candidate = loaded.default ?? loaded.host;
      return isHost(candidate) ? candidate : undefined;
    },
  });
}
