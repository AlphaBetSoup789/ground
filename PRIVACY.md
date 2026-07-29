# Privacy

Ground is designed as a local-first desktop application. The developer preview has
no Ground account, analytics, advertising, crash reporting, hosted sync, or
mandatory model relay.

This document describes the current source tree. A published binary must link to the
privacy notice for that exact release.

## Data stored on the device

Ground stores the following beneath Electron’s platform-specific application data
directory:

- task titles, messages, activity, run status, and settings;
- per-item provider/model attribution and portable canonical tool history;
- workspace references;
- provider profiles and non-secret configuration;
- MCP profiles and approved tool-definition fingerprints;
- recognized CLI session metadata; and
- encrypted provider credentials and optional CLI profile environment values.

Provider profiles expose only a `hasApiKey` indicator to the renderer. Credential
values remain in the main process and are encrypted with Electron `safeStorage`.
Ground refuses to save a key when secure storage is unavailable, including
Electron’s unencrypted Linux `basic_text` fallback. Ciphertext is stored under an
opaque reference derived from the provider ID, protocol, and canonical endpoint;
provider metadata and secret updates are ordered so a failed endpoint change cannot
send the replacement key to the previously persisted endpoint.

Optional CLI profile environment values use the same protected vault and remain in
the main process. The ordinary provider snapshot contains only variable names and
an opaque random revision fingerprint that is not derived from the values. Names
are shown in provider settings and native launch confirmation; values are never
included there. Ground attempts to redact a configured value if a CLI echoes it in
text, diagnostics, activity, or an error.

The current task store is an atomic JSON snapshot with one rotating previous
snapshot and a 128 MiB ceiling. If the primary cannot be validated at startup,
Ground can restore the backup, preserve structurally unreadable files under
quarantine names, and show a recovery banner. Operational filesystem failures stop
loading instead of moving valid data. The primary, backup, and quarantine files are
not encrypted at rest, so task history and other non-secret metadata have the same
protection as the user’s local account and disk.

## Data sent to model API endpoints

When a user runs an API model, Ground sends data directly to the configured
endpoint. Depending on the task and mode, this can include:

- system instructions;
- selected conversation history;
- model and generation settings;
- tool definitions;
- file contents or search results returned by Ground’s bounded tools; and
- tool results, command output, and errors included in the model loop.

In Ask mode, an API model can receive only list/read/search workspace tools. Agent
mode can also offer write and command tools, and approved MCP tools. Ground keeps
provider-attributed local history and can reconstruct normalized tool exchanges
when a user switches providers; this means relevant prior messages and tool results
may be sent to the newly selected provider. Foreign provider-owned continuation
state is not replayed.

Testing a connection sends a model-discovery request and the configured credential,
if required, to that endpoint. The provider’s own privacy, retention, training, and
account terms apply.

Ground does not intentionally send the entire workspace to a model, but a user or
agent can request files through the bounded tools. Review the endpoint and the
displayed side effects before running Agent mode.

## External CLI runtimes

Ground supplies an external CLI with the task prompt or bounded readable history and
sets the selected workspace as its working directory. The runtime executes as the
current operating-system user and may read files, use credentials, load plugins,
connect to MCP servers, make network requests, or emit telemetry according to its
own configuration.

Ground uses the CLI’s native credential/configuration stores by default. If the
user adds profile-specific environment values, Ground decrypts them only for that
profile’s launch and passes them directly to the child process. Removing the
profile removes its Ground-managed encrypted environment record, subject to the
retention and secure-erasure limitations below.

Ground cannot control an external CLI’s account, privacy, retention, or telemetry
behavior. Review that runtime separately.

## Commands, terminals, and MCP servers

An approved `run_command`, an interactive terminal, and a local MCP stdio server
are native processes running with the current operating-system user’s permissions.
They can read data and make network requests independently of Ground’s model
endpoint policy. Ground does not proxy, inspect, or block that network traffic.
Approval describes the launch Ground is about to perform; it is not an operating
system sandbox for that process or its descendants.

Connecting a remote MCP server sends MCP initialization and tool-discovery traffic
to its configured URL. When the user approves an MCP call, Ground sends the exact
displayed tool arguments to that server and receives its tool result. A later model
round can receive that result as part of task context. Remote MCP servers therefore
have their own privacy, retention, authentication, and network policies. This
preview supports HTTPS remote MCP except literal loopback HTTP, but does not yet
support remote authentication headers or OAuth.

## Local endpoints

Using a loopback Ollama, LM Studio, or other local endpoint keeps Ground’s model
request on the local network interface. It does not guarantee that the server,
model, plugins, or external CLI stay offline. Ground displays and uses the endpoint
the user configured and does not silently add a hosted relay.

## Logs and diagnostics

Ground does not currently upload logs or create automated support bundles. Provider
and CLI diagnostics can appear in the local task timeline and may contain
provider-generated text. Do not share raw logs, state files, screenshots, or
transcripts without reviewing every field.

Any future diagnostics feature must be opt-in, redact locally, show the exact export
before sharing, and work without a Ground account.

## Retention and deletion

Tasks and provider profiles can be removed in the app. Task deletion requires a
native confirmation, closes that task’s open terminals, and does not delete or
modify workspace files. Deleting a provider also removes its stored Ground
credential. Provider-side copies are governed by that provider and must be deleted
through the provider’s controls.

Deletion is not secure erasure. The pre-deletion state can remain in the rotating
backup until a later successful write replaces it; quarantine files, operating
system backups, filesystem snapshots, and previously exported files can retain
content. Ground does not yet provide a supported full-reset or backup-management
screen.

Archiving is not deletion: it keeps the complete task locally and makes it
unavailable for new Ground run/workspace actions until restored. Any existing PTY
is detached rather than killed, so a process already running in that shell can
continue. Local sidebar search examines a bounded portion of active or archived
task timelines and does not send the query or results to a Ground service.

Forking creates a separate local task with new internal identities. It preserves
readable history and the explicitly selected provider/mode/workspace, but drops
native runtime sessions, pending approvals, checkpoints, provider-owned state, and
incomplete tool exchanges. Deleting either task does not delete the other.

Removing a clean Ground-managed Git worktree deletes that worktree through Git,
closes its linked terminals, and detaches linked Ground tasks from the removed
workspace. Their local history remains until those tasks are deleted separately.

## Task export and import

The task menu can write a Markdown transcript or a versioned JSON bundle to a path
the user chooses. JSON bundles omit provider credentials, runtime sessions,
provider-owned continuation state, workspace grants, pending approvals, and
original internal IDs. Ground replaces the selected workspace’s absolute path,
removes secret-shaped structured fields, and rekeys tool calls.

This is structural filtering, not a general secret scanner. Prompts, pasted
credentials, source snippets, command output, file contents, and tool results can
still contain private data. Exported files are outside Ground’s state directory and
remain until the user deletes them. Review an export in full before sharing it.

Imports are strict, bounded, and receive new local identities without a workspace
grant or execution authority. Their visible timeline is excluded from model
context by default. If the user enables the task’s imported-history control
through its native warning, an exact provider match can seed a later request after
the user starts a new run; that imported content may then be sent to the configured
endpoint. Re-excluding it invalidates provider continuation state that was bound to
the included context.

## Changes

Privacy-impacting changes—especially telemetry, hosted services, sync, diagnostics,
or account features—require an explicit design review and an update to this file.
They must remain optional unless Ground’s governance and product promise are changed
publicly.
