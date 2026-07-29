# Governance

Ground is maintainer-led while the architecture, security model, and public
contracts stabilize.

## Values

When tradeoffs conflict, the project favors:

1. user control and local data ownership;
2. provider and runtime portability;
3. an accurate, narrow security boundary;
4. readable, recoverable history over opaque provider lock-in; and
5. accessible, inspectable behavior over hidden automation.

## Roles

### Contributors

Anyone following the Code of Conduct may propose issues, documentation, tests, or
code. Contribution does not grant access to release credentials or private reports.

### Maintainers

Maintainers review and merge changes, triage reports, steward architecture, and
administer project infrastructure. Release and security access follows least
privilege.

Ground’s initial maintainer roster is:

- [@AlphaBetSoup789](https://github.com/AlphaBetSoup789) — repository owner,
  maintainer, release manager, and recipient for private security and conduct
  reports.

GitHub private vulnerability reporting is the confidential bootstrap channel
described in [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Ground begins as a single-maintainer
project and therefore cannot promise independent escalation or continuity if that
maintainer becomes unavailable. A second administrator and an independent conduct
recipient are required before Ground declares a stable release.

## Decision making

- Routine changes are decided through pull-request review.
- Changes to adapter contracts, permission policy, persisted formats, licensing,
  privacy, telemetry, release signing, or governance start with a public design
  issue and require maintainer approval.
- Security fixes may be developed privately and disclosed after a safe release is
  available.
- Maintainers explain rejected proposals in terms of project goals, risk, or
  maintenance cost.
- If consensus is unavailable, the responsible maintainer makes the decision and
  records the reasoning. Material decisions can be revisited with new evidence.

## Maintainer changes

Sustained high-quality contributions, respectful collaboration, reliable review,
and sound security judgment are the criteria for maintainership. Existing
maintainers invite a new maintainer by consensus and record the role and scope in
this file.

A maintainer may step down at any time. Access must be removed promptly when a
maintainer becomes inactive, steps down, or can no longer protect project assets.
At least two maintainers should hold recoverable administrative access before
Ground declares a stable release.

## Project assets

The source is MIT licensed. Signing identities, release credentials, package
registries, domains, social accounts, security reports, and infrastructure access
are administered for the project. They are not personal entitlements created by a
contribution.

Ground currently requires no contributor license agreement. Contributions are made
under the repository license as described in [CONTRIBUTING.md](CONTRIBUTING.md).
