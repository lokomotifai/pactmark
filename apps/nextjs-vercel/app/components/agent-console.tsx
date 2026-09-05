"use client";

import { useEffect, useRef, useState } from "react";

import { EphemeralChallengeVault } from "../../src/challenge-vault";
import { toSafeText } from "../../src/safe-text";
import { TextPanel } from "./text-panel";

interface StreamEvent {
  readonly eventType?: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

function commandId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `kafcmd_${String(Date.now()).padStart(13, "0")}_${hex}`;
}

function workOrder(item: string) {
  return {
    schemaVersion: "1",
    agent: { id: "nextjs-vercel-agent", version: "0.1.0" },
    goal: "Approve and reserve the deterministic preview fixture item.",
    input: { item },
    context: { roleFamily: "operations", workflowId: "vercel-preview", riskClass: "high" },
    workMode: "assist",
    autonomyMode: "assist",
    decisionOwner: { mode: "requesting_principal" },
    purpose: { code: "service_delivery", registryVersion: "general@1" },
    dataClass: "public",
    retention: { mode: "session" },
    requestedCapabilities: ["fixture:reserve"],
    resourceScopeCeiling: [
      {
        kind: "tenant",
        value: "nextjs-vercel-preview",
        normalizationVersion: "pactmark.policy-normalization@1",
      },
    ],
    budget: { maxTurns: 4, maxModelCalls: 4, maxToolCalls: 1, maxActiveExecutionMs: 10_000 },
  };
}

async function readSse(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.ok || response.body === null)
    throw new TypeError(`KAF_UI_HTTP_${String(response.status)}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    buffer += item.value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data !== "") onEvent(JSON.parse(data) as StreamEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function AgentConsole() {
  const [item, setItem] = useState("notebook");
  const [status, setStatus] = useState("Idle — no durable run history is promised.");
  const [runId, setRunId] = useState<string>();
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);
  const [toolRequest, setToolRequest] = useState<unknown>();
  const [approvalPreview, setApprovalPreview] = useState<Readonly<Record<string, unknown>>>();
  const [artifact, setArtifact] = useState<unknown>();
  const [verification, setVerification] = useState<unknown>();
  const [evidence, setEvidence] = useState<unknown>();
  const [safeError, setSafeError] = useState<string>();
  const [challengeReady, setChallengeReady] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const challengeVaultRef = useRef<EphemeralChallengeVault | undefined>(undefined);
  if (challengeVaultRef.current === undefined)
    challengeVaultRef.current = new EphemeralChallengeVault();

  useEffect(
    () => () => {
      abortRef.current?.abort();
      challengeVaultRef.current?.clear();
    },
    [],
  );

  function observe(event: StreamEvent): void {
    setEvents((current) => [...current.slice(-49), event]);
    if (event.runId !== undefined) setRunId(event.runId);
    setStatus(event.eventType ?? "Event received");
    if (event.eventType?.includes("Tool") === true) setToolRequest(event.payload);
    if (event.eventType === "ApprovalRequested" && event.payload !== undefined) {
      const safePreview: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.payload)) {
        if (key !== "challengeProof") safePreview[key] = value;
      }
      setApprovalPreview(safePreview);
    }
    if (event.eventType?.includes("Artifact") === true) setArtifact(event.payload);
    if (event.eventType?.includes("Verification") === true) setVerification(event.payload);
    if (event.eventType?.includes("Evidence") === true) setEvidence(event.payload);
  }

  async function stream(url: string, init?: RequestInit): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSafeError(undefined);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
      await readSse(response, observe);
    } catch (error) {
      if (!controller.signal.aborted)
        setSafeError(toSafeText(error instanceof Error ? error.message : error, 500));
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
    }
  }

  function start(): void {
    setEvents([]);
    setRunId(undefined);
    setToolRequest(undefined);
    setApprovalPreview(undefined);
    setChallengeReady(false);
    challengeVaultRef.current?.clear();
    setArtifact(undefined);
    setVerification(undefined);
    setEvidence(undefined);
    setStatus("Starting deterministic preview…");
    void stream("/api/agent/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId() },
      body: JSON.stringify(workOrder(item)),
    });
  }

  function reconnect(): void {
    if (runId === undefined) return;
    const after = events.at(-1)?.sequence ?? 0;
    setStatus("Reconnecting from the last observed sequence…");
    void stream(`/api/agent/v1/runs/${encodeURIComponent(runId)}/events?after=${String(after)}`, {
      headers: { accept: "text/event-stream" },
    });
  }

  async function cancel(): Promise<void> {
    if (runId === undefined) return;
    abortRef.current?.abort();
    const response = await fetch(`/api/agent/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "idempotency-key": commandId() },
      body: JSON.stringify({ reason: "Cancelled by the preview user." }),
    });
    setStatus(
      response.ok ? "Cancellation requested." : `Cancellation failed (${String(response.status)}).`,
    );
  }

  async function requestChallenge(): Promise<void> {
    const decisionId =
      typeof approvalPreview?.["decisionId"] === "string"
        ? approvalPreview["decisionId"]
        : undefined;
    if (runId === undefined || decisionId === undefined) return;
    challengeVaultRef.current?.clear();
    setChallengeReady(false);
    try {
      const response = await fetch(
        `/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}/challenge`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", "idempotency-key": commandId() },
          body: "{}",
        },
      );
      const value = (await response.json()) as Readonly<Record<string, unknown>>;
      if (
        !response.ok ||
        typeof value["challengeProof"] !== "string" ||
        typeof value["expiresAt"] !== "string"
      )
        throw new TypeError("KAF_UI_CHALLENGE_INVALID");
      challengeVaultRef.current?.put(decisionId, {
        challengeProof: value["challengeProof"],
        expiresAt: value["expiresAt"],
      });
      setChallengeReady(true);
    } catch (error) {
      challengeVaultRef.current?.clear();
      setSafeError(toSafeText(error instanceof Error ? error.message : error, 500));
    }
  }

  async function decide(decision: "approve" | "reject"): Promise<void> {
    const decisionId =
      typeof approvalPreview?.["decisionId"] === "string"
        ? approvalPreview["decisionId"]
        : undefined;
    if (runId === undefined || decisionId === undefined) return;
    const challenge = challengeVaultRef.current?.consume(decisionId);
    setChallengeReady(false);
    if (challenge === undefined) {
      setSafeError("Decision challenge is missing or expired. Request a new challenge.");
      return;
    }
    try {
      const response = await fetch(
        `/api/agent/v1/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", "idempotency-key": commandId() },
          body: JSON.stringify({
            decision,
            decisionId,
            challengeProof: challenge.challengeProof,
            ...(decision === "reject" ? { reasonCode: "preview_user_rejected" } : {}),
          }),
        },
      );
      if (!response.ok) throw new TypeError(`KAF_UI_DECISION_${String(response.status)}`);
      const result = (await response.json()) as Readonly<Record<string, unknown>>;
      setStatus(`Decision submitted: ${decision}.`);
      if (decision === "approve" && result["automaticResume"] !== true) {
        const resume = await fetch(`/api/agent/v1/runs/${encodeURIComponent(runId)}/resume`, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", "idempotency-key": commandId() },
          body: "{}",
        });
        if (!resume.ok) throw new TypeError(`KAF_UI_RESUME_${String(resume.status)}`);
      }
      const after = events.at(-1)?.sequence ?? 0;
      await stream(
        `/api/agent/v1/runs/${encodeURIComponent(runId)}/events?after=${String(after)}`,
        { headers: { accept: "text/event-stream" } },
      );
      setApprovalPreview(undefined);
    } catch (error) {
      setSafeError(toSafeText(error instanceof Error ? error.message : error, 500));
    } finally {
      challengeVaultRef.current?.clear();
    }
  }

  return (
    <main>
      <div className="demo-banner" role="status">
        Ephemeral preview — process restart loses run history. This is not a durable production
        deployment.
      </div>
      <header className="hero">
        <p className="eyebrow">Pactmark reference host</p>
        <h1>Governed agent console</h1>
        <p>
          Inspect the exact event trail without giving the model authority over policy, credentials,
          or effects.
        </p>
      </header>
      <section className="controls" aria-labelledby="run-controls">
        <h2 id="run-controls">Run controls</h2>
        <label htmlFor="fixture-item">Fixture item</label>
        <input
          id="fixture-item"
          value={item}
          maxLength={80}
          onChange={(event) => {
            setItem(event.target.value);
          }}
        />
        <div className="button-row">
          <button type="button" onClick={start}>
            Start run
          </button>
          <button
            type="button"
            className="secondary"
            disabled={runId === undefined}
            onClick={reconnect}
          >
            Reconnect
          </button>
          <button
            type="button"
            className="danger"
            disabled={runId === undefined}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
        <p className="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
        {safeError === undefined ? null : (
          <p className="error" role="alert">
            {safeError}
          </p>
        )}
      </section>
      <div className="grid">
        <TextPanel title="Stream events" value={events} empty="No events yet." />
        <TextPanel
          title="Run state"
          value={runId === undefined ? undefined : { runId, status }}
          empty="No active run."
        />
        <TextPanel title="Tool request" value={toolRequest} empty="No tool request." />
        <section className="panel" aria-labelledby="approval-preview-title">
          <h2 id="approval-preview-title">Approval preview</h2>
          <pre tabIndex={0}>
            {approvalPreview === undefined
              ? "No approval requested."
              : toSafeText(approvalPreview["approvalDisplay"] ?? approvalPreview)}
          </pre>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={approvalPreview === undefined}
              onClick={() => void requestChallenge()}
            >
              Request one-use challenge
            </button>
            <button type="button" disabled={!challengeReady} onClick={() => void decide("approve")}>
              Approve exact preview
            </button>
            <button
              type="button"
              className="danger"
              disabled={!challengeReady}
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
          </div>
          <p className="hint">
            Challenge proof is held only in JavaScript memory and is never rendered or persisted.
          </p>
        </section>
        <TextPanel title="Artifact" value={artifact} empty="No artifact." />
        <TextPanel title="Verification" value={verification} empty="No verification result." />
        <TextPanel title="Evidence" value={evidence} empty="No evidence record." />
      </div>
    </main>
  );
}
