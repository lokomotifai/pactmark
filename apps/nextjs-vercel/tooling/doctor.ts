import { nextRuntime } from "../src/host";

const profile = process.argv[2];
if (profile !== "preview" && profile !== "production")
  throw new TypeError("KAF_DOCTOR_PROFILE_INVALID");
const report = nextRuntime.evaluateReadiness({
  profile: profile === "preview" ? "local" : "production",
});
console.log(JSON.stringify({ schemaVersion: "1", profile, report }));
if (profile === "production" && !report.ready) process.exitCode = 1;
