import { defineAgent, defineTool } from "@pactmark/agent";
import { fromAISDK } from "@pactmark/ai-sdk";
import { z } from "zod";

import { model } from "./model.js";

export const lookup = defineTool({
  id: "catalog.lookup@1",
  description: "Read one item from the embedded catalog.",
  input: z.object({ sku: z.string().min(1) }).strict(),
  output: z.object({ sku: z.string(), name: z.string(), available: z.boolean() }).strict(),
  security: { requiredScopes: ["catalog:read"] },
  operation: {
    kind: "read",
    execute: ({ sku }) =>
      Promise.resolve({ sku, name: "Portable notebook", available: sku === "P-100" }),
  },
});

export const catalogAgent = defineAgent({
  id: "quickstart-catalog-agent",
  version: "0.1.0",
  input: z.object({ sku: z.string().min(1) }).strict(),
  instructions: "Check the catalog with the lookup tool, then answer with the output JSON.",
  model: fromAISDK(model()),
  tools: { lookup },
  output: z.object({ summary: z.string() }).strict(),
});
