import { handleNode } from "./entrypoints/node.js";
const result = await handleNode({ sku: "P-100" });
console.log(JSON.stringify(result));
