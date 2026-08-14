# Pactmark support

Pactmark is community-maintained open-source software provided under the Apache
License 2.0, without warranty, a service-level agreement, or an entitlement to
individual support.

## Choose the right route

| Need                            | Route                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reproducible bug                | [Bug report](https://github.com/lokomotifai/pactmark/issues/new?template=bug.yml)                                         |
| Documentation problem           | [Documentation report](https://github.com/lokomotifai/pactmark/issues/new?template=documentation.yml)                     |
| Focused implementation question | [Support question](https://github.com/lokomotifai/pactmark/issues/new?template=question.yml)                              |
| Product or API proposal         | [Feature proposal](https://github.com/lokomotifai/pactmark/issues/new?template=feature.yml)                               |
| Security vulnerability          | [Private Vulnerability Reporting](https://github.com/lokomotifai/pactmark/security/advisories/new) — never a public issue |
| Conduct incident                | Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                                           |

Search existing issues and the [English and Turkish documentation](docs/index.md)
before opening a new report.

## What makes a useful support request

Include the exact Pactmark package and version, Node.js and package-manager
versions, host/runtime, the smallest reproduction, expected and observed
behavior, and sanitized logs or stable `KAF_*` error codes. Say whether the
problem involves replay, cancellation, concurrency, tenancy, grants, approval,
credentials, persistence, or external effects.

Replace provider calls with a deterministic fixture when possible. Never post
secrets, raw prompts containing private data, customer content, access tokens,
connection strings, or vulnerability details.

## Support boundary

Maintainers can help distinguish a Pactmark defect from application wiring, but
cannot operate or audit a user's deployment. Support does not cover custom
agent design, provider availability, third-party SDK behavior, cloud billing,
application credentials, production incident command, or security guarantees
for a host that has not been evaluated.

Issues may be closed when they lack enough information to reproduce, duplicate
an existing report, concern unsupported behavior, or turn into open-ended
consulting. A closure should state why and, when known, point to the next useful
route. Response times are best-effort.
