# Compatibility fixtures

These manifests are executable, version-pinned contract fixtures. They are public
review material for adapter changes; they are not evidence of a successful live
provider or CLI run.

The published set contains:

- `api/ai-sdk-v4-locked.json`: synthetic AI SDK `LanguageModelV4` input events
  normalized by each of Ground's four production API adapter boundaries;
- `cli/*.json`: synthetic or documented runtime events normalized by the real
  Codex, Claude, Gemini, or Antigravity CLI parser; and
- `versions.json`: the exact package-lock and reviewed CLI versions to which the
  manifests are pinned.

Every manifest declares one of two provenance values:

- `synthetic-contract`: hand-authored input representing the reviewed adapter
  contract; or
- `documented-example`: an input transcribed or structurally adapted from a cited
  public protocol example, with any adaptation disclosed in `provenanceNote`.

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

A separate credential-free integration test starts a deterministic loopback SSE
server and drives a real `POST /v1/chat/completions` through Ground’s production
OpenAI-compatible AI SDK adapter. It covers the local HTTP wire path, system/user
messages, tools, streaming, and normalization, but it is not part of this
version-pinned manifest set and does not certify a real OpenAI, Ollama, LM Studio,
or other deployment.
