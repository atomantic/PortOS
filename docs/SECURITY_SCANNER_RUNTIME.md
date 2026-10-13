# Codex security scanner runtime

Codex security audits request one scanner attempt through the authenticated
`POST /api/cos/agents/:id/security-scan` host-control endpoint. The request contains
the actual audit prompt, workspace-relative source paths, and optional knowledge
base paths. The runner resolves paths inside the assigned workspace and launches
an already installed `@openai/codex-security` CLI. It never installs a package or
selects another provider after a failure.

The immutable dispatch grant uses the effective outer Codex command's model and
effort, including saved flags and supported-effort clamping. Missing or conflicting
pins make the scanner unavailable. The bounded workflow retains explicit ChatGPT
authentication, a $2 API-equivalent estimated-cost ceiling, and a 180-second scan
deadline. API-key environment variables are not passed to this subprocess. These
estimates do not establish billing charges. A cybersecurity-policy refusal stops
the scanner and outer request without automatic continuation, retry or fallback.

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
