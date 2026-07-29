# Releasing Ground

Ground separates ordinary source verification, unsigned preview packaging, and an
official tagged release.

## Unsigned preview packages

Run the **Package previews** workflow manually. It builds macOS, Windows, and Linux
artifacts with no publishing permission and keeps them as short-lived workflow
artifacts for 14 days. Its configured formats are macOS zip/DMG, Windows NSIS, and
Linux AppImage/DEB. Preview packages are useful for platform testing, but they are
unsigned, uncertified, and not an official Ground release.

Local equivalents are:

```bash
npm run dist:mac:unsigned
npm run dist:win
npm run dist:linux
```

Run only the command for the matching host platform. Ground includes `node-pty`, so
distributable packages must be built on the target operating system. After a
native package build, run:

```bash
npm run smoke:package:launch
npm run smoke:package:native
```

The macOS command clears ambient signing and notarization credentials and sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, making the local preview explicitly unsigned.
Use `npm run dist:mac` only in the credential-scoped official release workflow.

The first command boots the unpacked packaged app with an isolated temporary
profile, waits for the real main process, renderer document, and sandboxed preload
to report readiness, then quits. It does not use CDP, browser automation,
screenshots, or renderer input. The second repeats startup and exercises the
packaged PTY binding, Git status service, a fixed local stdio MCP handshake/tool
call, and descendant cleanup. Linux uses Xvfb in the hosted workflow.

## Official release prerequisites

Before pushing a release tag:

1. Update `CHANGELOG.md` and the version in `package.json` and `package-lock.json`.
2. Use Node.js 24.18.0 and npm 11.16.0, then run `npm run toolchain:check`,
   `npm ci`, `npm run verify`, and `npm audit --audit-level=high`. The audit
   includes Electron and packaging dependencies because those tools supply or
   transform bytes that ship in the desktop artifacts. `npm ci` fails closed on
   any dependency install script not covered by the reviewed, version-pinned
   `allowScripts` policy. `verify` also exercises that policy and the checked-in
   compatibility bridge for the bounded `brace-expansion` release used across
   Electron Builder's older and current `minimatch` consumers. The root
   postinstall explicitly invokes the locked Electron 43 runtime installer, then
   requires its matching Electron/Chromium license inventory; a clean install must
   exercise this path.
3. Review `THIRD_PARTY_NOTICES.md`; regenerate it with
   `npm run licenses:generate` when the production graph changes.
4. On every target host, build a native package and run
   `npm run smoke:package:launch` plus `npm run smoke:package:native`. Both checks
   require Ground's license, `THIRD_PARTY_NOTICES.md`, Electron's license, and
   Chromium's bundled third-party license inventory in the packaged resources.
   The native check must load the packaged `node-pty` binding and complete the
   fixed Git/MCP/process-cleanup probes.
5. Exercise install, launch, terminal, Git, stdio MCP, process shutdown, secure
   credential storage, and uninstall behavior on every target platform.
6. Configure a repository ruleset that protects release tags, and configure the
   `release` environment, its deployment branch/tag rules, and required reviewers.
   Both native packaging and draft publication are bound to that environment.
7. Configure these GitHub Actions secrets:
   `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
8. Enable private vulnerability reporting and confirm the security contact and
   supported-version table are current.

The release tag must exactly match the package version, for example `v0.1.0`.

## What the release workflow does

The tag workflow is release scaffolding, not evidence that a release has passed.
It refuses an unprotected tag, a tag whose commit is not on the default branch, or
a tag that does not exactly match `package.json`, then re-runs verification, the
high-severity locked-tree audit, and the production license inventory check.
If those gates pass, it:

- builds macOS, Windows, and Linux artifacts on their native hosted runners;
- refuses the macOS job when signing/notarization credentials are missing;
- boots each unpacked packaged app through a main/preload readiness handshake and
  smoke-tests its PTY, Git, fixed local MCP, and process-tree cleanup paths;
- creates GitHub/Sigstore build-provenance attestations;
- records the exact name/version inventory from each packaged `app.asar`;
- emits and verifies a CycloneDX release SBOM containing every package actually
  present in those archives (including packages omitted from npm's production
  lockfile projection), the exact Electron/Chromium/Node runtime versions, the
  native `node-pty` component, and SHA-256 identities for each distributable, then
  attests it;
- installs dependencies before signing and notarization credentials enter the
  macOS build-step environment;
- produces deterministic `SHA256SUMS.txt` entries for the distributables,
  packaged-component inventories, and SBOM; and
- creates a **draft prerelease** rather than publishing a final release.

A maintainer must inspect signatures, notarization, checksums, SBOM, install/launch
behavior, and release notes before publishing the draft. Windows and Linux
artifacts remain preview-quality until their signing and distribution policies are
documented. No official Ground artifact has yet completed this process.

The probes do not install or uninstall NSIS/DEB artifacts, execute the AppImage
itself, drive renderer controls, inspect accessibility, validate native approval
dialogs, certify credential stores/keychains, exercise arbitrary MCP servers, or
call live models/agent CLIs. Their local MCP auto-approval applies only to a fixed
in-memory fixture executed by Ground's own packaged runtime.

All third-party actions are pinned to reviewed full commit SHAs, checkout does not
persist credentials, and each job receives only its declared permissions. When a
Dependabot action update is accepted, resolve the official tag to its commit,
review the upstream change, and update both the SHA and trailing major-version
comment.

## Verification and rollback

Users can compare downloads with `SHA256SUMS.txt` and verify GitHub attestations
with:

```bash
gh attestation verify PATH_TO_ARTIFACT --repo OWNER/REPOSITORY
```

For a local packaged directory, generate and verify the same metadata with:

```bash
npm run package:inventory
npm run sbom:release
npm run sbom:verify
npm run checksums:release
```

Ground does not currently ship an automatic updater or signed update channel, so
rollback is manual: unpublish or mark the affected release, document the issue, and
direct users to the most recent unaffected signed release. Never replace a
published binary in place; issue a new version so checksums and provenance remain
stable.
