import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2023",
  deps: {
    neverBundle: [/^node:/],
  },
  minify: false,
});
