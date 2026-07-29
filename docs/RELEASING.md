# Releasing Ground

Ground separates ordinary source verification, unsigned public preview packaging,
and a maintainer-published official tagged release.

## Unsigned preview packages

Run the **Package previews** workflow manually. It builds macOS, Windows, and Linux
artifacts with no publishing permission and keeps them as short-lived workflow
artifacts for 14 days. The exact native targets are macOS arm64, macOS x64,
Windows x64, and Linux x64. Configured formats are macOS ZIP/DMG, Windows NSIS, and
Linux AppImage/DEB. Preview packages are useful for platform testing, but they are
unsigned, macOS previews are unnotarized, and none is a supported or official
Ground release.

Making the source repository public or retaining a preview workflow artifact does
not publish a Ground release. The tagged workflow creates a draft prerelease; only
subsequent maintainer review and explicit publication can make it an official
release.

Local equivalents are:

```bash
npm run dist:mac:unsigned
npm run dist:win:unsigned
npm run dist:linux
```

Run only the command for the matching host platform. Ground includes `node-pty`, so
distributable packages must be built on the target operating system. After a
native package build, run:

```bash
npm run smoke:package:launch
npm run smoke:package:native
npm run smoke:package:distributable
```

For the Linux AppImage distributable smoke, set
`GROUND_PACKAGE_SMOKE_PREPARE_SANDBOX=sudo` on a trusted package-test host.
Extraction does not preserve the Chromium helper's root/setuid metadata; the
smoke hashes it against the already verified unpacked package, elevates only that
temporary regular file, and then requires root ownership plus mode `4755`. It
does not disable the Chromium sandbox.

The macOS command clears ambient signing and notarization credentials for both its
source build and packaging process and sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, making the local preview explicitly unsigned.
The official workflow runs its source build without those credentials, then exposes
them only to the macOS electron-builder packaging step.

The launch command boots the unpacked packaged app with an isolated temporary
profile, waits for the real main process, renderer document, and sandboxed preload
to report readiness, then quits. It does not use CDP, browser automation,
screenshots, or renderer input.

Native scope repeats startup and verifies:

- packaged app name, version, `app.isPackaged`, platform, and architecture;
- an OS-encrypted `SecretVault` set/reload/get/delete round trip, rejecting
  unavailable encryption and Linux `basic_text`;
- a real production native approval dialog that is automatically aborted after a
  bounded delay and must resolve as Cancel;
- the packaged PTY binding and Git status service;
- a fixed local stdio MCP handshake/tool call whose exact launch envelope is
  validated; and
- descendant process-tree cleanup.

Distributable scope extracts the exact macOS ZIP, silently installs the Windows
NSIS package into a temporary directory and verifies that its executable and
installation directory disappear after silent uninstall, or extracts the Linux
AppImage. It then runs native scope against that resulting app.
DMG and DEB installation are not exercised. The resulting
`ground-package-runtime-evidence-<platform>-<architecture>.json` binds fixed checks,
security evidence, package identity, installation source, and the distributable’s
name and SHA-256. This is bounded runtime evidence, not broad installer,
accessibility, provider, signing, notarization, or distribution certification.

Linux uses Xvfb in hosted workflows and requires D-Bus, `libsecret`, and an unlocked
Secret Service backend. The workflow creates an ephemeral GNOME-keyring session.
For local testing, install a Secret Service implementation and `libsecret`, launch
Ground inside that desktop/D-Bus session, and unlock the keyring; do not force
Electron’s insecure `basic_text` fallback.

For Linux runtime evidence, the workflows root-own and set mode `4755` only on the
same build’s unpacked `chrome-sandbox`. The AppImage smoke rejects a non-regular
extracted sandbox, verifies its SHA-256 matches that trusted unpacked copy, and
launches the extracted app with `CHROME_DEVEL_SANDBOX` pointing to the trusted
external file. It does not modify or independently trust the extracted payload.

## Official release prerequisites

Before pushing a release tag:

1. Update `CHANGELOG.md` and the version in `package.json` and `package-lock.json`.
2. Use Node.js 24.18.0 and npm 11.16.0, then run `npm run toolchain:check`,
   `npm ci`, `npm run verify`, `npm run test:e2e:renderer`, and
   `npm audit --audit-level=high`. The audit
   includes Electron and packaging dependencies because those tools supply or
   transform bytes that ship in the desktop artifacts. `npm ci` fails closed on
   any dependency install script not covered by the reviewed, version-pinned
   `allowScripts` policy. `verify` also exercises that policy and the checked-in
   compatibility bridge for the bounded `brace-expansion` release used across
   Electron Builder's older and current `minimatch` consumers. The root
   postinstall explicitly invokes the locked Electron 43 runtime installer, then
   requires its matching Electron/Chromium license inventory; a clean install must
   exercise this path.
   The renderer interaction suite uses the explicit browser-preview desktop mock;
   its passing result is not production-main or native package evidence.
3. Review `THIRD_PARTY_NOTICES.md`; regenerate it with
   `npm run licenses:generate` when the production graph changes.
4. On every target host, build a native package and run
   `npm run smoke:package:launch`, `npm run smoke:package:native`, and
   `npm run smoke:package:distributable`. The exact target set is macOS arm64,
   macOS x64, Windows x64, and Linux x64. The checks require Ground's license,
   `THIRD_PARTY_NOTICES.md`, Electron's license, and Chromium's bundled third-party
   license inventory in packaged resources. Native scope must load `node-pty`,
   complete credential/native-dialog/Git/MCP/process-cleanup probes, and
   distributable scope must bind its evidence to the exact ZIP, NSIS, or AppImage.
5. Aggregate the four runtime-evidence records beside their distributables and run
   `npm run package-evidence:verify -- PATH_TO_ARTIFACTS`. This requires the exact
   four target records and checks every recorded artifact hash.
6. Manually exercise renderer controls, keyboard and screen-reader behavior,
   arbitrary real keyring environments, DMG and DEB installation/removal, terminal,
   Git recovery, stdio MCP, process shutdown, and rollback on every claimed target.
   Fixed smoke evidence does not replace that release review.
7. Configure a repository ruleset that protects release tags, and configure the
   `release` environment, its deployment branch/tag rules, and required reviewers.
   Both native packaging and draft publication are bound to that environment.
8. Configure these GitHub Actions secrets:
   `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
   The checked-in workflow requires these for macOS signing/notarization; this
   document does not claim that the repository currently has them. Define a
   reviewed Windows/Linux signing policy before calling either platform supported.
9. Enable private vulnerability reporting and confirm the security contact and
   supported-version table are current.

The release tag must exactly match the package version, for example `v0.1.0`.

## What the release workflow does

The tag workflow is release scaffolding, not evidence that a release has passed.
It refuses an unprotected tag, a tag whose commit is not on the default branch, or
a tag that does not exactly match `package.json`, then re-runs verification, the
high-severity locked-tree audit, and the production license inventory check.
If those gates pass, it:

- builds macOS arm64/x64, Windows x64, and Linux x64 artifacts on
  architecture-checked native hosted runners;
- refuses the macOS job when signing/notarization credentials are missing;
- requires tagged Windows executables to remain explicitly unsigned until a
  Windows signing policy is defined;
- boots each unpacked packaged app through a main/preload readiness handshake and
  smoke-tests packaged identity, OS-encrypted credential storage, the fail-closed
  native approval dialog, PTY, Git, exact fixed local MCP, and process-tree cleanup;
- reruns native scope against each exact macOS ZIP, installed Windows NSIS package,
  or extracted Linux AppImage and emits an artifact-hash-bound runtime-evidence
  record;
- creates GitHub/Sigstore build-provenance attestations;
- records the exact name/version inventory from each target build’s unpacked
  `app.asar`;
- emits and verifies a CycloneDX release SBOM combining those same-build
  inventories (including packages omitted from npm's production lockfile
  projection), exact Electron/Chromium/Node runtime versions, the native
  `node-pty` component, and SHA-256 identities for each distributable, then attests
  it; runtime evidence independently binds the exercised ZIP/EXE/AppImage;
- installs dependencies and builds source before signing and notarization
  credentials enter only the macOS packaging-step environment;
- refuses draft publication unless exactly all four target runtime-evidence records
  validate against their distributables and, when present, the workflow commit;
- produces deterministic `SHA256SUMS.txt` entries for the distributables,
  packaged-component inventories, runtime-evidence records, and SBOM; and
- creates a **draft prerelease** rather than publishing a final release.

A maintainer must inspect signatures, notarization, checksums, SBOM, install/launch
behavior, and release notes before publishing the draft. Windows and Linux
artifacts remain preview-quality until their signing and distribution policies are
documented. No official Ground artifact has yet completed this process.

The macOS job verifies the built app and the ZIP-extracted app with `codesign`,
Gatekeeper, bundle/team identity, and stapled notarization checks. It runs
`hdiutil verify` on the DMG, but does not mount the DMG or independently re-run
those checks against its contained app; that remains a maintainer release-review
step.

The probes temporarily install and uninstall the exact NSIS package and execute the
AppImage only for extraction before launching its extracted app. They do not
install DMG/DEB artifacts, drive renderer controls, inspect accessibility, test
arbitrary installer modes or keyring configurations, exercise arbitrary MCP
servers, or call live models/agent CLIs. The native dialog is automatically aborted
to prove only its fail-closed Cancel result; it does not certify human review,
focus, assistive technology, or every OS dialog behavior. The credential round trip
proves only the configured runner’s secure-storage session. Local MCP auto-approval
applies only to a fixed in-memory fixture executed by Ground's own packaged
runtime.

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

For local package output, use the metadata scripts below. Runtime-evidence
verification requires one aggregated directory containing all four native targets;
one host cannot satisfy it alone.

```bash
npm run package:inventory
npm run package-evidence:verify -- PATH_TO_AGGREGATED_ARTIFACTS
npm run sbom:release
npm run sbom:verify
npm run checksums:release
```

Ground does not currently ship an automatic updater or signed update channel, so
rollback is manual: unpublish or mark the affected release, document the issue, and
direct users to the most recent unaffected signed release if one exists. If none
exists, withdraw the affected artifacts and state explicitly that no supported
rollback build is available. Never replace a published binary in place; issue a new
version so checksums and provenance remain stable.
