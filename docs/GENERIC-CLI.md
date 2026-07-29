# Generic CLI bridge

Ground's Generic CLI connection is the smallest no-rebuild path from the desktop
workspace to another model or agent. If a program can accept one prompt and write
plain text or newline-delimited JSON to standard output, it can run as a Ground
runtime.

Use this path for a local script, an internal model gateway, a provider SDK wrapper,
or an agent executable that does not yet have a first-class adapter. The child
process—not Ground—owns its internal tools, network requests, authentication, and
permissions.

## Configure the connection

In **Providers & settings**, add a CLI and choose **Generic CLI**.

- **Executable** is a command name resolved from Ground's reviewed executable
  search path, or an absolute executable path. **Choose executable…** opens a
  native picker that validates a direct executable or reviewed Windows Node shim
  without running it; candidates inside configured workspaces are rejected.
- **Arguments** contains exactly one argument per line. Ground passes an argv array
  directly and never joins these values into a shell command.
- `{prompt}`, `{model}`, and `{cwd}` are replaced as data. Generic runtimes do not
  support `{sessionId}` because Ground starts a new generic process for every turn.
- **Prompt transport** sends the prompt through standard input or through the
  `{prompt}` argument token.
- **Output parser** accepts plain streamed text or the bounded JSON Lines shapes
  below.

If prompt transport is **Standard input**, the executable should read stdin through
EOF and the argument template must not contain `{prompt}`. This prevents accidental
duplicate delivery and keeps the prompt out of process listings. If transport is
**Argument token**, Ground replaces every `{prompt}` occurrence; when
the template has none, it appends the prompt as the final argument. Prefer one
dedicated token so the runtime contract remains obvious. Argument prompts are
omitted from Ground's native launch dialog but bound by byte length and SHA-256
identity.

The child runs with the selected workspace as its canonical working directory.
Ground shows a native confirmation for the exact executable, arguments, workspace,
parser, prompt transport, environment-key set, and launch identity before it runs.

Save the profile, then run **Test** on that exact saved revision. The Generic CLI
test proves that Ground can resolve the executable and construct the bounded launch
shape; it deliberately does not start the process, authenticate it, or make a model
request. Main will not start a task until that configuration check has passed.
Saving another change returns the profile to unverified.

## Plain text mode

Everything written to stdout is streamed into one assistant message. ANSI control
sequences are removed. Stderr becomes a bounded runtime diagnostic and is not mixed
into the assistant answer.

Plain text mode is the most portable choice:

```text
I inspected the workspace and found three failing tests.
```

The process must exit with status 0 for a successful run. A non-zero exit, spawn
failure, output-limit failure, or cancellation fails the turn while preserving
already streamed text as partial output.

## JSON Lines mode

Write one complete JSON object followed by `\n` for each assistant delta. A generic
runtime may use any one of these version-1 text envelopes:

```json
{"type":"text","text":"First chunk"}
{"type":"delta","delta":" and second chunk"}
{"type":"message","content":"A complete message"}
{"type":"result","result":"A final answer"}
```

Ground also accepts the common nested stream shapes:

```json
{"type":"stream_event","event":{"delta":{"text":"A streamed chunk"}}}
{"type":"item.completed","item":{"type":"agent_message","text":"A final answer"}}
```

`result` and `item.completed` are complete-answer shapes. If the process already
streamed assistant text, Ground suppresses the complete answer to avoid duplicating
it. Emit either deltas or one complete-answer shape, and make the complete answer
the last stdout event. Unknown well-formed JSON objects are ignored. Malformed
lines are surfaced as bounded diagnostics and do not become assistant content.

The Generic CLI bridge deliberately does not infer native session resume, token
usage, structured tool activity, or Ground-managed tool access. A richer integration
should implement the provider-neutral
[`AgentRuntimeAdapter`](PROVIDER-SDK.md#agent-runtime-adapters) contract in a
reviewed downstream build and run the public conformance suite.

## Minimal Node.js bridge

[`examples/generic-cli/echo-agent.mjs`](../examples/generic-cli/echo-agent.mjs) is
an executable, dependency-free contract example. Configure it with:

```text
Executable: /absolute/path/to/node
Arguments:
/absolute/path/to/ground/examples/generic-cli/echo-agent.mjs

Runtime adapter: Generic CLI
Prompt transport: Standard input
Output parser: JSON Lines / stream JSON
```

Replace the example's deterministic transformation with a call to the model SDK or
local runtime you control. Keep credentials in that runtime's native credential
store when possible. If a profile-specific environment value is necessary, add it
through Ground's encrypted profile environment rather than placing it in argv.

## Limits and security boundary

- stdout and stderr are each limited to 16 MB;
- one JSON line and total assistant text are each limited to 2 MB;
- at most 10,000 normalized events are accepted;
- configured secret values must contain at least four characters and are redacted
  across output chunk and JSON-line boundaries;
- executable-search, loader, home/config, and temp redirection variables are
  rejected;
- cancellation terminates the child process tree on a best-effort basis; and
- the executable still has the operating-system permissions of the current user.

Do not treat a JSON activity emitted by an arbitrary process as proof that Ground
approved its internal action. Generic runtimes own their behavior. For
Ground-managed read/write/command/MCP tools with exact approvals, connect through a
model adapter instead.
