import type { PortableSuccess } from "../contract.js";
export function verifyPortableResult(result: PortableSuccess): boolean {
  return (
    result.events.map(({ sequence }) => sequence).join(",") === "1,2,3,4" &&
    result.artifactDigest.startsWith("sha256:")
  );
}
