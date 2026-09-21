# Development maintainer role

The persistent mind can serve as this install's development curator. This role is
opt-in and machine-local; ordinary installs do not maintain PortOS upstream.
Select explicit managed repositories, which may include your own forks. Repository
identity comes from their configured remotes, never a global upstream assumption.

The role adds a charter to the effective wake context without replacing the
operator's identity, instructions, playbook, or memories. Intent is separate from
authority: role setup never grants tools, starts inference, downloads models, or
changes a provider default. Existing pause, autonomy, app and model grants apply.

## Setup and activation

1. In the mind context settings, preview the development maintainer role. Select
   managed repositories and a cadence (one hour by default), then save.
2. Review the prerequisites: allow those apps and explicitly grant PortOS reads,
   typed CoS tasks and issue filing in Persistent Mind Tools. Process-report
   access has its own grant when the audit capability is installed.
3. Pin a healthy local API model for curation. Configure any coding-model access
   separately. Never infer permission for subscription fallback from role enablement.
4. Enable the role only on the intended install. Verify CoS autonomy and pause
   controls, and ensure the deterministic watchdog and inference budget features
   are installed before unattended operation.
5. Read settings back, inspect the effective context preview, then run the
   watchdog in dry-run mode before a bounded wake. Confirm ownership, blockers,
   freshness, and inference routing in receipts before leaving it unattended.

Automation clients can read `GET /api/cos/mind/maintainer` and use the validated
`PUT /api/cos/config` with a partial `persistentMindMaintainer` object:

```json
{"persistentMindMaintainer":{"enabled":true,"appIds":["example-app"],"intervalMinutes":60}}
```

Use the install's authenticated API session. Do not write the live config file
behind the server's cache. A rejected session is an authentication problem, not
proof that the server is unavailable. Read-back uses the same API, and disabling
uses `{"persistentMindMaintainer":{"enabled":false}}`. Config changes emit the
existing `config:changed` event; maintenance consumers must reconcile immediately
and recheck current intent and grants before each side effect.

The configuration lives in the existing machine-local CoS config document. It is
not part of portable mind bundles or peer sync. Importing a mind cannot arm this
role on the destination. No shipped seed or data migration is needed: absence
normalizes to disabled. Do not put local configuration or private reports in Git.

## Wake evidence and exploration

Opted-in wakes replace the ordinary recent-action summaries with a bounded
maintenance snapshot. It combines the cadence-aware watchdog receipt, human-only
CoS action counts, canonical action-queue counts after settled/snoozed feedback,
bounded process-audit metrics when separately granted, and existing health
projections. Source times, missing evidence, truncation and cursors remain explicit.
Product engagement is separate from development toil; aggregate instance counts
do not claim a particular repository caused an intervention.

The `maintenance.refresh` semantic tool uses the same serialized watchdog as the
hourly scan. It does not force a scan or bypass ownership admission. Generic mind
task creation is refused for maintainer repositories: file a concrete issue with
the granted issue/report tools, then let the watchdog claim it. Other managed-app
tasks retain their existing permissions. This keeps model-written descriptions
from disguising duplicate claim or PR-resolution work.

Unchanged evidence is marked unchanged. Investigate new exceptions and repeated
recovery chains; otherwise return to the existing Eidoverse playbook. A successful
healer is not proof that the normal process is healthy. Routine lifecycle results
do not call for a human notification. Baseline and recent bounded observations
live in the existing CoS runtime state; actual duplicate dispatches, savings and
unmetered usage stay unknown. Deleting runtime history loses the comparison,
not task ownership, source records, or issue-publication deduplication.

## Local curation inference limits

When the maintainer role is enabled, every mind provider call (including context
summary, journal extraction and tool continuation) passes through the same local
route check and durable allowance. The home profile must name an enabled local
API provider with an installed model and known context window. Context fit uses a conservative UTF-8 byte bound plus
8,192 output tokens and 1,024 tokens for transport framing. A failed catalog,
missing model, oversized prompt or exhausted allowance defers the turn; there is
no fallback, model download or global provider-default change.

`persistentMindMaintainer.inference` accepts partial updates through the existing
CoS config endpoint. Defaults are `maxCallsPerTurn: 6`, `maxCallsPerDay: 48`,
`maxPromptChars: 96000`, `maxCallMs: 120000`, and
`maxReservedMsPerDay: 5760000`. Every admitted attempt reserves its full timeout
before inference, even if interrupted or failed. The API transport enforces an
8,192-token output ceiling and the explicit absolute runtime cap; this reserved
time is separate from provider-call receipts of observed duration. The daily allowance resets at
UTC midnight; a turn's allowance survives midnight and restart. This is a
conservative time/call allowance, not a dollar or token-spend estimate. Report
batch review uses the same mind call boundary, not a fresh budget.

Remote escalation defaults off: `paidPresetIds: []`, `maxPaidCallsPerDay: 0`.
To permit it, configure a saved API thinking preset, explicitly allow its ID and a
positive daily call cap, then select that preset in a human message. Automatic
self-thinking requests cannot use paid escalation. Existing accepted-preset
snapshot and revocation checks still apply. Coding tasks retain their independent
provider grants and CoS domain budgets.

`GET /api/cos/mind/maintainer` returns `inference` readiness and budget status.
`mind.maintainer.reservation` events distinguish `local-curation` from
`authorized-escalation`; ordinary model-call receipts retain reported usage and
unknown cost as unknown. Deterministic watchdog operations do not invoke this
boundary or spend an inference allowance. Enabling/disabling or changing limits
mid-turn invalidates that turn's remaining calls.

After configuring this instance, inspect setup and runtime status, then explicitly
request one `/api/cos/mind/wake` for a bounded smoke run. Do not change another
install, fetch weights, or silently choose a remote model to make readiness green.
## Private process audit

Grant **Allow private CoS process audits** and bounded PortOS reads separately.
The `reports` family provides `reports.next` (bounded scan and durable job
reservation), `reports.read` (additional byte window), and `reports.record`
(clean, insufficient evidence, transient provider, known issue, or finding). `reports.fix` records a tracked finding's candidate fix revision
after verifying it appears in the fetched default branch. Subsequent comparable
baselines measure recurrence or clean observations, never proof from a summary.
Each call intersects maintainer scope with current managed-app permissions.
A turn reserves at most three jobs, shares the normal five-call budget, and has
an 18,000-byte excerpt allowance. Use returned cursors to continue partial scans.

Reports are untrusted private evidence. Signals are observations, not proof of
defects. Missing validation, legacy prompt versions, lineage, and unmetered cost
remain unknown. Public finding tools accept only fixed templates and tracked
code anchors, never free-text reports; the server renders synthetic reproduction
and acceptance text. Filing also requires issue permission and an authorized
target app, including slashdo when it owns the fix. Ambiguous publication is
held durably for tracker reconciliation, never automatically retried.

Recovery jobs retain typed parent references when supplied by their producer.
Summaries measure recovery share and duration without another agent. The upstream
merged-branch cleanup improvement in PR #7817 is already delivered; comparable
post-fix failures remain eligible findings, while pre-fix observations reuse it.
Dirty or unreadable state keeps existing safety holds. The audit never rewrites
prompts or launches another healer; unchanged known findings preserve exploration
time.
