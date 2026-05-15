# Unreleased Changes

## Added

- **Pipeline — per-issue length profile, per-stage gen config, comic front cover.**
  Three additive pipeline-UX features rescued from a pre-crash recovery branch
  and cherry-picked into main:
  - **Length profile picker** in the pipeline issue header. Sets
    `issue.lengthProfile` (`teaser` / `standard` / `extended` / `finale` /
    `custom`) plus optional `pageTarget` + `minutesTarget`. New
    `server/lib/issueLength.js` materializes the profile into prompt-template
    variables (`{{lengthTargets.profile}}`, `pageTarget`, `minutesTarget`,
    `proseWordsMin/Max`, `beatsMin/Max`) that the idea, prose, comic-script,
    TV-script prompts now consume — beat counts, prose word ranges, and page
    counts scale with the picked profile instead of being hardcoded to 22
    pages / 24 minutes. The season-episodes generator emits a `lengthProfile`
    per episode so a finale auto-scales without manual tweaking.
  - **Per-stage generation settings.** New gear-icon modal in the issue
    header on the **Storyboards** tab exposes `imageMode` (`auto` / `local` /
    `codex`), pinned local image model, and a refine-LLM override. Persisted
    on `stages.<stageId>.genConfig` so reloads keep the user's choice; the
    Comic editor (`comicScript` tab) keeps its existing image-gen drawer so
    the gear stays off that tab to avoid duplicate controls. The same
    `genConfig` shape persists on `stages.comicPages.genConfig` as well —
    threaded through `generatePipelineComicPage`,
    `generatePipelineVisualImage`, and the two refine-prompt endpoints —
    so a future header-gear extension to the Comic tab can opt in without
    a schema change. Visual stages' server resolver now defaults to codex
    when `imageGen.codex.enabled` (still falls back to local diffusion
    otherwise).
  - **Comic-issue front cover.** Optional cover concept per issue persisted
    on `stages.comicPages.cover` (`script` + `imageJobId` + `prompt`). New
    `POST /pipeline/issues/:id/stages/comicPages/cover/render` route builds
    the cover prompt server-side (series masthead + issue-number tag + the
    user's concept) and enqueues an image-gen job; the cover card sits
    above the page list in the Comic tab (the merged Comic editor).
  - **Comic-script parser** now recognizes an optional `## Cover concept`
    section and the simpler `Panel N` / `Field:` plain-line format the
    updated prompts emit, alongside the legacy `### Panel N` /
    `**Field:**` form. `parseComicScript` returns
    `{ coverConcept, pages: [{ rawText, panels }] }`.

- **Shell — UUID-based URLs for each sub-shell session.** The shell page now
  mounts at `/shell/:sessionId` in addition to `/shell`, and mirrors the active
  session id into the URL whenever a session is started, attached, or switched.
  Reload preserves the active shell, the URL is shareable as a deep link, and
  browser back/forward + manual URL paste switch between live sessions.
  Stopping or killing the active session (or its PTY exiting with no remaining
  sessions) clears the URL back to `/shell`. The pre-existing `?session=<uuid>`
  query-param (one-shot "attach to this session") still works alongside the
  new path param.
  - **Attach-failure recovery.** Switching sessions no longer pre-clears the
    displayed session — `sessionIdRef` only swaps on `shell:attached`. If the
    target session dies between list read and attach (race), `shell:error`
    restores the URL + terminal to the previously displayed session (or falls
    back to a live survivor) instead of stranding the UI on a dead URL.
  - **Multi-tab handoff notification.** Opening the same `/shell/:sessionId`
    in a second tab takes over the PTY socket (single-subscriber by design).
    The server now emits `shell:detached` to the previous socket so the
    original tab clears its disconnected view + navigates back to `/shell`
    instead of sitting "Connected" with no output.
  - **Auto-pick won't steal an attached session.** Session list entries now
    carry `attached: boolean` from the server. Every auto-pick path on the
    client (initial load, external-kill fallback, shell:exit fallback,
    shell:error recovery) filters survivors to ones that aren't already
    driving another tab. Manual tab clicks and deep-link URL navigation
    still take over (intent is explicit). Prevents tab B from booting
    tab A off its shell when tab B's session is killed externally.
  - **`attached` is recipient-relative.** `listAllSessions` and
    `broadcastSessionList` now personalize each subscriber's payload so
    `attached` only reports `true` when the session is bound to a
    *different* socket. Sessions bound to the recipient's own singleton
    socket (e.g. sessions opened earlier in this tab that stayed bound
    when the user navigated away and back) report `attached: false`, so
    the client's auto-pick path adopts them on return instead of leaving
    bare `/shell` disconnected.
  - **Pending-attach gate.** A new `pendingAttachRef` tracks the in-flight
    start/attach target. While set, keystrokes and quick commands are
    dropped (so input doesn't land in the previous session during the
    "Attaching…" window), incoming `shell:output` is suppressed (so the
    old session's stream doesn't paint into the cleared terminal), and
    stale `shell:attached` responses for an older target are ignored when
    the user rapid-fire-clicks tabs.
  - **Start-failure error message preserved.** When `shell:error` fires
    from a start attempt while an existing session is still alive (e.g.
    session limit hit), `handleShellError` no longer re-attaches and
    repaints the terminal — the error stays readable. Re-attach recovery
    now triggers when the URL diverged from the active session (URL-nav
    switch failure) OR when `pendingAttachRef` was for a different session
    at the time of error (tab-click switch failure — URL never moved
    because `activateSession` never fired). The start-failure path
    (`pendingAttachRef === 'new'`) leaves the terminal untouched so the
    error message survives.
  - **Layout full-width includes deep links.** `Layout.jsx` matches both
    `/shell` and `/shell/<id>` for full-height/overflow-hidden styling so
    deep-linked terminals render edge-to-edge like the bare route.
  - **Server-side claim semantics for auto-pick.** Client auto-pick paths
    (initial load, external-kill recovery, shell:exit fallback, error
    fallback, bare-/shell adoption) now send `shell:attach` with
    `claim: true`. The server's `attachSession` honors it — if the session
    is bound to a different socket, the attach is refused with a
    `claimRejected` result and the client gets `shell:error` with
    `sessionId` for correlation. Manual paths (tab click, deep-link URL)
    still default to `claim:false` (takeover semantics). Prevents two
    idle tabs receiving the same `shell:sessions` broadcast from racing
    to attach the same survivor and booting each other.
  - **Strict-equality pending tracking.** Replaced the simple
    `pendingAttachRef` with a `{ target, generation }` shape and helpers
    `setPendingAttach` / `cancelPendingAttach`. Response handlers
    (`handleShellAttached`, `handleShellStarted`) consume only when
    target matches exactly, so a cancelled-mid-flight attach can't
    re-navigate after Stop. Deferred work (setTimeout fallbacks) captures
    generation and aborts if the user changed their mind during the
    delay window.
  - **Server-correlated attach errors.** `shell:error` from `shell:attach`
    failures now carries the requested `sessionId`. The client matches it
    against `pendingAttachRef.current.target` to recover the correct
    request and ignores stale errors from earlier rapid clicks. Passive
    errors (`shell:input` to a missing session) carry sessionId too but
    don't match a pending request, so they don't mutate pending state.
  - **Intentional vs passive idle preserved across reconnect.** Initial-
    load auto-attach (which also runs on every reconnect because
    `handleConnect` resets `hasInitializedRef`) gates on `!userIdleRef`,
    and the empty-list auto-start branch does too. A transient
    disconnect no longer re-adopts a session — or spawns a new one —
    that the user had explicitly stopped.
  - **handleShellExit / Detached / external-kill respect pending.** When
    the displayed session dies but the user has an attach in flight to a
    different session, the recovery handlers now skip their auto-pick
    fallback and let the pending request complete. Previously,
    `clearActiveSession` was implicated in cancelling the user's
    in-flight switch by tearing down pending state alongside the
    displayed session.

- **Universe Canon page — lock toggle, tag chips, and "from series" badge on every card.**
  Phase 2a of the Universe-as-Canon UI. Each `CanonCard` (used on both the
  Universe Canon page and the per-series Nouns page) now renders:
  - A **Lock / Unlock** button (only on pages that pass `onToggleLock`; the
    Nouns page omits it since per-series canon doesn't have universe-level
    locks). When the entry is locked, the card border picks up the accent
    color, a `Locked` pill appears next to the name, the "AI: differentiate"
    button disables with an "Unlock to refine" tooltip, and the toggle button
    flips to "Unlock" with an unlock-icon glyph.
  - A `from series` badge (titled with the introducing series id) when the
    entry's `sourceSeriesId` is set — so a user scanning the universe
    immediately sees which canon came from prose extraction vs. universe
    expand or manual authorship.
  - A row of tag chips when `entry.tags[]` has items — surfaces the
    `landscape` / `vehicle` / etc. tags the categories→canon backfill
    stamps, plus any tags the user adds later.
  New client helper `setUniverseCanonLock(universeId, kind, entryId, locked)`
  calls the Phase 1 `PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock`
  route. ESLint clean, Vite production build green.

- **Universe-as-Canon lock semantics — series-extracted canon arrives auto-locked.**
  Every canon entry on a universe (characters/settings/objects) can now carry a
  `locked: true` flag, plus `prompt`, `tags`, `source`, and `sourceSeriesId`
  fields. When a series with a linked universe runs prose extraction (`prose`
  stage auto-extract or the `/extract-bible` route), every NEW canon entry it
  inserts is stamped `source: 'series-extract'`, `sourceSeriesId: series.id`,
  and `locked: true`. This protects an active series's canon from being
  silently rewritten by a later refine / re-extract / differentiate-cast pass
  against the universe — the human operator unlocks the entry first when they
  want regeneration to touch it.
  - **Refine + Differentiate honor locks.** `POST /:id/characters/:entryId/refine`
    returns 409 (`UNIVERSE_CANON_LOCKED`) on a locked character. The
    `differentiate-cast` flow sends the full cast to the LLM (so unlocked
    rewrites stay distinct from locked descriptions) but discards rewrites
    targeting locked ids at apply time — locked `physicalDescription` round-
    trips verbatim. New `skippedLocked` count surfaces alongside the existing
    `touched` / `skipped` counts in the response.
  - **`mergeExtractedBible` lock-aware semantics.** Locked entries pass
    through narrative-field overwrites intact; only `evidence[]` is appended
    (deduped) so the crossover trail still grows across multiple extractions.
    `firstAppearance` and `missingFromProse` are not touched on locked
    entries.
  - **Categories→canon backfill on first read.** v1 universes (no
    `schemaVersion` on disk) load through `sanitizeTemplate` and have every
    `categories[key].variations[i]` copied into the matching canon array as a
    new entry — characters → `characters[]`, landscapes/environments →
    `settings[]` (tagged `landscape` / `environment`), vehicles/structures →
    `objects[]` (tagged `vehicle` / `structure`), and any custom category
    bucket flows into `objects[]` tagged with the bucket name. The migration
    is idempotent (`schemaVersion: 2` stamped after first read and persisted
    so user-renamed entries survive subsequent loads). Categories continue to
    coexist with canon arrays during the UI transition; a follow-up retires
    `categories` once the UI reads canon directly.
  - **New lock-toggle route.** `PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock`
    with `{ locked: boolean }` toggles a single entry's lock. Unlock strips
    the field entirely so the on-disk shape stays minimal (only `true` is
    persisted, mirroring the variation pattern).
  - **Source vocabulary.** Legacy `source: 'user' | 'ai' | 'imported'`
    accepted on read for back-compat; new universe-canon writes use the
    semantic `source: 'universe-expand' | 'series-extract' | 'manual'`
    vocabulary. Writers-room flows continue to write the legacy values, so
    the existing badge UI in `CharactersBible.jsx` / `SettingsBible.jsx` /
    `ObjectsBible.jsx` is unaffected.
  - **Tests.** 8 new storyBible cases (sanitizer extras + lock-aware merge +
    autoLock provenance), 3 new universeBuilder cases (backfill + idempotence
    + no-overwrite), and a new `universeCanon.test.js` file with 10 cases
    covering `setCanonEntryLock` + refine refuses locked + differentiate
    skips locked + extract autoLock pass-through. Full server suite (4,525
    tests) passes.

- **TUI providers — codex, claude code, gemini in attachable shells.** New
  provider type `tui` runs CoS agents inside a PTY-backed shell session that
  the user can attach to mid-run from the Shell page (`/shell?session=…`).
  Ships disabled-by-default entries for `codex-tui`, `claude-code-tui`, and
  `gemini-tui` in `data.sample/providers.json`; existing deployments pick
  them up automatically because `scripts/setup-data.js` now JSON-merges new
  `providers` entries on update (same starter-merge pattern as
  `prompts/stage-config.json`). The Shell page's quick-command toolbar also
  gains a `gemini` button alongside the existing `claude` / `codex` buttons.

- **Universe canon — characters, places, and objects on the universe.** Phase A
  of the Universe-as-canon refactor. `universe.characters[]`/`settings[]`/
  `objects[]` arrays now live on the universe record alongside the existing
  prompt-template categories (additive — existing universes load with empty
  canon arrays). New routes:
  - `POST /api/universe-builder/:id/extract-canon` — pulls characters/places/
    objects from a prose body and merges into canon. Mirrors the series-side
    bible extractor.
  - `POST /api/universe-builder/:id/characters/:entryId/refine` — single-
    character rewrite (same prompt as the series-side refine).
  - `POST /api/universe-builder/:id/characters/differentiate-cast` — one LLM
    call rewrites every character's `physicalDescription` to push the entire
    cast apart on ethnicity/age/build/hair/wardrobe so no two characters
    render visually interchangeable. New prompt template
    `pipeline-character-differentiate-cast.md`.

  A new **Canon** page (`/universe-builder/:universeId/canon`) accessed via
  the Library button on the Universe Builder header surfaces all three
  operations + per-entity reference renders + click-to-preview thumbnails.
  Shared `CanonCard` component used by both the Universe Canon page and the
  per-series Nouns page (the per-series view stays alive until Phase B
  migrates series.cast → universe references).

  Image-delete now purges canon refs from both the series store AND the
  universe store, so deleting a reference image from the gallery cleans both.

- **Pipeline Issue — merged Comic Pages tab.** Comic Script + Comic Pages are
  now one tab labeled *Comic Pages*. Each row is a per-page editable markdown
  textarea on the left and the rendered full-page comic image on the right.
  Generating from prose auto-splits the script into pages. Panels are still
  parsed internally so the image prompt stays high-quality, but the
  panel-level UI is gone — the user only sees pages. A new
  `PATCH /pipeline/issues/:id/stages/comicPages/pages/:pageIndex` endpoint
  accepts an edited `rawText` and re-parses panels. The comic-script parser
  now emits a per-page `rawText` slice; legacy pages without one fall back to
  reconstructing markdown from their structured panels, so existing series
  don't lose data.

- **LLM provider+model picker on issue pages.** The `SeriesLlmPicker` from
  the arc header is now also rendered at the top of every issue stage page
  (idea / prose / comic / TV script / etc.), bound to the same `series.llm`
  field. Idea generation, prose generation, comic-script generation, and
  auto-run-text all thread the choice into their `providerId` / `model`
  payloads. Changing the provider on one page updates it everywhere.

- **Codex CLI assistant-reply extractor.** New `server/lib/codexAssistantExtract.js`
  carves out just the assistant reply from Codex's full session transcript
  (banner + metadata + echoed prompt + `codex\n<reply>` + `tokens used: ...`
  footer). Applied unconditionally in `stageRunner.js` — idempotent for
  non-Codex providers. Text stages no longer ship the whole transcript in
  their output; JSON stages get a cleaner walker input as a side benefit.
  Fixes prior runs where comicScript / prose / idea outputs captured the
  banner + echoed prompt alongside the real response.

- **Pipeline Issue — answer-and-refine flow for beat-sheet open questions.**
  The idea stage prompt now tells the LLM to commit to decisive choices
  rather than hedging — `## Open questions` is OPTIONAL and only used when
  something fundamentally needs user input the LLM can't infer from the
  bible. When the section does appear, the idea page renders a panel below
  the output with one input per question and a *Refine with answers* button
  that re-runs the stage with the answers folded into the seed and
  instructions to drop the open-questions section in the revision. Blank
  answers tell the LLM to commit to its own best guess on that item.

- **Pipeline Series — configurable per-series AI provider + model.** The arc
  header now has provider + model dropdowns (mirroring the World Builder
  expansion picker) bound to a new `series.llm = { provider, model }` field.
  The choice persists on the series and is threaded into every arc operation —
  Generate / Regenerate arc, Verify arc, Resolve, and per-season Generate
  episodes — so the whole arc workflow runs against one consistent provider.
  Defaults to the active system provider when unset.

- **Pipeline Series — granular continuity context for season generation and
  verification.** When generating volume N's episode breakdown, the LLM now
  receives the actual per-episode beats of all prior volumes (pulled from each
  issue's `stages.idea.input`), not just the season-level synopses. The
  Verify arc pass also sees those per-episode synopses, so it can finally
  catch contradictions like "S1E7 introduces a character never referenced
  again" or "S2E3 implies a state S1's final episode hasn't reached" — the
  prompt has always asked for these checks, but with only episode titles
  visible the LLM had to bluff.

- **Pipeline Series — automatic bible extraction after generation.** After a
  successful per-season *Generate episodes* run, the server now extracts new
  characters / settings / objects mentioned in the new episode loglines and
  synopses, deduplicates them against the existing bible, and merges them in.
  The same extraction also fires after every successful prose-stage
  generation (`stages.prose`). Result: characters introduced mid-writing flow
  back into the series bible automatically, so downstream visual stages
  render the same character consistently across issues. Toast on the
  episodes-generate flow now reads `"Generated 11 episodes (+3 chars, +2
  settings, +1 objects extracted)"`.

- **Pipeline Series — character physical descriptions reach image
  composers.** `composeComicPagePrompt` and `composeVisualPrompt` now receive
  the matched character profiles for everyone speaking on the page or named
  in a storyboard scene's description, and prepend a "Featuring — NAME:
  <physicalDescription>; ..." clause to the diffusion prompt. A new
  `matchCharactersInText` helper word-boundary-scans free-text scene
  descriptions for bible character names + aliases (the comic-page path uses
  the structured dialogue character field directly). Same character now
  renders the same way across panels, pages, and scenes.

- **Pipeline Series — auto-resolve verification findings.** The verify panel
  now has a *Resolve all* button at the top and a per-finding *Resolve* button
  on each row. Each kicks off an LLM pass that rewrites the arc + volume
  outlines (logline, summary, synopses, episode-count targets) to address the
  selected finding(s) and persists the result. Per-issue scripts are never
  touched. New stage prompt `pipeline-arc-resolve` and route
  `POST /pipeline/series/:id/arc/resolve-issues`.

- **Pipeline Series — recommended-structure hint.** The *Target issues /
  episodes* field shows a live suggestion next to it ("3 volumes × 8
  episodes", etc.) computed from comic-as-TV norms: 1 volume for ≤ 12, 2 for
  13–17, 3 for 18–32, 4 for 33–44, 5 beyond. The arc-overview LLM prompt now
  receives the same recommendation so it stops slicing 12-issue runs into
  three 4-issue seasons.

- **Pipeline Series — linked World context flows into arc planning.** The
  arc-overview, verify, resolve, and season-episode-breakdown prompts now
  receive the linked World Builder world's full entity set (categories like
  factions / characters / environments / artifacts + composite reference
  sheets + influences). The LLM is instructed to ground every volume's
  logline and synopsis in those entities by name rather than inventing
  parallel ones, and the verify pass flags arc references that don't exist
  in the world (or major world entities that go entirely unused).

- **Pipeline Series — auto-flush bible state before LLM actions.** Clicking
  *Regenerate arc*, *Verify arc*, *Resolve all*, or *Resolve* now first
  pushes any pending local bible edits (issue count target, logline,
  premise, etc.) to the server so the LLM runs against the on-screen state
  rather than the last manually-saved snapshot.

- **Pipeline — Nouns stage between Prose and Comic.** New UI-only tab that
  surfaces, per-issue, the characters / settings / objects appearing in the
  prose. Each entry shows its canonical description and an `imageRefs[]`
  thumbnail strip with a *Render reference* button that fires a styled image
  gen and pins the resulting filename onto the series bible — so the
  comic-page renderer (which now cites those rich descriptions in its prompt)
  keeps characters and settings visually consistent across pages without
  having to pass actual reference images (which Codex's `$imagegen` doesn't
  accept). Extract from prose lives here now too; removed from the Prose tab.
  Reference renders inherit the linked world's `stylePrompt` + `negativePrompt`
  via `composeStyledPrompt`, so the aesthetic stays consistent with comic pages.
  The card defers the series PATCH until the job's `useMediaJobProgress`
  reports `completed`, so the UI never tries to load a not-yet-written
  `/data/images/<jobId>.png`.

- **Comic page renderer — cite settings + objects in the prompt, not just
  characters.** `enqueueVisualComicPage` now builds the matched bible set
  from the union of dialogue CAPS speakers and panel description / caption /
  SFX prose. `composeComicPagePrompt` emits new `Setting — <name>: …, palette,
  recurring details` and `Notable — <name>: <description>` clauses alongside
  the existing `Featuring —` clause. Fixes the case where a panel like
  "Wren pins the navy woman's wrist against the pavement" rendered with the
  model re-improvising both subjects every time because dialogue-only
  matching never saw them. New `matchSettingsInText` + `matchObjectsInText`
  mirror the character matcher; all three share a private
  `matchEntriesByCandidates` helper.

- **Pipeline image-gen — DRY settings form + codex-by-default for comic
  pages.** New `ImageGenSettingsForm` component bundles the backend chip
  strip + per-model controls + style textareas behind a single
  `{value, onChange}` contract; reused by the Comic Pages tab and the new
  Nouns tab. Settings persist to `settings.pipeline.imageGen` and default to
  Codex whenever the system has `imageGen.codex.enabled === true`, matching
  the recommendation that cloud models render comic pages dramatically
  better than local diffusion. Default resolution is now `1024×1536`
  (2:3 portrait, the closest preset to a real comic-book trim) instead of
  `1024×1024`. Right-side `Drawer` opened via a header gear button.

- **Pipeline image-gen — seed support for comic page + scene renders.**
  `comicPageRenderSchema` and `visualGenerateSchema` (server) now accept
  `seed`, and `enqueueImageJob` threads it into the queued job params.
  Client form exposes a seed input + random-dice button. Local mflux and
  diffusers runners honor it; codex still picks its own.

- **Series bible — `imageRefs[]` on settings and objects.** Previously
  characters-only; the Nouns stage's *Render reference* button writes to all
  three. Pipeline route schemas already use `.passthrough()`, so the client
  PATCH round-trips cleanly through the canonical sanitizer with no other
  schema changes.

## Changed

- **Data migration scripts for bringing old machines forward.** Two new
  scripts under `server/scripts/`:
  - `migrateWorldToUniverse.js` — renames `data/world-builder.json` →
    `data/universe-builder.json`, the top-level `worlds[]` → `universes[]`
    key, every `"worldId":` → `"universeId":` in `pipeline-series.json`,
    and every `"worldRun":` → `"universeRun":` in `media-jobs.json`. Safe
    to re-run (idempotent).
  - `migrateAll.js` — chains world→universe naming (above) and then
    series-canon → universe-canon in the correct order. The single
    command other machines need to catch up to the current schema.

  Run with `node server/scripts/migrateAll.js --dry-run` first to preview;
  drop `--dry-run` to apply.

  Also fixed a bug in `migrateSeriesCanon.js` where the migration was a
  no-op because `mergeExtractedBible` mutates its first arg (pushes into
  it) — the post-merge length comparison was always equal. Now clones the
  universe-side array before passing.

- **Universe Canon page — "Appears in" cross-references.** Each canon card
  (characters / places / objects) now shows which linked series + how many
  issues that entry appears in: `Appears in: Clandestiny (15 issues)`. New
  server service `canonUsage.js` aggregates prose-matched usage across
  every linked series's issues (scans prose + idea + scripts via the same
  matchers the comic-page renderer uses). New route
  `GET /api/universe-builder/:id/canon-usage`. Loaded lazily after the
  initial Canon page paint and refreshed after extract operations so new
  entries get usage attribution automatically.

- **Nouns page is universe-only — orphan fallback removed (Phase B.3b).**
  The per-issue Nouns page no longer falls back to series-side canon for
  unlinked series. A series with no `universeId` now renders a clear gate
  banner ("Link this series to a universe") in place of the noun cards;
  every active series in this install has a universe link, so the
  dual-path branching was just complexity tax. Drops the unused legacy
  imports (`extractPipelineBibles`, `updatePipelineSeries`,
  `refinePipelineCharacter`), the `onSeriesUpdate` prop, and the
  `canonStore` / `canonRecord` ternaries. The server-side legacy services
  still redirect to universe-side (Phase B.3a) for any caller that
  bypasses the UI.

- **Legacy series-side canon helpers redirect to universe (Phase B.3a).**
  `extractAndMergeIntoSeries` and `refineCharacterDescription` now early-
  return into their universe-side equivalents when `series.universeId` is
  set. Every legacy caller (the season:episodes:generate auto-extract,
  textStages auto-extract, the `/series/:id/extract-bible` route, the
  `/series/:id/characters/:entryId/refine` route) automatically writes to
  the universe without a fork. The redirect uses dynamic `import('../universeCanon.js')`
  to avoid a module-init cycle.

  Net effect: linked series's auto-flows now populate universe canon
  exactly like the manual paths on the Nouns + Universe Canon pages.
  Orphan series (no universeId) still take the legacy series-side merge.

- **Per-issue Nouns page reads + writes universe canon (Phase B.2).** When
  the series is linked to a universe, the Nouns page now points all canon
  reads (preview thumbnails, "in this issue" filtering) and all mutations
  (extract from prose, AI: differentiate per character, render reference
  → imageRefs persistence) at the universe rather than the per-series
  bible arrays. Adds + edits propagate to every series sharing that
  universe. For orphan series with no `universeId`, the legacy series-side
  flow continues to work unchanged so the page never breaks.
  Header copy + page comments reflect the new flow.

- **Pipeline render paths read canon from the linked universe (Phase B).**
  Comic-page, panel, storyboard, and arc-planner LLM contexts now resolve
  characters/places/objects via `getSeriesCanon(series)` — preferring the
  series's linked universe canon and falling back to the series's own arrays
  only when the universe isn't migrated yet. Switching the source of truth
  to the universe is the prerequisite for crossover series sharing a cast.

  Migration utility: `node server/services/pipeline/migrateSeriesCanon.js`
  (optional `--dry-run`) copies each series's
  `series.{characters,settings,objects}[]` into its linked universe via
  `mergeExtractedBible` (dedup by name). Idempotent. Auto-creates a
  universe for orphan series. Does NOT clear the series arrays — they stay
  as a pre-migration fallback until Phase B.2 drops the schema fields.

  Fallback is **all-or-nothing per series**: if a series has any kind
  populated locally that the universe hasn't received yet, we read the
  whole series-side canon (rather than mixing universe characters with
  series settings and producing silent hybrid stale data).

  Phase B.2 (next): point the per-issue Nouns page directly at universe
  canon, remove series-side bible arrays from the schema, drop the
  legacy `extractAndMergeIntoSeries` + `refineCharacterDescription`
  functions.

- **BREAKING — World Builder is now Universe Builder.** A universe can contain
  many worlds, and stories within the same universe can share canon (characters,
  places, things) across multiple series — Marvel-style crossovers. This is a
  pure rename pass; behavior is unchanged. Files (`worldBuilder*.js` →
  `universeBuilder*.js`, `WorldBuilder.jsx` → `UniverseBuilder.jsx`), routes
  (`/api/world-builder/*` → `/api/universe-builder/*`), client routes
  (`/world-builder` → `/universe-builder`), fields (`series.worldId` →
  `series.universeId`), top-level data key (`worlds: []` → `universes: []` in
  `data/universe-builder.json`), function names (`getWorld` → `getUniverse`,
  etc.), constants (`WORLD_ID_MAX` → `UNIVERSE_ID_MAX`), and the
  `params.worldRun` mediaJobQueue tag (148 existing job records migrated).
  Back-compat: the `⌘K` palette + voice agent keep `'world'`/`'world-builder'`
  as aliases for the renamed nav entry, so muscle memory still resolves.
  Sets up the next phase: lift canon entities (characters/places/objects)
  from per-series bibles to the universe so multiple series can share them.

- **Pipeline character — "AI: differentiate" button.** Per-character refine on
  the Nouns page (Universe Builder side coming). Sends the target plus every
  peer's `physicalDescription` to a new `pipeline-character-refine` prompt
  and rewrites only the target's `physicalDescription` so no two characters
  collide on ethnicity, age, hair, silhouette, or signature wardrobe.
  Preserves evidence + firstAppearance.

- **Character extraction prompt — opinionated commits, not gaps.**
  `writers-room-characters.md` now requires every renderable axis (ethnicity,
  age decade, build, hair color/length/texture/style, eye color, distinguishing
  facial features, signature wardrobe with palette + era, posture). When prose
  is silent, the LLM is told to COMMIT to a specific choice that differentiates
  the character from the rest of the cast and log the committed axes in
  `missingFromProse[]`. The old "do not invent" rule was producing
  visually-interchangeable characters when prose was sparse on visual specifics.

- **Sidebar Pipeline submenu — all series, not 10 recent issues.** The
  Create → Pipeline grandchildren now list every series alphabetically
  (links to `/pipeline/series/:id`) instead of the 10 most recently updated
  issues. Series-level entries stay coherent across many series — individual
  issues live under their series page. Sort happens in the fetch effect so
  the memoized nav tree doesn't re-sort when unrelated `sidebarApps` state
  changes.

- **Comic-page image prompts — balloon lettering rule.** `composeComicPagePrompt`
  in `server/services/pipeline/visualStages.js` now formats each dialogue
  line as `Speech balloon reads: "<text>" (spoken by NAME[, balloon style: <hint>])`
  and translates `(EARPIECE)` / `(WHISPERED)` / `(THOUGHT)` parentheticals
  into visual styling hints. The page-layout clause explicitly tells the
  diffusion model to letter ONLY the quoted text — speaker names and
  parentheticals were previously being lettered verbatim inside balloons.

- **Prose stage — present tense, non-negotiable.** `data.sample/prompts/stages/pipeline-prose.md`
  now demands present tense throughout so the upstream draft matches the
  downstream comic and TV-script adaptations, keeping visual beats
  translatable across formats.

- **Comic-script stage — target a standard 22-page issue.** The comic-script
  prompt now anchors on the industry-standard 22-page count (100–140 panels)
  and tells the LLM to expand action across more panels when the prose draft
  is short rather than cutting page count.

- **Pipeline nav — shorter tab labels.** *Comic Pages* → *Comic*,
  *Episode Video* → *Video*. The full names were redundant inside the
  Pipeline page where every tab is obviously a pipeline stage.

- **Pipeline Series — Regenerate arc button no longer requires two clicks.**
  Dropped the `useArmedAction` two-click-arm pattern from the regenerate
  button; one click runs. The pattern was confusing — users didn't realize
  "Click again to replace" was an instruction rather than a status. The
  delete-season and delete-issue buttons keep the arm pattern since they're
  hover-revealed trash icons where misclick risk is real.

- **Pipeline Series — combined comic/TV terminology.** Every series now ships
  in both formats by default — graphic novel (issues → volumes) AND TV
  (episodes → seasons). Dropped the *Target format* picker from the new-
  series form and the bible sidebar; all labels read as `issues / episodes`
  and `volumes / seasons` so a single record drives both pipelines. The
  arc-overview / verify / resolve prompts were rewritten to author for both
  formats simultaneously.

- **Pipeline Series — flush-edge layout.** The series detail page now uses
  the same edge-to-edge canvas as World Builder. The bible sidebar sits flush
  against the main app sidebar (no Layout padding between them) and the
  collapse rail is a plain hairline toggle instead of a floating rounded
  button.

- **World Builder — inline Refine prompts.** Clicking *Refine prompts* now
  expands a feedback textarea right under the header buttons instead of
  opening a modal. The LLM picked in the page's own provider/model selectors
  is used directly (no second selector), and the refined output is applied
  straight to the prompt fields below so you can see the changes in place. A
  short rationale + change list appears below the textarea after each refine.

- **World Builder — explicit-removal handling in Refine.** When the user
  feedback names a specific variation or composite to remove, the LLM is now
  told to omit it entirely (including composite sheets whose primary subject
  is the removed entity, e.g. a "Faction A vs Faction B branding sheet") and
  to scrub stray references from sibling unlocked composites' prompts.

## Fixed

- **Pipeline stage prompts — length profile variables reach existing installs.**
  Running `npm run migrations` now auto-updates the five pipeline stage prompt
  templates (`pipeline-idea-expansion.md`, `pipeline-prose.md`,
  `pipeline-comic-script.md`, `pipeline-tv-script.md`,
  `pipeline-season-episodes.md`) on machines that were set up before the
  length-profile feature landed. Migration `003` compares each file's MD5 to
  the pre-feature shipped hash: unmodified files are overwritten with the new
  template; customized files are skipped with a diff hint. `setup-data.js` also
  emits a one-line warning at install time when any stage prompt has drifted,
  pointing at the migration command.

- **CoS-spawned PRs — concise title + no double "Summary" heading.** Two
  related bugs in the PR-creation path:
  - The PR title was the raw user task description (e.g. "on the
    settings/backup page, we should have a button to run the backup. Also,
    we should show default…"), truncated at 100 chars. New helper
    `git.suggestPRTitle()` picks the oldest commit subject on the branch as
    the title (the agent already wrote a conventional `feat:`/`fix:` commit
    message that summarizes the change far better than the prompt), falling
    back to the description's first line when no commits are found. Used in
    both the worktree-PR path and the JIRA-ticket PR path (where the
    `${jiraTicketId}: ` prefix is preserved).
  - The PR body rendered "Summary" twice — `generatePRDescription` wraps the
    extracted agent summary in `## Summary`, but agents often write their own
    `## Summary` heading at the top of their final message. `extractAgentSummary`
    now strips a leading `Summary` / `## Summary` / `Summary:` heading before
    returning, so the wrapping section is the only one in the rendered PR.
  - Tests: 2 new `extractAgentSummary` cases for the heading-strip behavior;
    `cleanupAgentWorktree.test.js` mock updated to stub `suggestPRTitle`.
    Full server suite (4,549 tests) green.

- **CoS orphan handler — no more duplicate `[Auto-Fix]` investigation tasks.**
  When `cleanupOrphanedAgents` swept up two stale "running" agents that shared a
  taskId, `handleOrphanedTask` ran once per agent. The first call blocked the
  task with `blockedCategory='max-retries'` and spawned an investigation task;
  the second call fell through the existing guard (which only short-circuits on
  `'user-terminated'`), incremented `orphanRetryCount` past its ceiling, and
  spawned a SECOND investigation task with the same `[Auto-Fix] Investigate
  repeated agent orphaning for task <id>` headline (the `addTask` dedup at
  `cos.js:2194` missed it because the description body embeds the per-agent
  `retryCount`/`agentId`). The handler now also early-returns when the task is
  already blocked with `'max-retries'` or `'orphan-cooldown'`. Adds
  `agentManagement.test.js` covering all four short-circuit branches.

- **Media Jobs Queue — empty prompt tooltip.** Job rows without a prompt
  no longer render an empty `title=""` tooltip. Rows with a prompt now
  show the full prompt on hover (the visible cell is still truncated to
  80 chars).

- **CoS agent summary — historical Codex agents now auto-repair on read.**
  The previous fix (above) corrected the extractor for *new* Codex agents, but
  agents that completed before the patch landed already had their
  multi-megabyte transcript dumps persisted into `metadata.json` (e.g.
  agent-5f6951e3: 5.2MB metadata, 737KB `taskSummary`, 4.4MB `simplifySummary`).
  Adds `server/services/codexSummaryRepair.js`: when `getAgent` or
  `getAgentsByDate` loads a completed agent whose `taskSummary` or
  `simplifySummary` is ≥20KB, it re-reads `output.txt`, re-extracts the
  assistant tail via `extractCodexAssistantTail`, clears the false
  `simplifySummary` (Codex CLI cannot execute `/simplify`), and rewrites
  metadata.json in place. One-time per agent, idempotent thereafter.

- **CoS agent summary — Codex output now extracts the actual final message.**
  When a CoS task ran on the Codex provider, the persisted `taskSummary`
  ballooned to multi-megabyte dumps containing every diff, grep result, and
  `apply_patch` payload Codex streamed during the run. `extractFinalSummary`'s
  tool-marker heuristic (`🔧`, `→`, `↳`) does not match any of Codex's section
  markers (`exec` / `apply patch` / `codex` / `tokens used`), so the
  backwards walk swept through the whole transcript. The simplify-summary
  splitter also false-positived on diff lines that quoted source code
  containing `/simplify` and a `run` verb. Adds an `extractCodexAssistantTail`
  helper next to `extractCodexAssistant` that carves out just the message
  following the last `tokens used\n<count>` (or inline `tokens used: <n>`)
  footer; both `extractFinalSummary` and `extractSimplifySummaries` short-
  circuit on Codex output so the agent card shows the real summary instead of
  a transcript dump.

- **Codex image gen — "Codex returned no session id" false negative.** With
  long pipeline prompts (multi-KB comic-script payloads), codex emits the
  banner + echoed prompt in a single stderr chunk that exceeds the
  banner-scan buffer. The old `captureSession()` sliced the buffer's tail
  before running the regex, chopping the `session id:` line off the front
  and failing every render. Now matches before slicing, and stops feeding
  stdout into the banner buffer so an interleaved stdout chunk can't split
  the session-id line either. Adds regression tests for both paths.

## Removed

- **Dead `listRecentPipelineIssues` client API.** Sidebar no longer fetches
  recent issues, so the corresponding `apiPipeline.js` wrapper is removed.
  The server route + tests stay for now in case future surfaces want it.
