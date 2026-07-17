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

### Daily-log autosave follow-ups

Deferred from the daily-log autosave PR. Autosave turned the daily-log save path
from "a couple of writes a day" into "a write every ~1.5s while typing", which
amplified several pre-existing inefficiencies on that path. The one that crossed
a policy line (an LLM summarization call per save once a day's entry outgrows the
embedding budget) was fixed in that PR by debouncing the journal re-embed
(`queueJournalResync` in `server/services/brainMemoryBridge.js`). These are the
rest — each is a perf/cleanup item, none is a correctness bug:

- [ ] Delete the dead `journals:changed` event. `server/services/brainJournal.js`
  emits it at lines ~259/298/335/356 as `{ records: await rawRecords() }`, and
  `rawRecords()` (line ~142) rebuilds the entire date→entry map (two full object
  copies of every journal day) — awaited inline before the save returns, so it
  adds latency to every autosave. Verified there is **no** `brainEvents.on('journals:changed')`
  listener anywhere in the repo; `brainMemoryBridge.js:633` documents that it
  deliberately stopped listening. `brainEvents` is an in-process EventEmitter
  (`brainStorage.js`) with no cross-install surface, so removal is compat-safe.
  `server/services/brainJournal.test.js:141` asserts the emit and must be updated.
  Skipped in the autosave PR as pre-existing dead-code cleanup outside its scope.
- [ ] Cache the Obsidian sidecar. `loadObsidianLocations()`
  (`server/services/brainJournal.js:85`) is `ensureDir` + `readJSONFile` with no
  cache, called from `getEntry`, `putEntry`, and `rawRecords` — ~3 uncached file
  reads + 3 `mkdir` syscalls per save, now once per autosave. Mirror the
  write-through cache `brainStorage` already uses (`CACHE_TTL_MS = 2000`). Fixing
  the item above removes one of the three call sites for free.
- [ ] Serialize `scheduleObsidianSync` per date (`server/services/brainJournal.js:238`).
  It rewrites the day's full markdown note fire-and-forget on every save, and its
  own comment notes Obsidian lives on iCloud where "writes can stall for hundreds
  of ms" — so at autosave cadence, overlapping writes to one file are possible and
  last-writer-wins isn't guaranteed to be newest-content. Only affects installs
  with the "Auto-mirror to Obsidian on every save" toggle on. Consider also
  re-wording that toggle's label, whose "every save" now means something new.
- [ ] Close the dictation/autosave overwrite race properly. Today the client
  *parks* autosave when a voice segment lands while the user has unsaved edits
  (`voiceConflict` in `client/src/components/brain/tabs/DailyLogTab.jsx`), because
  `setJournalContent` replaces content wholesale and would drop the segment. The
  park cannot close the narrow race where a segment lands server-side *after* a
  PUT is already in flight. Deeper fix: merge the incoming segment into the
  textarea client-side (the socket payload carries `text`, and the `!dirty` branch
  already performs exactly that merge — this would delete the flag and its ~6 touch
  sites), backed by an `updatedAt` precondition on the PUT so the server rejects a
  stale overwrite instead of the client predicting it. `updatedAt` is already
  stamped and already kept client-side; no precondition mechanism exists server-side
  yet (no `If-Match`/`ifMatch` anywhere). Needs real-device validation of caret
  behavior when the textarea is rewritten under the user — that risk is why it was
  not done unilaterally in an autosave PR, and it reverses the deliberate existing
  "save or refresh to see it" product decision.
- [ ] Extract a `useAutosave` hook when a second consumer appears. The daily log
  now has ~60 lines of autosave machinery inline (debounce + max-wait ceiling +
  single-flight + failure-toast dedup + blur/visibility/unmount flush). The only
  other debounced-save site, `client/src/pages/VideoTimelineEditor.jsx:281`
  (`saveTimerRef`/`queueSave`), shares only "setTimeout + clearTimeout on cleanup"
  and diverges on every other requirement — so extraction at N=2 would be ~6 config
  knobs wrapping ~5 lines. Revisit at a third consumer.

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

- [ ] **Make Avatar Bio extraction tolerant of free-form twin documents.** `server/services/digital-twin-avatar-bio.js` extracts facts with helpers keyed to the shipped canonical doc structure (`**Name:**`, `## Core Purpose`, `## Reasoning Defaults`, the enrichment `### Question?` headings, etc.). Installs whose enabled Markdown does not use those exact labels/headings fall through to the "No … data yet" fallbacks even when the twin is richly populated (the document CRUD schema accepts arbitrary Markdown, and `data.reference/digital-twin` ships no enforced body template). Current behavior degrades gracefully (safe fallbacks, no crash, no wrong data) and the LLM-polish path is an escape hatch, so this was deferred from the #avatar-bio review (codex P1). Options: (a) feed the raw enabled-doc text to `polishAvatarBio` so the LLM can synthesize regardless of structure; (b) introduce and migrate a versioned canonical body format for the core docs; (c) add a light LLM-backed extraction fallback when structured parsing yields empty sections.

### POST timezone follow-ups (#2681)

- [ ] **Re-derive POST day keys from timestamps at read time (or re-normalize on timezone change).** #2681 made POST records store their `date` in the user's configured timezone (writers) and read "today" in that zone (readers: `getPostStats`/`getPostProgress`/`getUnifiedActivityStreak`/`getTrainingStats`/`getMorseProgress`, plus the client). Migration 192 re-keys existing records once. The residual gap: a stored `date` is frozen in the zone that was active when it was written, so if the user *changes* `settings.timezone` after accumulating history, the old day keys disagree with the new-zone readers (a session saved as `2026-07-15` in LA reads as incomplete-today after switching to UTC). The reminder path (`meatspacePostReminder.js` `firePostReminderIfIncomplete`) is already immune because it derives the day from each record's `startedAt`/`timestamp` at read time via `isOnLocalDay(instant, tz)` — NOT the stored `date`. Two fix options: (a) apply that same read-time derivation in the streak/stats/history readers — map each record to `{ ...r, date: localDay(r.startedAt||r.completedAt||r.timestamp, tz) }` before it reaches `computePostStreaks`/aggregation, making the stored `date` a cache the readers ignore (comprehensive, no re-normalization ever needed, but touches every reader + the pure-helper integration and needs careful test updates); or (b) subscribe to the `settings:updated` timezone-change event (there's already `timezoneUpdatedAt` infra) and re-run migration-192-style normalization through the services' load/save paths (must NOT raw-write the files — that bypasses service caches, see the "sync direct-write bypasses cache" precedent). Deferred from #2681 review (codex r6, P2) — an uncommon tz-change-after-history scenario whose correct fix is a sizable, separately-reviewable refactor against real POST data; the steady-state configured-tz behavior shipped in #2681 is fully covered. Note: codex's r6 claim that the reminder recomputes `startedAt` in UTC is factually wrong — it already uses `getUserTimezone()`.

### Brain Graph touch-interaction follow-ups

- [ ] **Give 3D graph nodes a finger-sized hit target.** `client/src/components/brain/tabs/BrainGraph.jsx` `GraphScene` raycasts against the node `<mesh>` spheres directly (radius `0.4 + importance * 0.8`), so on a phone a low-importance node is a ~10px target — well under the ~44px touch guidance, and tapping usually selects a neighbour or nothing. Options: an invisible larger companion sphere per node that carries the pointer handlers (cheap, but doubles the mesh count and overlapping halos make "nearest wins" ambiguous in a dense cluster), or a custom nearest-node-within-threshold pick in screen space on tap. Deferred from the mobile-responsive pass because it changes the 3D pick model (not layout) and wants real-device validation — jsdom/headless can't exercise a WebGL raycast, and the layout fixes stand on their own.
- [ ] **Stop feeding the tooltip position on pointer moves that can't show a tooltip.** `client/src/components/brain/tabs/BrainGraph.jsx` sets `onPointerMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}` on the canvas container, so every mouse/finger move re-renders `BrainGraph` — even though `hoveredNode` is null for most moves (sparse spheres, and every orbit-drag), and on touch the tooltip is now `pointer-coarse:hidden` and can *never* paint, making it 100% waste on the weakest hardware. Memoizing `GraphScene` (done) already bails the ~200-element mesh subtree out of those renders, so what's left is the component's own render. The gate must use a **ref**, not `hoveredNode` state: r3f attaches its raycasting listener to the Canvas's own inner div while React delegates `onPointerMove` at the app root, so on the event that enters a node the `onPointerMove` closure still sees `hoveredNode === null` and would skip the position update the tooltip needs — stranding the first frame at a stale position (or `{0,0}` on the first-ever hover, if the user enters a node and holds still). Safest shape: have `GraphScene`'s `onPointerOver` pass `e.clientX/e.clientY` up so `handleHover` seeds `tooltipPos` at enter time, then gate the move handler on `hoveredRef.current`. Deferred from the mobile-responsive pass because it's an unverifiable path here — the tooltip only appears on a WebGL raycast hover, which neither jsdom (the test stubs `<Canvas>`) nor a headless run can exercise, and a wrong ordering assumption regresses the very tooltip the pass was fixing. Needs real-device/browser validation.
- [ ] **Give `MemoryGraph.jsx` the same mobile treatment as BrainGraph.** `client/src/components/cos/tabs/MemoryGraph.jsx` is a near-literal fork of BrainGraph's canvas shell — same `Canvas`+`OrbitControls`, same `buildGraph` from `lib/graphSimulation`, same `dragStartRef`/`onPointerMove`→`setTooltipPos` wiring — and still carries all three defects the Brain Graph mobile pass fixed: `style={{ height: '500px' }}` (line ~219), the always-on `absolute bottom-3 left-3` legend (line ~241), and the unclamped `max-w-xs` tooltip at `left: tooltipPos.x + 12, top: tooltipPos.y - 12` (line ~267). `/cos` is in `Layout.jsx`'s `isFullWidth` list, so it has the same landscape-overflow exposure. Do NOT extract a shared `<GraphCanvasShell>` — only two call sites and the surrounding chrome has genuinely diverged (BrainGraph has a breadcrumb, seven type filters, search, embeddings banner, detail panel; MemoryGraph has a stats bar); port the fixes across instead. Deferred from the Brain Graph pass to keep that PR scoped to the page the work was requested for.
- [ ] **Decide the touch scroll story for the graph canvas.** R3F sets `touch-action: none` on the canvas, so the graph is a dead zone for page scrolling — a one-finger drag rotates the camera and never scrolls. The mobile pass bounded the damage by making the canvas viewport-relative (`h-[clamp(240px,45vh,500px)]`), leaving the bars above and detail panel below as scrollable surfaces, but a user who starts a swipe on the canvas still can't scroll. Considered and rejected for this PR: the map-embed pattern (one finger scrolls, two fingers rotate, via OrbitControls `touches={{ ONE: … }}`) — it would make rotating the graph, which is the feature's whole point, a two-hand gesture. Worth revisiting with a real device: possibly a "drag to rotate / two-finger to scroll" hint on first touch, or an explicit fullscreen mode where the canvas legitimately owns all gestures.

### PortOS-update / CoS-agent mutual-exclusion follow-up

- [ ] **Gate every CoS spawn engine on `updateInProgress` so a scheduled/autopilot spawn can't start during a PortOS self-update.** The update flow now blocks `POST /api/update/execute` when a CoS agent is live or mid-spawn (`server/routes/update.js` `countActiveCosAgents`, fast-fail + post-lock re-check via `getActiveAgentIds()` + `spawningTasks`), and the Update tab suppresses restart buttons while agents run. Residual: an agent that begins spawning *after* the route's post-lock re-check but before `update.sh` reaches its `pm2 delete` (a multi-second window covering git pull / submodules / npm install) is still severed. Fully closing it means having the spawn side consult the update lock: add a synchronous in-memory `isUpdateInProgress()` mirror to `server/services/updateChecker.js` (kept in lockstep with the persisted flag in `setUpdateInProgress`) and have the CoS spawn engines skip-and-requeue (return the existing `SPAWN_DEDUP_SKIP`-style no-op, leaving the task queued for after the restart) when it's set. **This must cover ALL spawn engines, not just `spawnAgentForTask`** — per the CoS autonomous-spawn precedent, gating one chokepoint gives false confidence; audit `dequeueNextTask` / `evaluateTasks` / `executeScheduledJob` and the Creative Director / on-demand bridges (grep the spawn call sites in `server/services/agentLifecycle.js` + `subAgentSpawner.js` + `cos*.js`). Deferred from the codex review of this PR (r2 P1) because it's a CoS-subsystem change spanning multiple spawn paths that deserves its own focused PR + tests; the 409 guard, post-lock re-check, and the orphan reaper bound the residual exposure in the meantime.

### Antigravity CLI prompt-delivery follow-up

- [ ] **Handle `agy` + non-empty `extraArgs` so the prompt stays the LAST argv token.** `agy --print` takes the prompt as its VALUE, so `ensureAntigravityPrintArgs` puts `--print` last and `prepareAntigravityPrompt` (via `prepareCliPrompt`, `server/lib/antigravity.js` / `server/lib/cliProviderArgs.js`) splices the prompt right after it. But `cliProviderRun.js` builds `[...buildCliArgs(provider), ...extraArgs]`, so for an antigravity provider with a non-empty `extraArgs` the delivered argv becomes `… --print "<PROMPT>" <extraArg…>` — the prompt is still `--print`'s value (correct), but any trailing extraArgs become positional args agy may reject. Low risk today (no caller passes `extraArgs` for an antigravity provider), but if one is added, either strip/relocate the trailing `--print` marker so extraArgs precede it, or have `prepareAntigravityPrompt` move `--print <prompt>` to the very end after splicing. Deferred from the agy prompt-delivery fix — the shipped paths (CD plan via runner/direct, Run Prompt, ask, vision) pass no extraArgs and are validated end-to-end.

### CoS stat-card follow-ups

- [ ] **Retire or wire up `StatCard`'s never-passed `activeLabel` prop, and de-dup the two hand-rolled Learning cards.** `activeLabel` (`client/src/components/cos/StatCard.jsx:1`) has **zero callers** across the client — no `activeLabel=` usage and no spread props into `<StatCard>`. It is *visually* rendered only by the default variant (:59-63); the `compact` (:4-22) and `mini` (:24-42) variants honor it only through the `ariaLabel` interpolation at :2 (consumed via `aria-label` at :8 / :28) — i.e. it reaches the accessible name but is never displayed. So it is not fully inert: deleting it changes the accname on two variants. Either delete the prop + its render branch + the `ariaLabel` clause together, or make compact/mini render it. Related: the two Learning cards (`client/src/pages/ChiefOfStaff.jsx` ~512-540 compact, ~836-862 ascii `mini`) are hand-rolled buttons rather than `StatCard`s precisely because StatCard supports neither `onClick` nor a status-driven border color nor a visible sub-label on the compact variant — and each duplicates the same `status === 'critical' ? … : 'warning' ? …` color ternary twice (once for the border, once for the icon). Wiring a visible sub-label slot through all variants plus `onClick`/border-tone props would let both collapse onto StatCard. Deferred from the mobile-overflow fix (which only restructured the compact card's value/label stacking): removing or re-speccing a prop on a shared component used by every CoS stat card is a distinct refactor deserving its own PR + tests, and the overflow fix must not ride on it.

### Creative Director agents should not push code (deferred — needs a distinct completion contract)

- [ ] **Suppress `/simplify` + `/do:push` + PR in CD agent completions WITHOUT breaking their API output contract.** CD plan/treatment/evaluation agents persist their real output via an HTTP call in the task BODY (e.g. `PATCH http://localhost:5555/api/creative-director/{id}/plan` — see the plan prompt), and use the `.agent-done` sentinel only as a *done-signal* (a short markdown summary that PortOS's 2s poll consumes to finalize the run). They run on `main` (`useWorktree:false`, `configCodingOnMain:true`) and make no repo changes, so the trailing `/simplify` → `/do:push` completion is both pointless and dangerous (a `/do:push` on main could commit stray working-tree files). The fix must remove `/simplify`+`/do:push`+PR from the CD completion while KEEPING (a) the sentinel done-signal handshake and (b) the task-body PATCH as the output channel. **Do NOT reuse `discardWorktree`** — codex review (2026-07-16) correctly flagged that it routes to `buildProgrammaticOutputCompletionSection`, whose wording ("your *only* output channel is the `.agent-done` sentinel; write your result there in the payload format from your instructions") directly contradicts the PATCH and could make the agent write the plan to the sentinel instead of PATCHing → plan never persists → project stalls/re-enqueues. `readOnly:true` is also wrong ("read data and report findings only" contradicts the PATCH, and the CLI read-only path emits no sentinel). The correct fix is a NEW completion contract (e.g. a `apiOutput`/`noRepoOutput` metadata flag) that emits: "This task persists its output via the API/tool calls described above and makes no repo changes — do NOT run `/simplify`, `/do:push`, `/do:pr`, `git commit/push`, or open a PR; when done write a short summary to the sentinel to signal completion." Thread the flag through the completion selection in `server/services/agentPromptBuilder.js` (lines ~1137-1160 light path + the full-context path ~790, and whichever of `buildTuiCompletionSection`/`buildCliCompletionSection` CD actually reaches — confirm via a regenerated CD prompt fixture) and add a test asserting the CD prompt contains the sentinel step but NO `/do:push`/`/do:pr`/`/simplify`. Deferred from this PR because it needs a carefully-designed prompt-contract change + fixture test, not a rushed flag reuse.
