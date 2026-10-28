# One pre-PR local review phase per delivery

The orchestrator owns these receipts; reviewers must not receive or write them.
They are private Git worktree evidence, never committed, synced or copied into
PR bodies. The installation's `server/scripts/local-review-lifecycle.mjs` records
branch, origin, base, aggregate status, completion head, actual historical inspection head (when available), and PR/MR URL. Version 2 receipts keep `completedHead` distinct from `reviewedHead`; `inspectionProvenance` is `recorded` or `unavailable`. Version 1 receipts remain unchanged and readable, but their `reviewedHead` is only a completion head: `check` reports `inspectionProvenance: legacy-unknown` in its `inspection` projection. Never infer inspection or approval from that old field.
It never changes reviewer-model attribution or treats a later commit as reviewed.

Before resetting review state or calling a reviewer, resolve the existing open
PR/MR for the exact branch/base with the forge CLI. Lookup failure is not absence.
Run `node <installation>/server/scripts/local-review-lifecycle.mjs check <base> <PR_URL>`;
omit PR_URL only when no PR exists. Require readable JSON.

- `reusable:true` with `clean`/`partial`: restore the saved aggregate and skip
  local review, resets and attribution initialization. After publication continue
  only hosted feedback, fixes, focused validation, required hosted approval/CI
  and merge safety checks. Multiple pushes, rebases and restarts do not reopen
  the local phase.
- `review-blocked`: resume only unfinished required reviewers. Save each
  reviewer's completion and findings-remediation outcome in private phase state
  as it finishes so successful reviewers survive interruptions. Failed starts,
  empty/malformed output and missing verdicts are not successful review. Never
  mark unavailable review clean or repeat successful reviews to repair evidence.
- No reusable receipt, no PR: run the first configured phase and remediate all
  accepted findings, including its normal re-review rounds. Before initial
  publication, changed code still needs review. Before/after every reviewer,
  persist the current reviewer and validated outcome; resume completed entries
  from those records rather than resetting the roster.
- `legacyPublished:true`: an existing PR predates receipts or was opened by hand.
  Report unavailable prior local execution/model evidence without inventing a
  clean verdict, reviewed head or attribution. Continue hosted feedback/CI and
  required hosted approvals, without automatically spawning local reviewers.
  Preserve any explicit unresolved findings or required-review blocks. Do not
  fabricate/bind a local receipt. This is not a clean local verdict.
- Existing PR with mismatching or unreadable evidence: recover original phase results from
  trusted private records, including the actual reviewed head. If recovery is
  impossible, leave open with an evidence blocker; no automatic reviewer spawn.
  Do not turn an old receipt or a configured model roster into execution evidence.

After the phase finishes and all accepted findings/validation failures are fixed,
run `node <installation>/server/scripts/local-review-lifecycle.mjs complete <base> <status>`
with `clean`, a qualifying `partial`, or availability-only `review-blocked`.
Incomplete/dirty/findings are rejected. Save original phase state and model
receipts alongside it. Before PR creation a same-completion-head retry reuses this completion. Initial publication must match `completedHead`, even when the actual inspection was earlier. Publication guards use the validated receipt completion projection; a reusable v1 receipt supplies its original completion head even if the old phase state lacks `LOCAL_REMEDIATED_HEAD_SHA`, while inspection remains explicitly unknown.
After successful creation or recovery, run
`node <installation>/server/scripts/local-review-lifecycle.mjs publish <base> <PR_URL>`.
Receipt-write failure blocks publication/merge until repaired from the completed
result, without another provider call. If creation succeeded before binding,
verify the original published head against the receipt using forge history before
repairing its binding. Preserve the original reviewed head after later pushes.

For a new task or PR use a fresh branch/worktree; if deliberately reusing one,
archive old private phase/lifecycle/model evidence first and initialize a fresh
delivery. A closed/merged PR's receipt cannot authorize another PR. Explicit
user-requested re-review may likewise archive the previous phase and start a new
one, recording its own revision/model evidence. Ordinary feedback/CI recovery is
not an explicit re-review request.

## Persisting the inline local phase

When the local roster exhausts or its configured stop fires, aggregate clean
required results and clean/optional-inconclusive optional results as `clean`.
A qualifying configured stop may be `partial`. Only required-review availability,
quota/provider, transport, timeout, malformed/empty or no-verdict failures may
produce `review-blocked`; it permits publication but prevents merge. Unresolved
accepted findings/rejection, failed tests/build, unpushed fixes and persistence
failures prevent publication. Do not substitute self-review for unavailable review.

A reviewer's configured `~max=<n>` budget caps calls to that reviewer, not the
obligation to fix findings. Spending it ends that reviewer's loop with `partial`
status; it neither requires another cycle nor prevents publication. Each accepted
finding is still fixed, or rejected/tracked with concrete rationale. Disclose the
rounds each reviewer ran, the revision it last reviewed and what remained in the
PR/MR body, without claiming approval the reviewer did not give. The stop-mode gate uses the completed head to bind the configured short-circuit; it does not claim that remediation commits were inspected. Only a required
reviewer's unavailability (`review-blocked`) holds the merge; an exhausted or
unavailable optional reviewer adds no local merge hold. Remote merge eligibility
stays with the hosting provider's required checks and reviews.

Set `LOCAL_STOP_TRIGGERED=true` and `LOCAL_STOP_INDEX` to the configured zero-based
reviewer position on a qualifying stop, including the final reviewer. Otherwise
use false/-1. Compute `LOCAL_PHASE_COMMITS` from `LOCAL_PHASE_START_SHA..HEAD`.
If a stop fired, retain that reviewer's `LOCAL_REVIEWER_COMMITS` in
`LOCAL_STOP_REVIEW_COMMITS`; otherwise use -1. `on-clean` qualifies only with a
clean zero-change pass; `on-findings` requires a clean pass that added commits;
`partial` already records a qualifying configured short-circuit.

Before every reviewer call, capture its exact input HEAD. After a validated clean/findings response, persist that captured SHA as `LOCAL_REVIEWED_HEAD_SHA`; retain it through remediation. Failed/unavailable attempts do not update it. If no reviewer produced a validated result, explicitly persist an empty value, which records unavailable inspection rather than inventing a reviewed commit. This is valid for availability-only `review-blocked`, or `clean` when only optional availability/inconclusive outcomes remain; `partial` requires an actual inspection.

After remediation, record `LOCAL_REMEDIATED_HEAD_SHA=$(git rev-parse HEAD)` and persist all fields together (reload existing state across shell calls). Completion validates the aggregate status, exact remediation head, phase start/history and commit counts, coherent stop fields (including an explicit triggered stop for `partial`), and that the actual inspection SHA lies within the phase history. A supplied clean `portos-review-status` inspection head must agree; malformed/duplicate evidence is refused without replacing existing proof:

```bash
LOCAL_REVIEW_STATE_FILE="$(git rev-parse --git-path portos-local-review-state)"
printf 'LOCAL_PHASE_START_SHA=%s\nLOCAL_OVERALL_STATUS=%s\nLOCAL_STOP_TRIGGERED=%s\nLOCAL_STOP_INDEX=%s\nLOCAL_STOP_REVIEW_COMMITS=%s\nLOCAL_PHASE_COMMITS=%s\nLOCAL_REVIEWED_HEAD_SHA=%s\nLOCAL_REMEDIATED_HEAD_SHA=%s\n' "$LOCAL_PHASE_START_SHA" "$LOCAL_OVERALL_STATUS" "$LOCAL_STOP_TRIGGERED" "$LOCAL_STOP_INDEX" "$LOCAL_STOP_REVIEW_COMMITS" "$LOCAL_PHASE_COMMITS" "$LOCAL_REVIEWED_HEAD_SHA" "$LOCAL_REMEDIATED_HEAD_SHA" > "$LOCAL_REVIEW_STATE_FILE"
```

A failed write blocks publication. Then use the `complete` command above with
the resolved base and `LOCAL_OVERALL_STATUS`; that write must also succeed.
Return to the outer completion workflow for publication; never push/open from a
local reviewer loop. Preserve these original phase fields after publication.
