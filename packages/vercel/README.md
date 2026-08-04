# @pactmark/vercel

Thin Next.js App Router/Vercel translation over `@pactmark/http`. Route params are never authority. The adapter propagates `request.signal`, reads host environment only at request time, and exposes `waitUntil` solely for non-critical flushes. It does not claim durable execution, background wake-up, isolated sandboxing, or enforced egress.
