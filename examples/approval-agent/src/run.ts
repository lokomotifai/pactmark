import { ApprovalAgentHarness } from "./agent.js";
const harness = new ApprovalAgentHarness();
const request = harness.requestDecision(
  { target: "Team-Alerts", content: "Fixture release is ready for review." },
  new Date("2026-01-01T00:00:00.000Z"),
);
console.log(JSON.stringify(request.preview));
