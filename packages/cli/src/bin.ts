#!/usr/bin/env node
import { runCli } from "./cli.js";
import { createNodeCliIo } from "./node.js";

const result = await runCli(process.argv.slice(2), createNodeCliIo());
process.exitCode = result.exitCode;
