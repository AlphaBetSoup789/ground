# brace-expansion CommonJS compatibility bridge

Ground's Electron packaging graph currently includes older `minimatch` releases
that expect `require("brace-expansion")` to return a function. The security-fixed
`brace-expansion` 5.0.8 release exposes that function as `expand` instead.

This build-only package preserves the old callable CommonJS shape while delegating
all parsing and expansion to the unmodified `brace-expansion` 5.0.8 implementation,
installed at the repository root under the `brace-expansion-modern` alias. It also
exposes the modern named properties for newer consumers. Remove this bridge when
Electron Builder's complete dependency graph accepts the modern export.
