import { describe, expect, test } from "vitest";

import baselines from "../../tooling/benchmarks/baselines.json" with { type: "json" };
import { nearestRankPercentile } from "../../tooling/benchmarks/packed-quickstart.mjs";
import { runProjectionBenchmark } from "../../tooling/benchmarks/projection.mjs";
import { runSlowConsumerBenchmark } from "../../tooling/benchmarks/slow-consumer.mjs";

describe("local performance regression budgets", () => {
  test("streams 10 MiB to a delayed consumer without buffering the full body", async () => {
    const result = await runSlowConsumerBenchmark();

    expect(result.totalBytes).toBe(10 * 1024 * 1024);
    expect(result.chunks).toBe(160);
    expect(result.maximumQueuedBytes).toBeLessThan(result.totalBytes);
    expect(result.maximumQueuedBytes).toBeLessThanOrEqual(
      baselines.slowConsumer.budget.maximumQueuedBytes,
    );
    expect(result.maximumRssDeltaBytes).toBeLessThanOrEqual(
      baselines.slowConsumer.budget.maximumRssDeltaBytes,
    );
    expect(result.elapsedMilliseconds).toBeLessThanOrEqual(
      baselines.slowConsumer.budget.maximumElapsedMilliseconds,
    );
  });

  test("reduces a representative 10,000-event run within the local budget", () => {
    const result = runProjectionBenchmark();

    expect(result.eventCount).toBe(10_000);
    expect(result.finalSequence).toBe(10_000);
    expect(result.finalStatus).toBe("planning");
    expect(result.elapsedMilliseconds).toBeLessThanOrEqual(
      baselines.projection.budget.maximumElapsedMilliseconds,
    );
    expect(result.rssDeltaBytes).toBeLessThanOrEqual(
      baselines.projection.budget.maximumRssDeltaBytes,
    );
  });

  test("keeps the packed quickstart observation reproducible and scoped", () => {
    const observation = baselines.packedQuickstart.observation;

    expect(observation.runs).toBeGreaterThanOrEqual(baselines.packedQuickstart.budget.minimumRuns);
    expect(observation.samplesMilliseconds).toHaveLength(observation.runs);
    expect(nearestRankPercentile(observation.samplesMilliseconds, 0.9)).toBe(
      observation.p90Milliseconds,
    );
    expect(observation.p90Milliseconds).toBeLessThanOrEqual(
      baselines.packedQuickstart.budget.maximumP90Milliseconds,
    );
    expect(
      Object.values(observation.tarballDigests).every((digest) =>
        /^sha256:[a-f0-9]{64}$/u.test(digest),
      ),
    ).toBe(true);
    expect(baselines.packedQuickstart.limitation).toContain(
      "not the initializer-to-first-run product SLO",
    );
  });
});
