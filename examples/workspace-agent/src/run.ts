import { WorkspaceAgentHarness } from "./agent.js";
const agent = new WorkspaceAgentHarness();
console.log(agent.read("workspace/README.md"));
