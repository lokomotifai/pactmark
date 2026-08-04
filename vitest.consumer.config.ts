import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/consumer/**/*.test.ts"],
  },
});
