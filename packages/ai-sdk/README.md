# @pactmark/ai-sdk

Pactmark's optional adapter for Vercel AI SDK 7. The `ambient_preview` constructor accepts a ready model only for an explicitly ephemeral local preview. It enforces finite Pactmark resource limits and never gives executable Pactmark tools to the AI SDK.

Production credential resolution remains host-owned and is not provided by this preview constructor.
