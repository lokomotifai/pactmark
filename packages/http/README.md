# @pactmark/http

Portable Web-standard request handling for Pactmark. The adapter owns HTTP validation, security headers, idempotency-key validation, CORS/CSRF checks, Problem Details, SSE framing, health, readiness, and OpenAPI routing. Authentication, authorization, agent resolution, authority issuance, and persistence remain host/runtime responsibilities.

Production configuration requires explicit authentication and authorization callbacks. Anonymous mode is development-only.
