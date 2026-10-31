# Versioning & Release Process

## Version Format

PortOS uses semantic versioning: **Major.Minor.Patch**

| Component | Description | When Incremented |
|-----------|-------------|------------------|
| **Major** | Breaking changes | Via `/do:release` slash command |
| **Minor** | New features | Via `/do:release` slash command |
| **Patch** | Bug fixes, refactors | Via `/do:release` slash command |

Example progression: `0.22.0` → `0.22.1` (fix) → `0.23.0` (feature) → `1.0.0` (breaking)

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `codex/release-*` | A candidate pinned to the development commit captured at kickoff |
| `release` | Merge the validated candidate here to trigger publication |

## Workflow

### Version Bumping

Version is managed by the `/do:release` Claude Code slash command (provided by the [slashdo](https://github.com/atomantic/slashdo) skill). Do not bump `package.json` version manually during development.

### CI Validation

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests targeting
`main` or `release`, a nightly schedule that checks `main`, manual dispatch
(`workflow_dispatch`), and reusable-workflow calls (`workflow_call`). It plans
the required tests and linting for each run; CI does not change the version.

Direct pushes to `main` do not start this workflow. Run `npm run pregate`
before every push and again after rebasing onto a moved base, as required by
[`AGENTS.md`](../AGENTS.md).

### On candidate promotion to `release`

1. Release workflow triggers
2. Creates git tag with current version (e.g., `v1.31.0`)
3. Generates GitHub release with changelog (priority: exact `.changelog/v{version}.md` → pattern `.changelog/v{major}.{minor}.x.md` → fallback commit log) and uses the changelog's named first heading as the release title
4. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used, archives it by renaming to the exact version file on `main`
5. If the archive step ran, only `main` advances; `release` stays on the CI-verified commit until the next promotion

### Regular Development

```bash
# Work on main or feature branches
git checkout main
git pull

# Make changes, commit with a human-readable message (this becomes the
# release-note source — no changelog file or fragment to write)
git add [changed files]
git commit -m "fix: daily log no longer double-saves on blur"
git fetch origin main
# Rebase only for conflicts, enforced branch policy, or evidenced integration risk
# git rebase origin/main
npm run pregate
git push
```

The default pregate is lint/formatting, structural guards and focused tests.
Hosted CI owns broad validation; use `npm run pregate -- --full` only when
explicitly needed locally. Focused receipts are local evidence only.

A conflict-free feature branch may merge behind `main` once its current-head
required checks and configured reviews pass. Do not restart validation solely
because another agent merged; follow [the merge policy](../AGENTS.md#git-workflow).

See [`.changelog/README.md`](../.changelog/README.md) — release notes are
synthesized from commit history by `/do:release`, not staged during development.

### Creating a Release

Use `/do:release` with this **documented project procedure**, which takes
precedence over slashdo's generic live-source promotion recipe. Release preparation
and the release PR use a dedicated candidate branch; never use live `main` as the
PR head. There is no requirement to empty the issue or PR queue.

#### 1. Capture once at kickoff, or recover the existing candidate

Before version selection, backlog work, or validation, inspect existing release
PRs/candidate branches. Resume an interrupted candidate with its original cutoff,
release base, previous published tag, and version. Do not recut it from today's
`main`, bump its version again, or take over a live owner's release. If a legacy
open release PR uses `main` as its head, move the promotion to a dedicated branch
at its recorded validated SHA and close the superseded PR with a link. If no such
SHA was recorded, explicitly record a new cutoff and validate it from scratch;
never treat old checks as proof of the new tree.

An operator may instead explicitly abandon a stale attempt and start a new run
from current `main`. Confirm no release is running and check existing release PRs,
tags and publications first; the new run must use a new candidate and fresh checks.

For a **new** candidate, the first fetch of `main` is the cutoff. If the launcher
supplied a verified exact kickoff SHA, use that instead. A timestamp cannot recover
an earlier trigger-time commit. Capture before any potentially lengthy work. Use a
unique candidate name and an unused worktree path; never reset an existing branch:

A scheduled PortOS release coordinator must first reserve its candidate with the
server and capture its physical checkout immediately after creation. The server
chooses the branch for that active run, checks it was unused, and records the
checkout generation from Git; a supplied path or a branch name by itself does
not establish ownership. Set `RELEASE_AGENT_ID` to the registered coordinator's
ID in the following example. A release outside PortOS has no agent registration
and can leave it unset. A missing/refused registration must not be replaced by a
guessed seed or by adopting an existing checkout. Preserve the candidate and use
the normal recovery workflow if a run was interrupted before its seed was saved.
The reservation action never transfers an existing checkout. A documented
successor uses the separate recovery action below; a resumed coordinator cannot
reserve a second candidate.

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
git worktree lock --reason "Active release candidate $CANDIDATE_BRANCH" "$WORKTREE"
node scripts/link-worktree-deps.js "$PRIMARY" "$WORKTREE"
```

For an interrupted candidate, resume the original task through the service so
its completed run and active successor have matching task, instance and resume
lineage. Before touching the candidate, call the successor's endpoint:

```bash
node scripts/portos-api.js POST "/api/cos/agents/$RELEASE_AGENT_ID/release-candidate" \
  "{\"action\":\"recover\",\"predecessorAgentId\":\"$PREVIOUS_RELEASE_AGENT_ID\"}"
```

Continue only on `recovered: true`, using the returned original branch and path.
Recovery checks the original terminal head, physical Git checkout generation,
cutoff pin, release base, prepared version, forge promotion and private review
files under the ownership/retirement fence. It saves a separate transfer receipt
and an honestly timestamped seed for the successor; it never edits the original
seed, copies review files, advances a cutoff or changes a tag. A retry retains
the original transfer. A merged promotion remains merged: verify its existing
publication instead of opening another PR. Already recorded publication goes
through the existing synchronization recovery, not candidate transfer.

An unseeded candidate requires an independently captured service receipt from
the original run with the exact Git pointer and administration identities. A
creation log, matching branch/path, current inode or absent PID is insufficient.
Missing/changed evidence yields a held `releaseCandidateRecovery` projection on
the successor with a reason and safe next step. Preserve uncommitted work and
the original checkout while resolving it.

Newly registered coordinators also record the reservation and checkout capture
milestones in their service-owned lifecycle. A `registered` milestone says only
that the service observed no reservation; it does not prove a candidate was not
created through Git. It cannot authorize a resumed run to reserve another one.

**Current recovery limits:** whole-process settlement uses the existing native
Windows supervision receipt. macOS/Linux have no equivalent durable receipt yet
and remain held with `candidate-process-proof-unavailable`, including when the
original PID is absent or no process currently has the checkout as its cwd.
Historical runs missing from the trusted registry, unseeded candidates without
contemporaneous physical evidence, and unknown private review receipt versions
also remain held. V1 review evidence retains unknown inspection provenance; V2
keeps its actual inspection separate from later completion. Both are validated
with the shared receipt contract and preserved byte-for-byte, never re-certified
as a new review. POSIX settlement support remains tracked in #13944; first
reservation after a pre-reservation interruption is tracked in #14005.

Resolve the previous **published** version tag and its peeled commit from the
captured release history (not the latest tag on moving `main`). Verify the GitHub
Release, notes and tag agree. Reconcile an interrupted publication at its original
commit before attempting a new version; never move an existing tag. A concurrent
release owner or conflicting version requires reconciliation, not another release.

Before changing files or starting validation, create a metadata-only commit in the
candidate worktree with commit trailers `Release-Cut`, `Release-Base`,
`Release-Previous-Tag`, and `Release-Previous-Commit`, each carrying the exact
resolved value. For example, use `git commit --allow-empty` with subject
`chore: pin release candidate` and those trailers in its body. The parent of that
commit must equal `RELEASE_CUT_SHA`. This persists the cutoff in the candidate's
history, including after a push, interruption, or a different agent resuming.
Copy those identities, the branch and chosen version into the release PR body.

The candidate must contain the captured release-base history. Normally the previous
release has already been synchronized into `main`. For a legacy release merge not
in `main`, merge only the captured `RELEASE_BASE_SHA` into the candidate and verify
that the tree is unchanged; an unexpected content change is a reconciliation
blocker. Do not merge the latest `main` to fix ancestry. Record any such ancestry
merge in the candidate ledger.

#### 2. Prepare and validate only this candidate

Choose the version and synthesize `.changelog/v{version}.md` from the previous
published tag through the pinned candidate. Count only substantive changes in
that range for readiness (at least two); exclude metadata-only commits. Update
all version-bearing package/lock files according to their existing conventions.
Keep the named first heading described in [the changelog guide](../.changelog/README.md).
Commit preparation on the candidate, not on `main` first.

Open issues, open PRs, dependency-bot updates, and commits merged after
`RELEASE_CUT_SHA` belong to the next release. Do not sweep them in, wait for their
CI, trigger branch reconciliation, rebase on `main`, or merge `main` into the
candidate. The scheduled task's in-flight/dependency options apply only to
candidate-gating fixes. A quality snapshot already present at the cutoff is
included; a newly published snapshot goes to the next release and does not move
or delay this cutoff.

Run the documented release checks from the candidate worktree: provision
`portos_test` with `npm run setup:db:test`, run `npm run test:db`, and run
`npm run pregate -- --full` before pushing. Never use the production database.
Report any locally unavailable stage and require its CI result. Review the full
previous-published-commit-to-candidate diff, not just the preparation commit.

#### 3. Admit only evidenced release-gating fixes

A failing candidate test/build/CI check or an accepted review finding that applies
to its tree can gate the release regardless of severity. An issue's existence,
an unrelated PR, or a defect only in later `main` does not. Preserve the evidence
and fix the root cause; do not weaken tests or declare an unexplained rerun clean.

For each exception, record the failure/finding, why it applies to this candidate,
the exact fix commit(s), and validation in the PR's **Candidate amendments**
ledger. Implement the smallest fix directly on the candidate, or cherry-pick the
specific reviewed fix commit from `main` (including only necessary, separately
justified prerequisites). Never merge all of updated `main`. Preserve active
owners and normal trusted-review/admission boundaries. A broad fix that cannot be
safely isolated remains an explicit blocker; do not silently expand the release.

An amendment changes the candidate head: update the notes if needed and rerun
affected local checks, pregate, required review and full promotion CI for that
head. Merely advancing `main` changes none of these inputs and does not invalidate
candidate validation. Record candidate-only fixes for forward-porting to `main`.

#### 4. Promote the exact validated candidate

Push the candidate after pregate. Create the PR with
`--head "$CANDIDATE_BRANCH" --base release`, including the cutoff identities,
previous-tag comparison, chosen version/name and amendment ledger. A PR targeting
`release` forces full CI regardless of its head branch; require both `CI Gate`
and `Full CI Gate` on the current candidate head.

When investigating integration with a structural guard, compare the candidate
against **`origin/release`, its actual PR base**, not `origin/main`. Before
merging, verify the PR head still equals the validated candidate SHA and the
target still equals `RELEASE_BASE_SHA`. The hosting provider's rules own merge
eligibility; follow the root merge policy without adding another admission
certificate. Use a merge commit and `--match-head-commit` with the validated
head; never squash/rebase away the candidate ancestry, bypass required checks,
or use a moving `main` PR. If the target changed, reconcile the competing
release/version and resulting tree; do not recut from `main` or reuse checks on
a different tree.

#### 5. Verify publication

Read back `MERGED`, the merge commit and the remote release ref. Confirm the
promoted tree equals the validated candidate tree. Watch the Release workflow
for that merge SHA. The workflow creates the tag at its triggering SHA and
checks its tree before and after publication; never create the version tag by
hand. Verify the tag tree, version, named notes and published, non-draft,
non-prerelease GitHub Release. A merged PR alone is not completion.

A running scheduled release coordinator can persist the verified publication before
starting synchronization. POST `/api/cos/agents/:id/release-publication`
using the authenticated PortOS API transport, with JSON fields `version` (without
`v`), `promotionPrNumber`, and `workflowRunId`. The server resolves the repository
from the registered workspace, reads the candidate's metadata-only pin and ancestry
from its local Git objects, and independently verifies the merged promotion,
published stable release, successful release workflow and peeled tag tree against
GitHub. Keep the candidate objects available in that repository; missing objects
or inconclusive forge responses cannot establish publication. No supplied URL or
terminal prose is accepted as proof. Repeating the same verified publication
retains the original receipt and verification timestamp.

The agent card shows the release link and publication time as soon as the receipt
is saved, even while execution continues. This receipt verifies **publication
only**: synchronization remains explicitly unverified. After saving the receipt,
the endpoint persists a publication-keyed outbox and registers exactly one
`task-release-sync-<publication identity>` continuation on this instance. A
successful response confirms that durable task ownership; the publishing
coordinator then stops doing synchronization and may complete without waiting
for another agent slot. Every terminal agent write repeats the ownership check.
This is execution/publication completion, not end-to-end release completion.
The registered continuation is eligible without a separate `release-sync`
schedule; it remains subject to the normal owner, instance, pause, capacity and
budget controls. While synchronization or cleanup is unfinished, another
`do-release` preparation for that app waits on the existing continuation rather
than selecting a version from a development branch that still has the old version.
On a registration failure, retain the original receipt, branch/head/PR and
checkout evidence and retry the same handoff; do not create another task or
publish again. Interrupted handoffs resume through ordinary delivery recovery.
Legacy receipts are not enrolled at startup. Only an explicit publication
verification request can enroll one, retaining its original verification time;
an upgrade never silently generates new synchronization work from old releases.

The outbox keeps the original reviewer policy, publication ancestry and retained
physical checkout seeds. It never transfers checkout authority. The continuation
uses the procedure below and ordinary delivery, admission and retirement recovery.
Completed task history still owns its publication identity and cannot be deleted
through task CRUD. Execution success does **not** mark synchronization verified:
the delivery and other obligations remain pending until their evidence is observed. A bounded recovery
sweep checks the same outbox after restart, including completed task/agent history.
It records pending, running, blocked or verified synchronization separately from the
original publication timestamp and link. Transport failures retain successful
revision-bound proof and durable retry times; conflicting owners remain blocked.

Verification inspects the exact same-repository synchronization PR/head and its
merged development ancestry (including the candidate head and published promotion).
A provider-confirmed merge establishes delivery under the repository's merge
policy. The legacy local-review, hosted-review, CI and admission obligation names
record that provider authority; they do not claim that PortOS independently
re-inspected each review, check or lease after the merge. Run the requested reviews
and validation during delivery without treating an unavailable review as clean.
Keep the historical reviewed head in the private local-review receipt when later
hosted feedback changes the PR; never synthesize a missing review. Before checkout
retirement, the service retains the synchronization evidence bound to that checkout.

The development quality snapshot must include the available local numeric
measurements; an independently observed lack of local measurements is recorded
explicitly as a no-evidence result. Publication does not run providers to create
quality evidence. Runtime, runner, PID and checkout process checks establish
process settlement separately from task execution success. Every retained physical
checkout generation requires its exact service retirement receipt plus checkout
and local/remote ref absence; generic delivery/retirement recovery remains the
only writer of those receipts. No verifier merges a PR, changes a published tag,
steals a checkout, or resets a task retry budget. Status-view integration is
tracked in #13773 under #13760.

The ordinary inventoried checkout retirement service can release the exact
reviewed lock as part of its fenced removal. Its initialized-submodule and
whole-checkout counterpart currently refuses locked checkouts; retain that lock
and the checkout as an explicit synchronization hold until service-owned lock
recovery is available. A missing publisher seed cannot be recreated from a branch
name, a later filesystem observation or a historical checkout archive, so a
publication without one stays blocked on `publisher-candidate-checkout-unverified`.
Its checkpoint is retired with the operator reset below. Earlier installs could
accept an archive-backed legacy recovery; those receipts stay readable on the
outbox entry, but they no longer bind a checkout, and the entry is treated like
any other unseeded publication.

When an operator has decided to abandon a stale synchronization checkpoint and
start a fresh release from `main`, POST `{ "identity": "<identity>", "reason":
"<operator decision>", "checkouts": [{ "path": "<absolute path>", "branch":
"<branch>", "head": "<40-character SHA>", "checkoutIdentity": "<64-character
identity>" }] }` to `/api/cos/schedule/release-synchronization/operator-reset`.
`checkouts` is optional and may be empty; when cleanup is needed, include the
exact inventory tuples to release from this checkpoint's retention before the
reset. The decision is immutable, so its checkout list cannot be added later.
This host-control action refuses while a CoS release or synchronization for the same
repository is active. The operator must also check for an external release process.
It records the operator, reason and prior blocker, retires
that checkpoint's queued continuation, and allows a new release. It does not mark
the old synchronization verified, change a tag, remove a checkout, or start a
release. Other checkout identities and outstanding checkpoints retain their own gates. Inspect and clean
up any abandoned candidate separately before starting the new release.

On Windows, newly registered CLI and PTY release publishers and synchronization
agents launch inside a native Job with breakaway disabled, atomically assigned at process
creation. The supervisor retains the root's native handle and creation time and
writes a durable settlement receipt only after the root and every Job descendant
have exited. Cancellation requests terminate the owned Job and wait for the same
empty-Job proof. The server compares the original agent/start reservation and
launch identity after restart, and binds it to each server-captured checkout
generation; a recycled PID is never treated as the original process. Runner and
session checks, exact retirement receipts, review, CI and admission still apply.
Legacy unsupervised runs, lost supervisors, failed native inspection and missing
or conflicting receipts remain blocked. API-only agents without a supervised
process root also retain the explicit hold. An empty Windows cwd listing is never
a substitute for this proof.

#### 6. Synchronize back without changing the published release

After publication, the durable continuation opens a normal **`release` → `main`** synchronization PR and
merge it with a merge commit after its own required checks/reviews/admission.
This carries version metadata, notes and candidate-only fixes back to development
and preserves the release merge ancestry for the next candidate. Run the
repository-required quality snapshot after publication as a development update;
it never changes this release. If conflicts require edits, use a temporary sync branch containing the published release commit
and the current `main`, resolve them there, and merge that branch into `main`.
Preserve newer development work. Never retarget the candidate, tag, or `release`
ref to `main`, and never back-merge development commits into the published tree.

Keep synchronization failures tracked with the exact PR, owner and next step;
they do not invalidate an already verified publication or require revalidating it.
Before a subsequent release, verify the prior published release is reconciled into
development, so its version/fixes are not lost or released twice. Clean up only
owned temporary branches/worktrees after preservation and ancestry verification,
releasing only this run's worktree lock.

The final report identifies cutoff SHA, candidate SHA, amendments, promotion PR,
published tag/release URL, and the synchronization outcome. Later `main` commits
remain unreleased until the next candidate is captured.

## CI Skip

Use `[skip ci]` in commit messages to prevent CI from running (used by automation for changelog archives).
