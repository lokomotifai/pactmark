import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Core's Zod-heavy declaration graph is emitted by tsc after this bundle.
  // rolldown-plugin-dts can reorder inferred schema members across identical
  // builds, which makes the checked public API report nondeterministic.
  dts: false,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2023",
  minify: false,
});
