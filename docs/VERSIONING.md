# Versioning & Release Process

PortOS uses semantic versioning. Bump the major version for breaking changes, the
minor version for new features, or the patch version for fixes. Only an authorized
`/do:release` updates the version in `package.json`.

| Branch | Purpose |
| --- | --- |
| `main` | Active development |
| `codex/release-*` | Candidate frozen at the release cutoff |
| `release` | Publication branch |

## Workflow

### Regular Development

Cut a feature branch from `origin/main`, use descriptive commit messages, and open a
PR into `main`. Commit messages are the source for release notes. Leave
`.changelog/RELEASE.md` to the release workflow.

Run `npm run pregate` before every push and again after rebasing. The
[CI workflow](../.github/workflows/ci.yml) runs impact-scoped checks on PRs into
`main`, broader checks after merges and on a schedule, and the full plan on PRs
into `release`. See [native CI coverage](GITHUB_ACTIONS.md#native-jobs-on-a-push-to-main)
and the [merge policy](../.claude/skills/portos-ship/SKILL.md#merge-authority).

### Creating a Release

This project procedure takes precedence over slashdo's generic release recipe.
Use a dedicated candidate branch and worktree. Managed release coordinators follow
the [release operations commands](../.claude/skills/portos-ship/release-operations.md)
for checkout ownership and recovery via
`POST /api/cos/agents/:id/release-candidate`.

#### 1. Check publication activity, then capture the cutoff

Check for an active release or synchronization owner, open promotion PR, unfinished
release workflow (including reruns), and a tag for the proposed version. Resolve any
active or interrupted publication before starting another. Recheck the proposed tag
once the version is chosen. Leave prior checkouts and tags intact.

Use the verified kickoff SHA when supplied. Otherwise, the first fetch of `main`
sets the cutoff. Keep that cutoff after interruption. Never merge or rebase
later `main` into the candidate, and leave unrelated queued work to the next
release. Capture the `release` base SHA and verify the previous **published**
tag, peeled commit, notes, and GitHub Release against that history. Put a metadata-only
commit directly on the cutoff with these exact trailers, and copy the identities
to the promotion PR body.

- `Release-Cut`
- `Release-Base`
- `Release-Previous-Tag`
- `Release-Previous-Commit`

If the captured release base is missing from the candidate's history, merge that
exact base only after confirming the resulting tree is unchanged. Record the
ancestry merge in the PR. Reconcile unexpected content before proceeding.

#### 2. Prepare only this candidate; hosted CI validates it

Count at least two substantive changes since the last published tag. Choose the
version, update the version-bearing package and lock files, and overwrite
`.changelog/RELEASE.md` with the named notes for the candidate. Its first heading
must match the version in `package.json` and the file must stay under 100 KB.
Follow the [changelog guide](../.changelog/README.md). Commit the preparation in the
candidate worktree.

Before each candidate push, run only the ordinary `npm run pregate`. Do not run
`npm run test:db` or `npm run pregate -- --full` as a release step. Reproduce a
failing hosted job locally only as needed, with DB tests confined to `portos_test`.

Use the cutoff as the review base. Work through the cutoff is not reviewed again.
Still read the commit log of the whole range for the version, notes and readiness.
Later commits and a newly published quality snapshot belong to a future release.

#### 3. Admit only evidenced release-gating fixes

A failing candidate check or accepted finding that applies to the candidate can
gate the release. Apply a bounded fix directly or cherry-pick the specific reviewed
fix with justified prerequisites. Keep the cutoff fixed and record the finding,
applicability, exact commits and validation under **Candidate amendments** in the
PR. Repeat focused tests, pregate, amendment review and promotion CI on the new head.
Carry any candidate-only fixes back to development during synchronization.

#### 4. Promote the exact validated candidate

Open a PR from the candidate into `release`. The release PR forces the complete
hosted CI plan. For promotion, require both `CI Gate` and `Full CI Gate` green on the current
candidate head before merging. Check that the base still matches the captured
release base and pin the merge commit operation with `--match-head-commit`.
Preserve ancestry with a merge commit and follow the forge's protections.
Reconcile a moved base before promotion.

#### 5. Verify publication

Read back the merged PR, the promotion merge commit and the remote release ref.
Verify the promoted tree equals the validated candidate and watch the
[Release workflow](../.github/workflows/release.yml) for that merge SHA. It creates
the tag and publishes the stable GitHub Release from the named notes. If the notes
file is absent, it falls back to the commit log. Verify the successful workflow
and published release, including the tag tree, version and named notes.

For CoS, record publication using authenticated
`POST /api/cos/agents/:id/release-publication` with `version` (without `v`),
`promotionPrNumber`, `workflowRunId`, and `synchronizationMode: "inline"`.
Keep the candidate Git objects available for server verification. If interrupted,
resume the original task and reverify the same publication. See the
[agent API transport](AGENT_API_KEY.md).

#### 6. Synchronize back without changing the published release

Open a normal PR into `main` from a temporary `codex/release-sync-<id>` branch
containing the published merge commit. Use the reserved branch and checkout for a
managed release. Using `release` itself as the PR head would let GitHub delete
the publication branch after merging. Resolve conflicts in the temporary branch,
preserving newer development work and the published ancestry.

Run the sync PR's checks and requested reviews. Merge with a merge commit and
verify that the candidate and published promotion are ancestors of development,
and that the development version is at least the published version with an
agreeing lockfile when required. For older managed runs, recover an ambiguous
review policy from the original prompt, delivery policy and revision-bound
review receipts. See the [checkpoint recovery procedure](../.claude/skills/portos-ship/release-operations.md#recover-synchronization-checkpoints).

Operators can reconcile an independent merged back-merge via authenticated
`POST /api/cos/schedule/release-synchronization/verify-delivery` with
`identity` and `prNumber`. After explicitly deciding to abandon a stale
checkpoint, use `POST /api/cos/schedule/release-synchronization/operator-reset`
with `identity` and `reason`, as described in the recovery procedure.

Run `npm run quality:snapshot` after publication as a separate development update
on the install with audit evidence. Keep synchronization failures tracked with
the owner and PR. Clean up only owned temporary work after verifying delivery.
Report the cutoff and candidate SHA, amendments, promotion PR, tag and release
URL, and synchronization outcome.

## CI Skip

Automation commits can use `[skip ci]` in the commit message to skip CI where
the workflow supports it.
