# External repository settings status

Checked: `2026-08-04T08:15:17Z`

The public repository [`pactmark/pactmark`](https://github.com/pactmark/pactmark) exists under the owner-controlled `pactmark` organization. Authenticated inspection recorded `fatihguner` as an active organization admin, repository visibility `PUBLIC`, canonical HTTPS clone URL `https://github.com/pactmark/pactmark.git`, default branch `main`, and viewer permission `ADMIN`. The local checkout uses that exact URL as `origin`.

ChatGPT Codex Connector installation `151134458` is installed on `pactmark` and limited to the single `pactmark/pactmark` repository. Connector inspection reports admin, maintain, pull, push, and triage access for that repository. The GitHub CLI is authenticated as `fatihguner` using HTTPS with `repo`, `read:org`, and `workflow` scopes.

After explicit source-publication authorization, root commit `3234ae5e0d5e7855d67aa3010cd2a12f88e86d3d` (`chore: publish initial Pactmark repository`) pushed 733 reviewed public-source files to `main`. No tag, branch-protection rule, required-check rule, CODEOWNERS enforcement, private vulnerability reporting configuration, trusted publisher, release environment, GitHub Release, Pages deployment, npm publication, or live deployment has been created or claimed.

The push triggered GitHub Actions CI run [`30891174935`](https://github.com/pactmark/pactmark/actions/runs/30891174935) for the exact root commit. The Windows host failed during dependency installation because the docs prepare hook invoked the POSIX-only `node_modules/.bin/prettier` path; the other jobs were still running at the latest inspection. The platform-specific path was replaced locally with a Node-invoked package entrypoint and the same correction was applied proactively to packed-consumer pnpm/TypeScript calls. No passing remote-CI claim is recorded until a pushed rerun completes. Further configuration remains subject to the authorization checklist in PLAN.md.
