import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";

const appDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stateDirectory = path.join(appDirectory, ".wrangler");
mkdirSync(path.join(stateDirectory, "config"), { recursive: true });
mkdirSync(path.join(stateDirectory, "logs"), { recursive: true });

const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const result = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2)], {
  cwd: appDirectory,
  stdio: "inherit",
  env: {
    ...process.env,
    XDG_CONFIG_HOME: path.join(stateDirectory, "config"),
    WRANGLER_LOG_PATH: path.join(stateDirectory, "logs", "wrangler.log"),
    WRANGLER_SEND_METRICS: "false",
  },
});

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
