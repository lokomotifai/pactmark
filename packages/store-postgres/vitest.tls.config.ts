import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["tests-tls/**/*.tls.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
