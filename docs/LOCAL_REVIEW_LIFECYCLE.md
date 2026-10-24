# One pre-PR local review phase per delivery

The orchestrator owns these receipts; reviewers must not receive or write them.
They are private Git worktree evidence, never committed, synced or copied into
PR bodies. The installation's `server/scripts/local-review-lifecycle.mjs` records
branch, origin, base, aggregate status, historical reviewed head and PR/MR URL.
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
receipts alongside it. Before PR creation a same-head retry reuses this completion.
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
