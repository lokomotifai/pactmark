import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/performance/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
