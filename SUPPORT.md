# Support

Ground is a developer preview. There is no guaranteed response time, compatibility
window, migration support, or official binary distribution yet.

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

If Ground displays a recovery banner, report whether it restored the rotating
backup or opened a clean workspace, but do not upload the primary, `.bak`, or
`.unreadable-*` files. Preserve them locally until a private reporting path is
agreed.

## Provider troubleshooting

Ground connects directly to the configured endpoint or executable. A provider
failure may come from the endpoint, model capability, account, CLI installation, or
runtime configuration rather than Ground itself.

When a problem is provider-specific:

- confirm the endpoint or CLI works independently;
- record the exact provider/CLI version without sharing credentials;
- state whether streaming, tools, or session resume are involved; and
- check [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the current integration
  status.

Ground maintainers cannot provide support for provider accounts, billing, quotas,
model availability, or third-party CLI behavior.

Unsigned macOS, Windows, and Linux workflow artifacts are developer previews.
There is no automatic updater, compatibility guarantee, or supported downgrade
path. Release and rollback expectations are documented in
[docs/RELEASING.md](docs/RELEASING.md).
