---
"@pactmark/agent": patch
"@pactmark/cli": patch
"@pactmark/http": patch
"@pactmark/mcp": patch
"@pactmark/policy": patch
"@pactmark/runtime": patch
"@pactmark/store-postgres": minor
"create-pactmark": patch
---

Fail closed for implicit PostgreSQL tenant and purpose scope, bind tenant RLS
inside store transactions, and add durable opaque `SecretRef` metadata storage.

Enforce model, MCP server, and compensation kill switches at their execution
boundaries, and replace dead error-documentation links with the versioned public
error reference.
