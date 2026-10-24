# Codex security scanner runtime

Codex security audits request one scanner execution through the authenticated
`POST /api/cos/agents/:id/security-scan` host-control endpoint. The request contains
the actual audit prompt, workspace-relative source paths, and optional knowledge
base paths. The runner resolves paths inside the assigned workspace and launches
an already installed `@openai/codex-security` CLI. It never installs a package or
selects another provider after a failure.

CLI discovery checks the project dependency first, then global npm executables
on the runner's absolute `PATH` entries, then existing npm execution-cache
installs. A PATH executable must resolve to the declared bin of an
`@openai/codex-security` package; arbitrary launchers are not executed to probe
availability. This supports global installations without downloading anything
or running `npm`/`npx` during an audit.

Dispatch directs the outer Codex agent to read instructions and threat-model
documents, establish scope, then call the scanner **before vulnerability
discovery or active testing**. Repository-wide audits use `paths: ["."]`;
explicitly scoped audits retain their requested boundary. The scanner performs
the initial investigation, and the outer agent validates its evidence and
handles the task's tracker/remediation delivery afterwards.

Installing the CLI or plugin does not change the outer agent's cyber access.
Provider safety refusals remain terminal in both phases. Broader approved access
requires [Trusted Access/Daybreak](https://learn.chatgpt.com/docs/cyber-safety)
for the actual account, model and surface; selecting a scanner or changing a
local permission setting does not grant that access. Suspected false positives
can be reported through Codex `/feedback`. See the
[official scan guidance](https://learn.chatgpt.com/docs/security/plugin/scans)
for threat-model context and coverage interpretation.

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
pins make the scanner unavailable. New dispatches explicitly save `"unlimited"`
for both `maxCostUsd` and `timeLimitSeconds`: PortOS imposes neither an estimate cap
nor an elapsed-time deadline. `null` remains unknown and numeric zero remains zero;
omitted fields cannot create a grant. Existing $2/180-second and $25/1,200-second
grants retain their original limits; no receipt is reset or upgraded. All policies
require explicit ChatGPT authentication, with no API fallback. API-key and scanner
project-config environment variables are not passed to the subprocess.

The installed Codex Security 0.2.0 configuration schema documents omission of
`maxCostUsd` as no limit. PortOS omits `--max-cost` for unlimited grants; it never
passes zero, null or an invented large budget. The CLI loads a project file only
when explicitly selected by `--config` or `CODEX_SECURITY_PROJECT_CONFIG`; neither
is provided. Thus a repository configuration cannot silently reinstate a cap.
The adapter retains its existing `--mode standard` and does not pass `--max-time`.
Provider quota, rate and safety limits still apply. For saved bounded grants the
cap uses the short-context API-equivalent baseline; in-flight work can exceed it.
These estimates measure neither billed charges nor ChatGPT subscription quota,
and cannot be converted to a weekly usage percentage. The final CLI JSON supplies
`cost.estimatedUsd` as the baseline even without a cap; a missing, malformed or
oversized result remains unknown. A cybersecurity-policy
refusal stops the scanner and outer request without continuation, retry or fallback.

The scanner POST has no elapsed timeout and uses the existing transport dispatcher
without undici's header/body inactivity ceilings. The canonical loopback curl request
also disables its elapsed timeout. The HTTP servers and dev proxy impose no response
wait cutoff on this route; incoming-request/header and keep-alive limits do not
limit a scan after its request body has arrived. Status and Stop calls retain their
15-second transport timeout. Requests are never automatically retried, and none of
these waits extends a saved bounded grant.

For an unlimited grant, the whole outer audit session also skips silence-based
continue nudges and stalled badges, including later validation or fix work. Startup
readiness, explicit provider failures/refusals, completion signals, manual Stop and
actual process exit remain active. Job maintenance/recovery checks process ownership
and liveness; quiet work is not an elapsed-time failure.

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
