# Managed PortOS release operations

Follow the [frozen candidate procedure](../../../docs/VERSIONING.md#creating-a-release).
These commands supplement that procedure for CoS coordinators and operators.

## Reserve and capture a candidate

A scheduled PortOS release coordinator must first reserve its candidate with the
server and verify its checkout immediately after creation. The server
chooses the branch for that active run, checks it was unused, and verifies the
current bound checkout through Git; a supplied path or branch name alone does
not establish ownership. Set `RELEASE_AGENT_ID` to the registered coordinator's
ID in the following example. A release outside PortOS has no agent registration
and can leave it unset. A missing/refused registration must not be replaced by a
guessed seed or by adopting an existing checkout. Each retry reserves its own
unused candidate; it does not transfer the predecessor's private review files.

```bash
set -e
# PRIMARY is the existing primary checkout; WORKTREE is a new isolated path.
# Keep these values in the run's record, not only in transient shell variables.
if [ -n "${RELEASE_AGENT_ID:-}" ]; then
  CANDIDATE_BRANCH=$(curl -fsS -H "Authorization: Bearer ${PORTOS_API_TOKEN:-}" -H 'Content-Type: application/json' \
    -d '{"action":"reserve"}' "http://127.0.0.1:5553/api/cos/agents/$RELEASE_AGENT_ID/release-candidate" | jq -er 'select(.reserved == true) | .branch')
else
  CANDIDATE_BRANCH="codex/release-$(node -e 'console.log(crypto.randomUUID())')"
fi
git fetch origin "refs/heads/main:refs/heads/$CANDIDATE_BRANCH"
RELEASE_CUT_SHA=$(git rev-parse "$CANDIDATE_BRANCH^{commit}")
git fetch origin refs/heads/release
RELEASE_BASE_SHA=$(git rev-parse 'FETCH_HEAD^{commit}')
git worktree add "$WORKTREE" "$CANDIDATE_BRANCH"
if [ -n "${RELEASE_AGENT_ID:-}" ]; then
  curl -fsS -H "Authorization: Bearer ${PORTOS_API_TOKEN:-}" -H 'Content-Type: application/json' \
    -d '{"action":"capture"}' "http://127.0.0.1:5553/api/cos/agents/$RELEASE_AGENT_ID/release-candidate" | jq -e '.captured == true' >/dev/null
fi
node scripts/link-worktree-deps.js "$PRIMARY" "$WORKTREE"
```

After choosing the version, repeat the reserve request with
`{"action":"reserve","version":"<version>"}` before preparing files. This rechecks
the exact proposed tag and current publication activity without changing the
reserved branch. A refusal leaves all existing candidates untouched. Ordinary
branch reconciliation retires merged candidates and preserves dirty or unique
abandoned work for its normal review path.

## Reserve and capture the synchronization checkout

For an inline PortOS release, the coordinator must reserve its separate sync
checkout before creating it and verify the current bound checkout before editing:

```bash
SYNC_RESERVATION=$(curl -fsS -H "Authorization: Bearer ${PORTOS_API_TOKEN:-}" -H 'Content-Type: application/json' \
  -d '{"action":"sync-reserve"}' "http://127.0.0.1:5553/api/cos/agents/$RELEASE_AGENT_ID/release-candidate" | jq -ec 'select(.reserved == true)')
SYNC_BRANCH=$(printf '%s' "$SYNC_RESERVATION" | jq -er '.branch')
SYNC_RESUME_PATH=$(printf '%s' "$SYNC_RESERVATION" | jq -r '.path // empty')
if [ -n "$SYNC_RESUME_PATH" ]; then
  SYNC_WORKTREE="$SYNC_RESUME_PATH"
else
  git fetch origin main
  git worktree add -b "$SYNC_BRANCH" "$SYNC_WORKTREE" FETCH_HEAD
  node scripts/link-worktree-deps.js "$PRIMARY" "$SYNC_WORKTREE"
fi
curl -fsS -H "Authorization: Bearer ${PORTOS_API_TOKEN:-}" -H 'Content-Type: application/json' \
  -d '{"action":"sync-capture"}' "http://127.0.0.1:5553/api/cos/agents/$RELEASE_AGENT_ID/release-candidate" | jq -e '.captured == true' >/dev/null
git -C "$SYNC_WORKTREE" merge --no-ff "$PROMOTION_MERGE_SHA"
```

Do not `git worktree lock` the sync checkout: its reservation and captured seed
already protect it from sweeps while the run is live, and ordinary cleanup leaves
a checkout under a foreign lock in place.

Use a new, unused `SYNC_WORKTREE` path when the reservation returns no path. A refused reservation or capture is not
authority to adopt another checkout. After interruption, verify the existing
publication again using the same original task and publication endpoint. Git and
GitHub must still agree on its candidate, promotion, tag, and successful workflow.
The service retains the original enrolled publication and synchronization policy;
no cryptographic checkout transfer or historical process receipt is needed.

For an idle existing synchronization checkout, reservation returns its path from
Git. Reuse that checkout and branch, including unfinished edits and private review
files; do not create a competing synchronization branch. The current run captures
its ownership at the actual current time. Previously recorded publication and
delivery evidence remains available.

## Recover synchronization checkpoints

Requests from older running coordinators that omit `synchronizationMode` retain
the existing version-1 continuation contract. Existing continuation tasks,
outboxes, budgets and ambiguous-policy holds keep their original identities.
Legacy receipts are not enrolled at startup: only an explicit verification
request can enroll one, retaining the original verification timestamp.

At registration the outbox freezes the effective PR disposition with the reviewer
roster. Explicit task dispositions and leave-open holds take precedence; otherwise
normal managed-app defaults apply, including the legacy review toggle when the
app has no configured disposition. Later settings changes do not alter the payload.

An older continuation with neither a stored disposition nor a legacy review toggle
has an ambiguous policy. Automatic registration and dispatch hold it with
`RELEASE_SYNC_REVIEW_POLICY_UNVERIFIED` / `review-policy-unverified`; they do not
infer intent from its roster or today's app settings. Recover using the original
run's saved prompt, pinned delivery policy and exact PR/head review receipts.
Resume the same branch/PR through ordinary delivery recovery only when that
historical evidence establishes the obligations, retaining reviewer order,
optionality, models and spent round/spawn budgets. Do not rewrite the immutable
outbox/task, mint another continuation or invent missing review evidence. A
provider-confirmed merge can still be observed by the existing synchronization
verifier; this dispatch hold does not invalidate completed delivery evidence.
If the historical policy cannot be established, keep the checkpoint held and use
the existing operator reset below only after an explicit decision to abandon it.

If a separate merged PR delivered a historical release, an operator can POST
`{ "identity": "<identity>", "prNumber": 123 }` to
`/api/cos/schedule/release-synchronization/verify-delivery`. The server checks the
merged PR and current default branch, candidate and published ancestry, and the
development version and lockfile. It records that independent delivery separately;
the original task and review verdicts remain historical. Future release dispatch
rechecks the delivery and active owners. This operation does not retire checkouts
or start a release.

The outbox keeps the original reviewer policy and publication ancestry. It never
transfers checkout authority. The owner uses the procedure below and ordinary
delivery and cleanup recovery.
Task CRUD cannot delete a synchronization task directly. Deleting one from the
task list (or `DELETE /api/cos/tasks/:id`) is the owner's decision to abandon
it: the route records the operator reset below unless
synchronization is already verified or reset, then removes the row. The outbox
keeps the publication receipt, and the reset refuses while a release or
synchronization is active. The outbox is machine-local, so the delete also
refuses on an instance that has no entry for the task; delete it on the
publishing instance. Execution success does **not** mark synchronization verified:
the delivery obligations remain pending until their evidence is observed. A bounded recovery
sweep checks the same outbox after restart, including completed task/agent history.
It records pending, running, blocked or verified synchronization separately from the
original publication timestamp and link. Transport failures retain successful
revision-bound proof and durable retry times; conflicting owners remain blocked.

Verification checks two obligations, each bound to the observed PR head and
development head:

- `synchronizationPr` — a same-repository back-merge PR into the default branch
  from the synchronization branch (`codex/release-sync-<identity>` for an inline
  release, the continuation's worktree branch otherwise) is merged, and its merge
  commit is on the development head. A merged attempt wins over closed ones; two
  merged or two open candidates are a `synchronization-pr-conflict` hold.
- `releaseAncestry` — the candidate head and the published promotion are both
  ancestors of the development head. For inline releases it also reads the
  package version at that head and requires it to be at least the published
  version; when the published tree contains `package-lock.json`, its development
  copy must agree with the package version. A newer development version is
  preserved; unreadable or older versions remain a synchronization hold.

A provider-confirmed merge establishes delivery under the repository's merge
policy: PortOS does not replay review, CI or merge admission after the merge. Run
the requested reviews and validation during delivery without treating an
unavailable review as clean. The post-release quality snapshot is a separate
development update; it never gates synchronization or the next release. Process
settlement and checkout retirement are not synchronization obligations either:
ordinary worktree cleanup removes the merged checkouts once no active agent owns
them. Outboxes written before these obligations were reduced (#16017) keep their
older obligation names readable; the next inspection drops them, so an entry held
only on a quality snapshot or checkout retirement verifies from its merged PR. A
checkpoint with an operator reset no longer retries and is labeled as retired,
with its original blocker kept as history. No verifier merges a PR, changes a
published tag, steals a checkout, or resets a task retry budget.

When an operator has decided to abandon a stale synchronization checkpoint and
start a fresh release from `main`, POST `{ "identity": "<identity>", "reason":
"<operator decision>" }` to `/api/cos/schedule/release-synchronization/operator-reset`.
The decision is immutable. This host-control action refuses while a CoS release or synchronization for the same
repository is active. The operator must also check for an external release process.
It records the operator, reason and prior blocker, retires
that checkpoint's queued continuation, and allows a new release. It does not mark
the old synchronization verified, change a tag, remove a checkout, or start a
release. Other outstanding checkpoints retain their own gates. Inspect and clean
up any abandoned candidate separately before starting the new release.

## Interrupted publishers

Automatic recovery requires settlement proof for the original registered agent, task,
start reservation and checkout generation. An absent PID or an empty cwd listing
cannot prove settlement. Preserve the checkout if recovery reports an unsupervised
run, a lost supervisor or nonmatching proof. The platform supervisors use
Windows Jobs, the [Linux subreaper](../../../server/lib/linuxAgentSupervisor.py),
and [macOS launchd coalitions](../../../server/lib/darwinAgentSupervisor.py).
Forge checks still apply to publication and cannot prove settlement.
