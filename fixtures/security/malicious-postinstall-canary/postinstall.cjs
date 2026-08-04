const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

writeFileSync(join(process.cwd(), ".pactmark-canary-ran"), "unsafe lifecycle script executed\n");
