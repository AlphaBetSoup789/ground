# Privacy

Ground is designed as a local-first desktop application. The source project has no
Ground account, analytics, advertising, crash reporting, hosted sync, or mandatory
model relay. It is experimental, and any repository-built unsigned preview is not a
published or supported production binary.

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
- a main-owned preferred Git executable path and content/metadata fingerprint;
- recognized CLI session metadata; and
- encrypted provider credentials and optional CLI profile environment values.

Provider profiles expose only a `hasApiKey` indicator to the renderer. Credential
values remain in the main process and are encrypted with Electron `safeStorage`.
Ground refuses to save a key when secure storage is unavailable, including
Electron’s unencrypted Linux `basic_text` fallback. Ciphertext is stored under an
opaque reference derived from the provider ID, protocol, canonical endpoint, and a
unique credential revision; provider metadata and secret updates are ordered so a
failed endpoint change cannot send the replacement key to the previously persisted
endpoint. A versioned profile never falls back to an older provider-ID secret, and
a blank edit is refused when the exact saved key cannot be decrypted.

For compatibility, an API profile created before credential revisions existed can
read its provider-ID legacy key only when that unchanged profile expects a key and
its exact endpoint-scoped record is absent. Test and run resolution do not write,
migrate, or delete that fallback. An explicit save can stage a new versioned
record. A versioned profile and a profile marked as having no key never consult the
legacy provider-ID record.

Optional CLI profile environment values use the same protected vault and remain in
the main process. Each replacement is stored under a new opaque versioned
reference before the provider pointer changes; a versioned profile never falls
back to its legacy provider-ID record. The ordinary provider snapshot contains the
variable names and two independent random 32-byte-hex identifiers, neither derived
from the values. The environment fingerprint is also inside the encrypted envelope
and detects a profile/record mismatch; the record revision selects the versioned
vault reference. Both enter the complete provider/continuation fingerprint, but
native configuration and invocation authorization bind only the variable names and
environment fingerprint. Names and that fingerprint can be shown in provider
settings and native launch confirmation; the record revision and values are never
included there. Ground attempts to redact a configured value if a CLI echoes it in
text, diagnostics, activity, or an error.

The vault accepts at most 768 KiB of UTF-8 plaintext and 1 MiB of encrypted binary
data per record, with canonical base64 checked against the decoded binary limit.
Its steady state is capped at 1,000 records and 8 MiB of serialized JSON. Staging
can temporarily reach 2,000 records and 16 MiB. Removing explicitly obsolete
references must normally project back within the steady cap; when an interrupted
transition already left the vault above steady state, Ground accepts only a strict
non-growing improvement toward that cap.

Provider saves use the main-only, state-coupled `pendingSecretDeletes` journal.
Ground persists the new reference as provisional, stages the encrypted value,
atomically publishes the provider pointer and exact obsolete-reference intents,
deletes only those exact vault records, and acknowledges the journal only after
deletion succeeds. It does not enumerate the vault and sweep records merely because
they are absent from current provider state.

At startup, a separate read-only availability check attempts to resolve the exact
credentials selected by provider metadata. It never writes, migrates, or deletes a
secret. A structurally invalid vault is preserved under an unreadable quarantine
name and affected providers receive visible re-entry guidance. A valid ciphertext
file is not quarantined merely because the operating-system keychain is temporarily
unavailable; credentials remain inaccessible until that service returns. Missing
API or CLI-environment records produce the same warning again on later starts
without copying secret references into ordinary task state.

Startup drains only journaled exact references after comparing them with the live
references selected by provider state. A stale intent for a live value is
acknowledged without deleting that value. When Ground had to restore an older state
generation or reset state, it defers all queued secret deletion for that process,
deletes no queued ciphertext, and asks the user to review and restart. If a state
or vault publication becomes ambiguous after an atomic rename may have succeeded,
startup aborts before writable services exist. The same ambiguity during an
already-running state publication—or a provider-vault mutation—seals every later
state mutation and new renderer change, then relaunches so the journal in the
selected disk generation can resolve the exact provisional or obsolete references.

The current task store is an atomic JSON document with three rotating validated
snapshots and a 128 MiB ceiling per generation. If the primary cannot be validated
at startup, Ground can fall back through those generations, preserve structurally
unreadable files under quarantine names, and show a recovery banner. Recovery
settings can inspect bounded metadata, export a selected valid generation, and
restore a retained one after native confirmation. State exports do not include the
separate credential-vault document or Git-executable preference. They can contain
opaque `pendingSecretDeletes` reference strings because those are part of the
selected state generation, but not their ciphertext or plaintext values. The field
is excluded from ordinary renderer snapshots. Operational filesystem failures stop
loading instead of moving valid data. The primary,
retained generations, quarantine files, and user-created exports are not encrypted
at rest, so task history and other non-secret metadata have the same protection as
the user’s local account and disk.

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

Within the configured managed-API request budget, Ground gives the latest user
message priority as the active objective and then includes recent complete
conversation/tool-result groups. If the exact objective would otherwise displace
all newer evidence, Ground may send a visibly marked bounded form containing its
beginning and end; the local timeline retains the full text. Ground reports
timeline-projection and request-planner reductions in an updating local activity.
If even a marked objective cannot fit, Ground fails before contacting the model
adapter for that request. This policy applies to Ground-managed API requests, not
to the provider-internal context behavior of external CLI runtimes.

Testing a connection sends a model-discovery request and the configured credential,
if required, to that endpoint. If an OpenAI-compatible `/models` response cannot
prove compatibility, Ground makes a separate bounded non-streaming
`/chat/completions` request to the exact configured model with a four-token output
limit. That fallback is a real generation request and may consume endpoint quota.
First-class provider tests do not use this fallback. Test results are persisted only
when the form still exactly matches the saved provider-configuration fingerprint; a
saved provider cannot start a run until that exact configuration has passed. The
provider’s own privacy, retention, training, billing, and account terms apply.

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
profile removes its exact and legacy Ground-managed encrypted environment records,
without requiring the old value to decrypt, subject to the retention and
secure-erasure limitations below.

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

On quit or state restore, Ground stops admitting MCP work, aborts pending
connections and connected-client lifecycles, and makes bounded close attempts. It
waits at most 2 seconds for each client close or pending connection and at most 2.5
seconds for manager-wide cleanup and queued operations. Local stdio TERM/KILL waits
are bounded too. Those limits keep the application from hanging; they do not prove
that an uncooperative remote transport or escaped local descendant stopped, nor do
they remove data already received by an MCP server.

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
credential; if exact or legacy vault cleanup fails after profile deletion, Ground
reports that failure instead of claiming complete cleanup. The exact references
remain in `pendingSecretDeletes` for a later startup retry unless recovery selected
an older state generation, in which case that process defers deletion. Provider-side
copies are governed by that provider and must be deleted through the provider’s
controls.

Deletion is not secure erasure. The pre-deletion state can remain in the three
rotating retained generations until later successful writes replace it; quarantine
files, operating-system backups, filesystem snapshots, and previously exported
files can retain content. Recovery settings manage Ground’s bounded retained
generations but do not provide secure erasure or a supported full reset.

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

A recoverable Git file restore can copy the exact pre-restore contents of selected
tracked files and move selected untracked files into Ground’s private recovery
area beneath its managed worktree root. Those recovery payloads are outside the
repository but remain local plaintext files protected by the user account and disk.
Ground uses them for conservative undo and preserves them when a restore becomes
recovery-required. They are not task exports or secure deletion; review and remove
obsolete application data through operating-system controls when necessary.

Git executable selection stores a private main-process preference containing the
canonical local path and its fingerprint. The renderer receives only whether
selection succeeded, not that preference record. The path can still reveal local
installation/user-directory information to anyone who can read Ground’s
application-data directory; do not attach it to public support reports.

## Task export and import

The task menu can write a Markdown transcript or a versioned JSON bundle to a path
the user chooses. JSON bundles omit provider credentials, runtime sessions,
provider-owned continuation state, workspace grants, pending approvals, and
original internal IDs. Ground replaces the selected workspace’s absolute path,
removes secret-shaped structured fields, and rekeys tool calls.

The JSON bundle’s portable provider descriptor is deliberately narrower than a
local profile. An API descriptor contains only its `model-api` type, protocol
`kind`, sanitized `name`, `model`, and `supportsTools`; a CLI descriptor contains
only its `agent-cli` type, `cli` kind, sanitized `name`, `model`, and normalized
adapter. It contains no endpoint, local provider ID, credential/key state, CLI
executable/arguments/environment, verification, or continuation state.

This is structural filtering, not a general secret scanner. Prompts, pasted
credentials, source snippets, command output, file contents, and tool results can
still contain private data. Exported files are outside Ground’s state directory and
remain until the user deletes them. Review an export in full before sharing it.

Imports are strict, bounded, and receive new local identities without a workspace
grant or execution authority. Their visible timeline is excluded from model
context by default. “Exact provider match” means equality only on the portable
descriptor fields above; it does not establish endpoint or credential identity
because those are not exported. Ground otherwise selects the current task’s
provider or the first configured provider, and only an exact API descriptor retains
the bundle’s canonical conversation as an imported seed. If the user enables the
task’s imported-history control through its native warning and starts a new run,
imported content may be sent to the locally selected endpoint. Review that endpoint
before opting in. Re-excluding imported history invalidates continuation state that
was bound to the included context.

## Changes

Privacy-impacting changes—especially telemetry, hosted services, sync, diagnostics,
or account features—require an explicit design review and an update to this file.
They must remain optional unless Ground’s governance and product promise are changed
publicly.
