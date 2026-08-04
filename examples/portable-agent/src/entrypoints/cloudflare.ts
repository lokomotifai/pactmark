import { runPortableAgent } from "../agent.js";
import type { PortableRequest, PortableResult } from "../contract.js";
export function handleCloudflare(request: PortableRequest): Promise<PortableResult> {
  return Promise.resolve(runPortableAgent(request));
}
