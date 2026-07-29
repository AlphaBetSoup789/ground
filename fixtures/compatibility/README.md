# Compatibility fixtures

These manifests are executable, version-pinned contract fixtures. They are public
review material for adapter changes; they are not evidence of a successful live
provider or CLI run.

The published set contains:

- `api/ai-sdk-v4-locked.json`: synthetic AI SDK `LanguageModelV4` input events
  normalized by each of Ground's four production API adapter boundaries;
- `cli/*.json`: synthetic runtime events normalized by the real Codex, Claude, or
  Gemini CLI parser; and
- `versions.json`: the exact package-lock and locally observed CLI versions to
  which the manifests are pinned.

Every manifest declares one of two provenance values:

- `synthetic-contract`: hand-authored input representing the reviewed adapter
  contract; or
- `documented-example`: an input transcribed from a cited public protocol example.

The credential-free published set also requires `liveCapture: false`. Do not
describe a synthetic or documented fixture as a live capture. A future redacted
live-capture collection needs a separate review policy and schema revision.

Run:

```sh
node scripts/check-compatibility-fixtures.mjs
npx vitest run src/main/providers/compatibility-fixtures.test.ts
```

The check compiles the published draft-2020-12 schema and validates every manifest
against it. It also rejects invalid provenance, missing suites, CLI-version drift
from the local observation record, and AI SDK version drift from `package.json` or
`package-lock.json`. The test then passes every case through the real parser or
adapter boundary and compares its canonical events.

Changing an input or expected output is a compatibility decision. Review the
upstream version, provenance, and semantic difference instead of updating an
expectation merely to make a failing test pass.
