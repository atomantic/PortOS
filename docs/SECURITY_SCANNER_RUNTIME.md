# Codex security scanner runtime

Codex security audits request one scanner execution through the authenticated
`POST /api/cos/agents/:id/security-scan` host-control endpoint. The request contains
the actual audit prompt, workspace-relative source paths, and optional knowledge
base paths. The runner resolves paths inside the assigned workspace and launches
an already installed `@openai/codex-security` CLI. It never installs a package or
selects another provider after a failure.

Before execution, missing, malformed or out-of-workspace context paths produce
`invalid-input` evidence. This records a rejection count and the last field,
zero-based item index and bounded error code, without publishing paths or raw
errors. After the receipt is saved, the active audit may verify and resubmit
corrected paths. Concurrent requests share the current validation result rather
than queueing executions. Malformed request bodies are rejected by the HTTP
schema before reserving an execution.

Only explicit `invalid-input` evidence permits correction. Runtime failures,
transport errors, missing installations and every result after execution
reservation remain terminal. The `running` receipt is durable before the first
child spawn; a crash in that gap cannot authorize another launch. Stop revokes
correction, and a restarted runner never re-registers an existing grant, even
one with only preflight evidence. A new audit requires a separate grant.
Input rejection diagnostics remain in subsequent running and terminal receipts
so a successful correction does not erase validation history.

The immutable dispatch grant uses the effective outer Codex command's model and
effort, including saved flags and supported-effort clamping. Missing or conflicting
pins make the scanner unavailable. New dispatches receive a $25 API-equivalent
short-context estimate cap and a 1,200-second process-group deadline. Existing
$2/180-second grants retain their original limits; no receipt is reset or upgraded.
Both policies require explicit ChatGPT authentication. API-key environment variables
are not passed to this subprocess. The cap uses the scanner's short-context baseline;
in-flight work can exceed it. These estimates measure neither billed charges nor
ChatGPT subscription quota, and cannot be converted to a weekly usage percentage.
A cybersecurity-policy refusal stops the scanner and outer request without automatic
continuation, retry or fallback.

The server waits up to 1,210 seconds for the scanner POST, allowing the longest
grant plus cleanup to complete. That request uses the existing transport dispatcher
without undici's shorter header/body inactivity ceilings; the whole-exchange timeout
still applies and the request is never automatically retried. Status and Stop calls
retain their 15-second transport timeout. None of these waits extends a saved grant.

The runner owns a separate POSIX process group. A small IPC supervisor waits until
its ownership receipt is durable before launching the scanner. Losing the runner
connection kills that group. Outer completion, termination, pause and shutdown
settle the scanner first; cleanup escalates independently of the outer agent map.
After restart, recovery verifies the group's start identity or each surviving
worker's inherited ownership marker before signaling it. Ambiguous ownership is
left untouched and shown as cleanup unconfirmed. Windows reports this scanner
runtime unavailable until equivalent process ownership is supported.

Runner observations are emitted while the audit is running and saved in ordinary
agent metadata, independently of the completion sentinel or quality assessment.
The UI labels them **runner observed**; older `SCANNER_STATUS_JSON` records remain
**agent reported**. Ordered runner receipts cannot be replaced by older socket
snapshots or agent claims. A lost runner connection is recorded separately from
the last runner revision, so a later observed refusal or exit can still arrive.
A successful assessment/delivery never changes an
interrupted scan into a completed one. Artifact presence describes saved files,
not a guarantee of findings quality or full coverage.

Two additive per-run files, `security-scan.json` and `security-scan-process.json`,
live in the existing agent directory and move with its archive. The first is a
bounded recovery receipt, the second a private process ownership journal. Old
agent records need no transformation and remain readable. Prompts, scanner state,
full logs and result files stay in a private temporary directory; the HTTP response
gives that directory to the owning audit. These files are machine-local runtime
evidence and are not added to federation payloads. No live scan is necessary for
the synthetic process, dispatch, authorization and completion regression suites.
