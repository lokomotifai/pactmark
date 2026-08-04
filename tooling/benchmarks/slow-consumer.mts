import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

export interface SlowConsumerBenchmarkResult {
  readonly schemaVersion: "1";
  readonly benchmark: "slow-consumer-stream";
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly chunks: number;
  readonly maximumQueuedBytes: number;
  readonly maximumRssDeltaBytes: number;
  readonly elapsedMilliseconds: number;
  readonly method: string;
}

export async function runSlowConsumerBenchmark(
  options: Readonly<{ totalBytes?: number; chunkBytes?: number }> = {},
): Promise<SlowConsumerBenchmarkResult> {
  const totalBytes = options.totalBytes ?? 10 * 1024 * 1024;
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
    throw new TypeError("KAF_BENCH_STREAM_SIZE_INVALID");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > totalBytes)
    throw new TypeError("KAF_BENCH_STREAM_CHUNK_INVALID");

  let producedBytes = 0;
  let consumedBytes = 0;
  let maximumQueuedBytes = 0;
  let chunks = 0;
  const rssBefore = process.memoryUsage().rss;
  let maximumRss = rssBefore;
  const started = performance.now();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (producedBytes >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - producedBytes);
        controller.enqueue(new Uint8Array(size));
        producedBytes += size;
        chunks += 1;
        maximumQueuedBytes = Math.max(maximumQueuedBytes, producedBytes - consumedBytes);
      },
    },
    { highWaterMark: chunkBytes, size: (chunk) => chunk.byteLength },
  );

  const reader = stream.getReader();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    await setImmediate();
    consumedBytes += item.value.byteLength;
    maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
  }
  const elapsedMilliseconds = performance.now() - started;
  if (producedBytes !== totalBytes || consumedBytes !== totalBytes)
    throw new Error("KAF_BENCH_STREAM_INCOMPLETE");
  return Object.freeze({
    schemaVersion: "1",
    benchmark: "slow-consumer-stream",
    totalBytes,
    chunkBytes,
    chunks,
    maximumQueuedBytes,
    maximumRssDeltaBytes: Math.max(0, maximumRss - rssBefore),
    elapsedMilliseconds,
    method:
      "WHATWG ReadableStream pull source; byte-sized highWaterMark; one setImmediate delay per consumed chunk; RSS sampled after each delayed read",
  });
}
