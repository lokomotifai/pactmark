# Pactmark contributor agreements

> **Status: draft, pending legal review.** The agreements in this directory are
> not open for signature and have no legal effect. Do not enable or merge the CLA
> workflow until counsel approves the documents, all placeholders are replaced,
> and the project announces `<EFFECTIVE_DATE>`.

Pactmark remains licensed under Apache License 2.0. The proposed Contributor
License Agreement is additive to the existing Developer Certificate of Origin
1.1 sign-off; it does not replace DCO and does not change the project's license
today. Contributors retain copyright in their work and grant the licenses stated
in the applicable agreement.

The purpose of the proposed CLA is to make the rights attached to future
contributions explicit and preserve the option to relicense or dual-license in
the future. It is not a commitment to exercise that option. Any future licensing
change remains a material governance decision.

## Which agreement applies

- Use [`ICLA.md`](ICLA.md) when you personally own the contribution or otherwise
  have authority to license it.
- Contact `<CONTACT_EMAIL>` before contributing when an employer or another
  legal entity owns or controls the relevant rights. An authorized
  representative may need to complete [`CCLA.md`](CCLA.md) and maintain Schedule
  A.
- A Corporate CLA does not silently exempt a GitHub account. Until counsel and
  maintainers document a verified corporate-account workflow, each
  non-allowlisted GitHub contributor must also satisfy the individual CLA check.

## How individual signing is intended to work

After the draft is approved and becomes effective, the CLA Assistant check will
inspect the commit authors on a pull request. A contributor who has not signed
will receive a link to `ICLA.md` and an exact acceptance statement to post from
their GitHub account. The acceptance metadata will be written to
`lokomotifai/pactmark-cla-signatures` at
`signatures/version1/cla.json`.

The signature repository is separate from the Pactmark source repository. Its
access, retention, correction, and deletion rules must be approved before the
workflow is enabled. Do not manually create the JSON file; the CLA Assistant
action creates it when the first signature is recorded.

## Scope and effective date

The proposed agreements cover only Contributions merged on or after
`<EFFECTIVE_DATE>`. They make no claim over earlier contributions. A pull request
opened before that date but merged on or after it is within the proposed scope.

Existing DCO requirements continue for every commit. A passing CLA check does
not replace authorship review, DCO sign-off, third-party attribution, tests, or
maintainer acceptance.

## Questions and corrections

Questions about the agreements, signing authority, signature records, or a
mistaken identity association should be sent to `<CONTACT_EMAIL>`. Formal
notices use `<ENTITY_ADDRESS>` as described in the agreements.
