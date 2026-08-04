import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts", "src/host.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
});
