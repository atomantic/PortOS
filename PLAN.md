# PortOS — Development Plan

The roadmap now lives entirely in the **GitHub issue tracker**:

- **Active / claimable work** — open issues labeled
  [`plan`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Aplan).
- **Parked ideas / not-yet-ready** — open issues labeled
  [`future`](https://github.com/atomantic/PortOS/issues?q=is%3Aissue+is%3Aopen+label%3Afuture)
  (speculative possibilities; promote to `plan` when one becomes a real, claimable task).

Managed by `/do:replan --issues`. For project goals, see [GOALS.md](./GOALS.md);
for completed work, see [.changelog/](./.changelog/) and `git log`.

This file no longer tracks individual tasks (so it stops generating merge
conflicts as work proceeds). Speculative ideas now live as `future`-labeled
issues rather than a list here, so they can each be promoted, refined, or closed
independently.

### SongBook follow-ups

Deferred from the SongBook feature's post-review cleanup (see
`docs/plans/2026-07-15-songbook.md`) — to be promoted to labeled GitHub issues
by `/do:replan --issues`:

- [ ] "Fit to duration" autoscroll preset: re-add an optional `scrollDurationSec`
  field to `songInputSchema` (`server/lib/brainValidation.js`) plus a preset
  button in `client/src/pages/SongBookViewer.jsx` that computes `pxPerSec` from
  the scroll container's `scrollHeight / scrollDurationSec`. Dropped from v1 as
  speculative — no UI consumed the field.
- [ ] Consolidate `server/routes/uploads.js` onto the shared `saveBase64Upload`
  / `serveLocalFile` helpers in `server/lib/fileUtils.js` (added for
  `routes/attachments.js` + `routes/brainSongbook.js`). Left out of the SongBook
  pass because uploads.js has a different response shape and uses the full
  `EXTENSION_MIME_MAP` rather than an allowlist.
  Also fix while there: `routes/attachments.js`'s 50MB cap is unreachable —
  base64 ×4/3 inflation exceeds the 55mb express.json body limit above ~41MB
  (same latent mismatch fixed in `routes/brainSongbook.js`, which now caps at 40MB).
- [ ] SongBook practice/spaced-rep integration (SM-2 style, cf.
  `meatspacePostMemory`) — the `stage` field on `songs` records is manual in v1
  (`server/lib/brainValidation.js` `songStageEnum`).
- [ ] Link songs to existing Rounds/Tracks/MIDI records — a cross-links field on
  the `songs` record + UI in `client/src/pages/SongBookViewer.jsx`.
- [ ] MIDI/score preview embedding in the SongBook viewer
  (`client/src/components/songbook/TabSheetView.jsx`). (Chord diagrams /
  fretboard rendering shipped with the instrument-view toggle, issue #2656.)
- [ ] Brain memory-bridge/graph enrollment for `songs` records (nav/⌘K already
  works via the nav manifest; this is the knowledge-graph side).

### CoS perpetual-drain follow-ups

- [ ] Close the Phase-1/Phase-3 convergence gap in the claim-issue flow. The
  perpetual work-detector (`server/services/perpetualWork.js` `isActionableIssue`)
  can only evaluate the claim prompt Phase 1 skip-list (labels/assignees/epic/
  in-flight). But the claim-issue prompt Phase 3 ("Verify still valid",
  `server/services/taskPromptDefaults/prompts.js` ~lines 552-561) releases an
  issue for reasons the detector cannot see — already-fixed/superseded, a stale
  reference to code that no longer exists, or >5 unrelated files (too big).
  Only the "too ambiguous/large" branch tags `needs-input` (which the detector
  catches); the other three release WITHOUT any converging label, so the
  detector keeps reporting them actionable and the perpetual drain re-spawns a
  no-op agent every tick (same churn class as the `[Epic]`-prefix bug fixed in
  this PR, but body/comment-driven so unfixable in the detector). Fix by making
  every Phase-3 release also apply a converging label the detector skips (e.g.
  `needs-input` for stale/ambiguous, or close+comment for already-fixed) so the
  drain parks. Prompt change → PROMPT_VERSIONS bump for claim-issue +
  claim-issue-gitlab (+ jira) with outgoing defaults preserved. Surfaced while
  diagnosing a managed-app perpetual-drain churn.

### Series review ("Review this series", #2664) follow-ups

- [ ] **Parallelize the foundation judge + canon readiness with the editorial-checks pass in `runSeriesReview`** (`server/services/pipeline/seriesReview.js`). Today foundation (a full LLM round-trip) runs to completion before `runEditorialChecks` even starts, and canon sits idle until checks finish; only the seed→read chain (feedback-seed → checks-seed → health/getReview) is a real ordering constraint. `judgeFoundation` writes only its own snapshot and `checkSeriesCanonReadiness` is store-independent, so both can be kicked off at function entry and awaited just before `computeReviewVerdict`. Deferred from the /simplify pass because it changes the SSE progress-frame ordering (foundation/canon `step:*` frames would interleave with `check:*` frames) — needs the progress emits moved to kickoff/settle and a quick UX check that the interleaved stream still reads cleanly. Largest wall-clock win (~the foundation-judge duration).
- [ ] **Hoist the pipeline `port-error/port-warning` severity palette to a shared export** and use it in `SeriesReviewPanel.jsx` (`SEVERITY_STYLES`), `AutopilotPanel.jsx` (`SEVERITY_COLORS`), and `ArcCanvas.jsx` — three byte-for-byte inline copies today. Candidate home: `client/src/components/pipeline/manuscript/constants.js`. Deferred from /simplify because it touches two files outside the #2664 diff.

- [ ] **Broaden series-review snapshot invalidation beyond the findings store.** `getSeriesReview` now stamps `stale` when the live open-finding set diverges from the snapshot's `findingIds` (covers accept/dismiss via a "Fix here" link). It does NOT detect edits to manuscript text, canon, or foundation made through other paths (the verdict's foundation/canon/health dimensions can go stale silently). Follow the `foundationJudge` pattern: stamp a `sourceInputsHash` on the review snapshot and recompute-vs-current on GET so any reviewed-source change flips `stale`. Deferred from #2664 review (codex r3, P1) as a broader pre-existing-pattern change.
- [ ] **Series-review: reject conflicting in-flight review options instead of silently coalescing.** `startSeriesReviewRun` coalesces by seriesId, so a second start with different feedback/provider/force/gate gets the running run's id and its options are dropped. Single-user/single-tab this is rare (the button disables while reviewing) and the client no longer clears the note on an `alreadyRunning` response — but a `createSseRunner` `sig`-based conflict (like storyBuilderRunner) would surface it. Deferred from #2664 review (codex r3, P2) — competing-actor/multi-tab hardening the single-user trust model largely excludes.
