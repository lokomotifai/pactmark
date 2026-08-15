import { createLocalRuntime } from "@pactmark/agent";

import { catalogAgent } from "./agent.js";
import { recordsAgent, recordStore } from "./records-agent.js";

const runtime = createLocalRuntime({ agents: [catalogAgent, recordsAgent] });

const read = await runtime.run(catalogAgent, {
  goal: "Check availability of SKU P-100.",
  input: { sku: "P-100" },
});
const write = await runtime.run(recordsAgent, {
  goal: "Persist the greeting record.",
  input: { key: "greeting" },
});

console.log(
  JSON.stringify(
    {
      read: {
        status: read.status,
        output: read.output,
        eventTypes: read.events.map((event) => event.eventType),
        evidenceDigest: read.evidence?.evidenceDigest,
      },
      write: {
        status: write.status,
        output: write.output,
        eventTypes: write.events.map((event) => event.eventType),
        storedRecords: [...recordStore.entries()],
      },
    },
    null,
    2,
  ),
);
