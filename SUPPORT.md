# Support

Ground is a public alpha. There is no guaranteed response time, compatibility
window, migration support beyond the migrations checked into the current source,
or supported binary distribution yet.

## Where to ask

- Use GitHub Discussions for setup questions and design ideas if Discussions are
  enabled on the published repository.
- Use the checked-in bug or feature issue form for a reproducible, non-sensitive
  report.
- Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities. Never
  put a suspected vulnerability in a public issue or discussion.
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for private conduct reporting.

## Before opening a bug

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Then include:

- Ground version or commit;
- operating system and architecture;
- source, unsigned-preview, or release install method and package type;
- provider protocol or CLI name and version;
- Ask or Agent mode;
- whether a fresh task/provider reproduces the issue;
- the smallest safe reproduction; and
- redacted error text.

Do not attach API keys, private source, prompts, transcripts, absolute local paths,
state files, CLI configuration, environment dumps, or raw diagnostic archives.
Replace private values with descriptive markers and verify the redaction before
submitting.

Task bundles and Markdown transcripts are not support bundles and are not
guaranteed to be secret-free. They can contain prompts, file contents, tool results,
and command output even though Ground removes credentials, authority, and
secret-shaped structured fields.

If Ground displays a recovery banner, report whether it restored a retained
generation, opened a clean workspace, or found credentials that need re-entry, but
do not upload the primary, `.bak*`, vault, Git recovery, or `.unreadable-*` files.
Preserve them locally until a private reporting path is agreed.

## Provider troubleshooting

Ground connects directly to the configured endpoint or executable. A provider
failure may come from the endpoint, model capability, account, CLI installation, or
runtime configuration rather than Ground itself.

When a problem is provider-specific:

- confirm the endpoint or CLI works independently;
- confirm the exact saved provider has passed **Test**; remember that a CLI Test
  validates configuration but does not perform an authenticated agent turn;
- record the exact provider/CLI version without sharing credentials;
- state whether streaming, tools, or session resume are involved; and
- check [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the current integration
  status.

Ground maintainers cannot provide support for provider accounts, billing, quotas,
model availability, or third-party CLI behavior.

If the Git panel says Git is unavailable, use **Choose Git executable** and select
a direct Git 2.23+ binary outside every configured workspace. Do not post the
resulting canonical path or fingerprint publicly; report only the Git version and
operating system unless a private maintainer asks for more.

On Linux, saving credentials requires `libsecret`, a working Secret Service
implementation, and an unlocked keyring in Ground’s D-Bus/desktop session. Ground
intentionally refuses Electron’s unencrypted `basic_text` fallback. If Test reports
that the credential vault is unavailable, repair or unlock the system keyring and
restart Ground; do not work around it by forcing plaintext storage.

Unsigned macOS, Windows, and Linux workflow artifacts are public-alpha previews.
There is no automatic updater, compatibility guarantee, or supported downgrade
path. Release and rollback expectations are documented in
[docs/RELEASING.md](docs/RELEASING.md).
