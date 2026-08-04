import { runPortableAgent } from "../agent.js";
import type { PortableRequest, PortableResult } from "../contract.js";
export function handleNode(request: PortableRequest): Promise<PortableResult> {
  return Promise.resolve(runPortableAgent(request));
}
