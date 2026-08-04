import process from "node:process";
import { setInterval } from "node:timers";

const mode = process.argv[2];

if (mode === "stderr") {
  process.stderr.write("x".repeat(4_096));
} else if (mode === "malformed") {
  process.stdout.write("not-json\n");
}

setInterval(() => undefined, 1_000);
