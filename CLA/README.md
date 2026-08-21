# Pactmark contributor agreements

> **Status: Version 1.0 approved by counsel on August 21, 2026; effective
> September 15, 2026 at 00:00 UTC.** The agreements are not open for acceptance
> before that time. Do not merge or enable the CLA workflow before the effective
> date.

Pactmark remains licensed under Apache License 2.0. The Contributor
License Agreement is additive to the existing Developer Certificate of Origin
1.1 sign-off; it does not replace DCO and does not change the project's license
today. Contributors retain copyright in their work and grant the licenses stated
in the applicable agreement.

The purpose of the CLA is to make the rights attached to future
contributions explicit and preserve the option to relicense or dual-license in
the future. It is not a commitment to exercise that option. Any future licensing
change remains a material governance decision.

## Which agreement applies

- Use [`ICLA.md`](ICLA.md) when you personally own the contribution or otherwise
  have authority to license it.
- Contact `legal@lokomotif.ai` before contributing when an employer or another
  legal entity owns or controls the relevant rights. An authorized
  representative may need to complete [`CCLA.md`](CCLA.md) and maintain Schedule
  A.
- An accepted Corporate CLA is sufficient for employees listed on its current
  Schedule A; those employees do not also sign the ICLA. The Project Steward
  privately verifies the mapping from each listed employee to a GitHub account
  and then adds that account to the workflow allowlist through a reviewed change.
  The Project Steward may request a current certificate of incumbency, board
  resolution, or equivalent evidence before accepting corporate signing
  authority. Supporting authority records are not stored in the signature JSON.

## How individual signing is intended to work

On and after the effective date, the CLA Assistant check will inspect the commit
authors on a pull request. A contributor who has not signed will receive a link
to `ICLA.md` and an exact acceptance statement to post from their GitHub
account. The acceptance metadata will be written to
`lokomotifai/pactmark-cla-signatures` at
`signatures/version1/cla.json`.

The signature repository is separate from the Pactmark source repository. It is
private, has issues and wiki disabled, and grants write access only through a
dedicated repository secret. Do not manually create the JSON file; the CLA
Assistant action creates it when the first signature is recorded.

Before the workflow is enabled, `path-to-document` must point to the immutable
commit containing the counsel-approved ICLA, not to a moving branch. The
`signatures/version1/cla.json` path identifies that agreement generation. The
approved Version 1.0 text must not change in place; a material amendment requires
a new immutable document URL, a new signature path, and fresh acceptance.

## Signature record handling

Saparda Inc. is the data controller for CLA records. Fatih Güner is its
authorized privacy and agreement contact through `legal@lokomotif.ai`.

The record contains the metadata written by the pinned CLA Assistant action: the
contributor's GitHub login and numeric account identifier, the accepting comment
identifier and timestamp, the source repository identifier, and the pull-request
number. Saparda Inc. uses this data only to administer the agreement, verify
contribution eligibility, and establish, exercise, or defend legal rights.

Records are stored in the private `lokomotifai/pactmark-cla-signatures`
repository operated on GitHub infrastructure and may be processed outside the
contributor's country. Access is limited to authorized project administrators,
legal counsel when needed, and GitHub as the infrastructure provider. Records
are retained while needed to administer covered Contributions and related
releases, and afterward for applicable legal-claim periods. Necessity and access
are reviewed at least annually; data no longer required is deleted or
anonymized.

Requests for access, correction, deletion, or a mistaken account association go
to `legal@lokomotif.ai`. Corrections preserve the minimum audit trail needed to
show what changed and why. A record is not deleted while retention is necessary
to comply with law or establish, exercise, or defend legal rights.

## Scope and effective date

The agreements cover only Contributions merged on or after September 15, 2026
at 00:00 UTC. They make no claim over earlier contributions. A pull request
opened before that date but merged on or after it is within scope.

Existing DCO requirements continue for every commit. A passing CLA check does
not replace authorship review, DCO sign-off, third-party attribution, tests, or
maintainer acceptance.

## Questions and corrections

Questions about the agreements, signing authority, signature records, or a
mistaken identity association should be sent to `legal@lokomotif.ai`. Formal
notices use 8 The Green, Suite D, Dover, Delaware 19901, United States, as
described in the agreements.
