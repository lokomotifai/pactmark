import {
  ArtifactSchema,
  EvidenceRecordSchema,
  RunEventSchema,
  RunProjectionSchema,
  RuntimeReadinessProfileSchema,
  RuntimeReadinessReportSchema,
  TerminalRunStatusSchema,
  createRunProjection,
  digestBytes,
  digestCanonicalJson,
  rebuildRunProjection,
  type JsonValue,
  parseJsonStrict,
} from "@pactmark/core";
import {
  exportEvidenceJson,
  exportEvidenceMarkdown,
  verifyEvidenceDigest,
} from "@pactmark/evidence";

import {
  parseArguments,
  requirePositional,
  stringOption,
  type ParsedArguments,
} from "./arguments.js";
import { CliError, toCliPublicError } from "./error.js";
import { helpFor, VERSION } from "./help.js";
import { safeCanonicalJson, safeMultiline, visibleText } from "./render.js";
import type {
  CliIo,
  CliOperationName,
  CliOperationRequest,
  CliRunResult,
  PactmarkCliHost,
} from "./types.js";
import { CliHostProbeSchema, CliOperationResultSchema } from "./types.js";

const KNOWN_OPTIONS = new Set([
  "json",
  "debug",
  "help",
  "version",
  "production",
  "input",
  "format",
  "profile",
  "after",
  "resolution",
  "request",
]);

function assertKnownOptions(parsed: ParsedArguments): void {
  const unknown = Object.keys(parsed.options).find((name) => !KNOWN_OPTIONS.has(name));
  if (unknown !== undefined)
    throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: unknown } });
}

async function host(io: CliIo): Promise<PactmarkCliHost> {
  const configured = await io.loadHost();
  if (configured === undefined) throw new CliError("KAF_CLI_HOST_NOT_CONFIGURED");
  return configured;
}

async function inputValue(io: CliIo, source: string): Promise<JsonValue> {
  const trimmed = source.trimStart();
  try {
    const text =
      trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')
        ? source
        : await io.readTextFile(io.resolvePath(source));
    return parseJsonStrict(text);
  } catch {
    throw new CliError("KAF_CLI_IO_FAILURE", { details: { source: "local-input" } });
  }
}

function operationName(command: string, subcommand?: string): CliOperationName {
  if (command === "audit") return "audit.verify";
  if (command === "policy") return "policy.explain";
  if (command === "effects")
    return subcommand === "reconcile" ? "effects.reconcile" : "effects.compensate";
  return command as CliOperationName;
}

async function operate(
  configured: PactmarkCliHost,
  request: CliOperationRequest,
): Promise<unknown> {
  if (configured.operate === undefined) throw new CliError("KAF_CLI_COMMAND_UNSUPPORTED");
  return CliOperationResultSchema.parse(await configured.operate(request));
}

function writeResult(io: CliIo, value: unknown, json: boolean): void {
  if (json) {
    io.writeStdout(`${safeCanonicalJson(value)}\n`);
    return;
  }
  if (typeof value === "object" && value !== null && "summary" in value) {
    io.writeStdout(`${visibleText(String(value.summary))}\n`);
    return;
  }
  io.writeStdout(`${safeMultiline(safeCanonicalJson(value))}\n`);
}

async function commandDoctor(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const requested =
    parsed.options.production === true
      ? "production"
      : (stringOption(parsed, "profile") ?? "local");
  const profile = RuntimeReadinessProfileSchema.safeParse(requested);
  if (!profile.success)
    throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: "profile" } });
  const report = RuntimeReadinessReportSchema.parse(
    configured.runtime.evaluateReadiness({ profile: profile.data }),
  );
  const rawProbes = [
    ...(io.probeReadiness === undefined ? [] : await io.probeReadiness(profile.data)),
    ...(configured.probeReadiness === undefined
      ? []
      : await configured.probeReadiness({ profile: profile.data })),
  ];
  const hostProbes = rawProbes.map((probe) => CliHostProbeSchema.parse(probe));
  if (new Set(hostProbes.map((probe) => probe.id)).size !== hostProbes.length)
    throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { reason: "duplicate_probe_id" } });
  const ready = report.ready && hostProbes.every((probe) => probe.status !== "fail");
  if (parsed.options.json === true) {
    writeResult(io, { schemaVersion: "1", command: "doctor", ready, report, hostProbes }, true);
    return;
  }
  io.writeStdout(`Pactmark readiness: ${ready ? "ready" : "not ready"} (${report.profile})\n`);
  for (const check of report.checks) {
    io.writeStdout(
      `${check.status.toUpperCase()} ${visibleText(check.code)}: ${visibleText(check.safeMessage)} [${visibleText(check.remediationSlug)}]\n`,
    );
  }
  for (const probe of hostProbes) {
    io.writeStdout(
      `${probe.status.toUpperCase()} ${visibleText(probe.code)}: ${visibleText(probe.safeMessage)} [${visibleText(probe.remediationSlug)}]\n`,
    );
  }
}

async function commandReplay(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const runId = requirePositional(parsed, 0, "runId");
  const stored = RunProjectionSchema.parse(
    await configured.runtime.getRun(configured.authority, runId),
  );
  if (!TerminalRunStatusSchema.safeParse(stored.status).success)
    throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
      details: { reason: "run_not_terminal" },
    });
  const events = [];
  for await (const value of configured.runtime.events(configured.authority, runId))
    events.push(RunEventSchema.parse(value));
  const accepted = events[0];
  if (accepted?.eventType !== "RunAccepted")
    throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
      details: { reason: "first_event_not_run_accepted" },
    });
  if (
    accepted.runId !== stored.runId ||
    accepted.tenantId !== stored.tenantId ||
    accepted.payload.workOrderId !== stored.workOrderId ||
    accepted.payload.workOrderBindingDigest !== stored.workOrderBindingDigest ||
    accepted.executionDefinitionDigest !== stored.executionDefinitionDigest ||
    accepted.dataClass !== stored.dataClass ||
    accepted.correlationId !== stored.correlationId
  )
    throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
      details: { reason: "run_identity_binding" },
    });
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (current === undefined || current.sequence !== index + 1)
      throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
        details: { reason: "event_sequence" },
      });
    const previous = events[index - 1];
    if (index === 0 && current.prevHash !== undefined)
      throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
        details: { reason: "event_hash_chain" },
      });
    if (current.prevHash !== undefined && previous !== undefined) {
      if (current.prevHash !== digestCanonicalJson(previous))
        throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
          details: { reason: "event_hash_chain" },
        });
    }
  }
  const initial = createRunProjection({
    schemaVersion: "1",
    runId: stored.runId,
    tenantId: stored.tenantId,
    workOrderId: stored.workOrderId,
    workOrderBindingDigest: stored.workOrderBindingDigest,
    executionDefinition: stored.executionDefinition,
    executionDefinitionDigest: stored.executionDefinitionDigest,
    status: "created",
    createdAt: stored.createdAt,
    updatedAt: stored.createdAt,
    dataClass: stored.dataClass,
    correlationId: stored.correlationId,
  });
  const replayed = rebuildRunProjection(initial, events);
  const storedDigest = digestCanonicalJson(stored);
  const replayedDigest = digestCanonicalJson(replayed);
  if (storedDigest !== replayedDigest)
    throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
      details: { reason: "projection_digest" },
    });
  const artifacts = [];
  for (const artifactId of replayed.artifactIds) {
    const found = await configured.readArtifact?.(artifactId);
    if (found === undefined)
      throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
        details: { reason: "artifact_missing" },
      });
    const artifact = ArtifactSchema.parse(found.artifact);
    const { artifactDigest, ...material } = artifact;
    const valid =
      artifact.artifactId === artifactId &&
      artifact.tenantId === stored.tenantId &&
      artifact.producingRunId === runId &&
      artifact.byteSize === found.content.byteLength &&
      artifact.contentDigest === digestBytes(found.content) &&
      artifactDigest === digestCanonicalJson(material);
    if (!valid)
      throw new CliError("KAF_CLI_REPLAY_INTEGRITY_FAILED", {
        details: { reason: "artifact_digest" },
      });
    artifacts.push({
      artifactId,
      artifactDigest,
      contentDigest: artifact.contentDigest,
      valid: true,
    });
  }
  writeResult(
    io,
    {
      schemaVersion: "1",
      command: "replay",
      mode: "read_only",
      valid: true,
      runId,
      eventCount: events.length,
      projection: { storedDigest, replayedDigest, matches: true },
      eventChain: {
        declaredLinks: events.filter((value) => value.prevHash !== undefined).length,
        status:
          events.length <= 1 || events.every((value) => value.prevHash === undefined)
            ? "not_present"
            : events.slice(1).every((value) => value.prevHash !== undefined)
              ? "verified"
              : "partial",
      },
      artifacts,
      summary: `Read-only replay integrity verified for ${runId}.`,
    },
    parsed.options.json === true,
  );
}

async function commandInspect(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const runId = requirePositional(parsed, 0, "runId");
  const projection = RunProjectionSchema.parse(
    await configured.runtime.getRun(configured.authority, runId),
  );
  writeResult(
    io,
    { schemaVersion: "1", command: "inspect", run: projection },
    parsed.options.json === true,
  );
}

async function commandEvents(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const runId = requirePositional(parsed, 0, "runId");
  const afterText = stringOption(parsed, "after");
  const after = afterText === undefined ? undefined : Number(afterText);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
    throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: "after" } });
  const events = [];
  for await (const eventValue of configured.runtime.events(
    configured.authority,
    runId,
    after === undefined ? {} : { afterSequence: after },
  )) {
    events.push(RunEventSchema.parse(eventValue));
  }
  writeResult(
    io,
    { schemaVersion: "1", command: "events", runId, events },
    parsed.options.json === true,
  );
}

async function commandEvidence(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const subcommand = requirePositional(parsed, 0, "evidence subcommand");
  if (subcommand === "export") {
    const runId = requirePositional(parsed, 1, "runId");
    if (configured.getEvidence === undefined) throw new CliError("KAF_CLI_COMMAND_UNSUPPORTED");
    const record = await configured.getEvidence(runId);
    if (record === undefined) throw new CliError("KAF_CLI_RESOURCE_NOT_FOUND");
    const format = stringOption(parsed, "format") ?? "json";
    if (format !== "json" && format !== "md")
      throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { option: "format" } });
    const exported =
      format === "json" ? exportEvidenceJson(record) : exportEvidenceMarkdown(record);
    io.writeStdout(
      io.isTty ? `${safeMultiline(exported)}${exported.endsWith("\n") ? "" : "\n"}` : exported,
    );
    return;
  }
  if (subcommand === "verify") {
    const path = requirePositional(parsed, 1, "path");
    let record;
    try {
      record = EvidenceRecordSchema.parse(
        parseJsonStrict(await io.readTextFile(io.resolvePath(path))),
      );
    } catch {
      throw new CliError("KAF_CLI_EVIDENCE_INVALID");
    }
    if (!verifyEvidenceDigest(record)) throw new CliError("KAF_CLI_EVIDENCE_INVALID");
    writeResult(
      io,
      {
        schemaVersion: "1",
        command: "evidence.verify",
        valid: true,
        evidenceDigest: record.evidenceDigest,
      },
      parsed.options.json === true,
    );
    return;
  }
  throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { subcommand } });
}

async function commandMigrate(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const action = requirePositional(parsed, 0, "migration action");
  if (configured.migrationManager === undefined) throw new CliError("KAF_CLI_COMMAND_UNSUPPORTED");
  if (action === "status") {
    const status = await configured.migrationManager.status();
    writeResult(
      io,
      { schemaVersion: "1", command: "migrate.status", ...status },
      parsed.options.json === true,
    );
    return;
  }
  if (action === "up") {
    await configured.migrationManager.migrate();
    writeResult(
      io,
      {
        schemaVersion: "1",
        command: "migrate.up",
        status: "completed",
        summary: "Migrations completed.",
      },
      parsed.options.json === true,
    );
    return;
  }
  throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { action } });
}

async function commandOperation(
  io: CliIo,
  parsed: ParsedArguments,
  configured: PactmarkCliHost,
): Promise<void> {
  const command = parsed.command ?? "";
  let subcommand: string | undefined;
  let runId: string | undefined;
  let effectId: string | undefined;
  let input: JsonValue | undefined;
  if (command === "run") {
    requirePositional(parsed, 0, "agent");
    const source = stringOption(parsed, "input");
    if (source === undefined)
      throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { missing: "input" } });
    input = await inputValue(io, source);
  } else if (command === "audit") {
    subcommand = requirePositional(parsed, 0, "audit subcommand");
    if (subcommand !== "verify") throw new CliError("KAF_CLI_ARGUMENT_INVALID");
    runId = requirePositional(parsed, 1, "runId");
  } else if (command === "policy") {
    subcommand = requirePositional(parsed, 0, "policy subcommand");
    if (subcommand !== "explain") throw new CliError("KAF_CLI_ARGUMENT_INVALID");
    requirePositional(parsed, 1, "fixture");
  } else if (command === "effects") {
    subcommand = requirePositional(parsed, 0, "effects subcommand");
    if (subcommand !== "reconcile" && subcommand !== "compensate")
      throw new CliError("KAF_CLI_ARGUMENT_INVALID");
    runId = requirePositional(parsed, 1, "runId");
    effectId = requirePositional(parsed, 2, "effectId");
    const option = subcommand === "reconcile" ? "resolution" : "request";
    const source = stringOption(parsed, option);
    if (source === undefined)
      throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { missing: option } });
    input = await inputValue(io, source);
  }
  const request: CliOperationRequest = {
    name: operationName(command, subcommand),
    arguments: parsed.positionals,
    ...(input === undefined ? {} : { input }),
    ...(runId === undefined ? {} : { runId }),
    ...(effectId === undefined ? {} : { effectId }),
  };
  writeResult(io, await operate(configured, request), parsed.options.json === true);
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<CliRunResult> {
  let parsed: ParsedArguments | undefined;
  try {
    parsed = parseArguments(argv);
    assertKnownOptions(parsed);
    if (parsed.options.version === true) {
      io.writeStdout(`${VERSION}\n`);
      return { exitCode: 0 };
    }
    if (parsed.command === undefined || parsed.options.help === true) {
      io.writeStdout(`${helpFor(parsed.command)}\n`);
      return { exitCode: 0 };
    }
    const known = new Set([
      "dev",
      "compile",
      "run",
      "inspect",
      "events",
      "replay",
      "doctor",
      "test",
      "eval",
      "evidence",
      "audit",
      "migrate",
      "policy",
      "effects",
    ]);
    if (!known.has(parsed.command))
      throw new CliError("KAF_CLI_ARGUMENT_INVALID", { details: { command: parsed.command } });
    if (parsed.command === "compile") {
      if (io.compileAgentPackage === undefined) throw new CliError("KAF_CLI_COMMAND_UNSUPPORTED");
      writeResult(io, await io.compileAgentPackage(), parsed.options.json === true);
      return { exitCode: 0 };
    }
    const configured = await host(io);
    if (parsed.command === "doctor") await commandDoctor(io, parsed, configured);
    else if (parsed.command === "inspect") await commandInspect(io, parsed, configured);
    else if (parsed.command === "events") await commandEvents(io, parsed, configured);
    else if (parsed.command === "evidence") await commandEvidence(io, parsed, configured);
    else if (parsed.command === "migrate") await commandMigrate(io, parsed, configured);
    else if (parsed.command === "replay") await commandReplay(io, parsed, configured);
    else await commandOperation(io, parsed, configured);
    return { exitCode: 0 };
  } catch (error) {
    const publicError = toCliPublicError(error, parsed?.options.debug === true);
    if (parsed?.options.json === true) io.writeStderr(`${safeCanonicalJson(publicError)}\n`);
    else {
      io.writeStderr(`${visibleText(publicError.code)}: ${visibleText(publicError.message)}\n`);
      io.writeStderr(`Remediation: ${visibleText(publicError.remediation)}\n`);
      io.writeStderr(`Docs: ${visibleText(publicError.docsUrl)}\n`);
    }
    return { exitCode: 1 };
  }
}
