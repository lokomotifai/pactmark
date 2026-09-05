import { runPortableAgent } from "../agent.js";
import type { PortableResult } from "../contract.js";

/** A Node application boundary; a real server must supply its own auth and tenancy. */
export function handleNode(request: unknown): Promise<PortableResult> {
  return runPortableAgent(request);
}
