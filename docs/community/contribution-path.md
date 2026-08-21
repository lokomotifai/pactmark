---
title: Contribution path
description: Make reviewable changes with DCO sign-off, applicable CLA acceptance, tests, and explicit release notes.
---

> Compatibility: Pactmark 0.2.x.

Read `CONTRIBUTING.md`, the product principles, applicable ADRs, and the relevant
package README. Create a focused change, preserve package boundaries, add deterministic
tests, run the smallest gate, and add a Changeset for user-visible behavior.

Commits require DCO sign-off. The additive CLA remains a draft pending legal
review; after its announced effective date, non-allowlisted commit authors must
also complete the CLA check. It does not apply retroactively. Security reports
do not use public issues. Maintainer review owns public API, persisted schemas,
policy/effect boundaries, dependencies, workflows, and release changes. A pull
request is not accepted because files exist; observable behavior must pass from
packed artifacts where relevant.
