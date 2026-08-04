import { runMinimalToolExample } from "./example.js";

const result = await runMinimalToolExample();
console.log(
  JSON.stringify({
    runId: result.runId,
    status: result.projection.status,
    eventTypes: result.events.map((event) => event.eventType),
    evidenceDigest: result.evidence?.evidenceDigest,
    productionReady: result.productionReadiness.ready,
  }),
);
