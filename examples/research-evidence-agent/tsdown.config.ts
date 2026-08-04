import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/agent.ts", "src/run.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2023",
});
