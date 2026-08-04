# @pactmark/node

Node.js HTTP bridge for portable `@pactmark/http` handlers. It propagates request abort, streams bodies without buffering, exposes only explicitly selected environment bindings, returns safe failures, and provides graceful server shutdown helpers. Durable state remains in injected stores; the container filesystem is not durable run state.
