# Importer split-choice + back-generate series arc/bible from manuscript + finish-the-draft editor feedback

## Context

A comic script was imported (series `ser-c22c6c9e-3a02-43be-bc38-6cd2de82bd27`). Three problems surfaced, all rooted in how the importer treats a single graphic novel:

1. **4 "volumes" but 3 issues, no user choice.** The "volumes" are actually `series.seasons[]`, produced by the `importer-arc-extract` LLM *independently* of the 3 issues the mechanical `splitComicScriptIssues()` produced. The two passes never reconcile, and neither surfaces a user choice. For a single graphic novel the right shape is **1 volume containing 3–4 issues-as-acts** — the 4 season titles (Magic Beans, Sins of the Fathers, …) read as act/chapter descriptions, not separate volumes.
2. **Empty bible.** Commit only writes `series.arc` + `series.seasons`. It never sets the top-level `series.logline` / `series.premise` / `issueCountTarget` that the bible sidebar reads, so the bible shows only the name. The mechanical comic split also seeds `stages.comicScript` (the verbatim manuscript) but **not** `stages.idea.input` (synopsis) — so Verify Arc, which reads `idea.input`, sees empty synopses for these issues.
3. **No way to back-derive arc/bible from an existing manuscript, and no "finish the draft" feedback.** `generateArcFromSource()` already back-derives arc+seasons from issue content (`arcPlanner.js:306`) but is only reachable from the Story Builder session flow — there's no route or series-page action. And `verifyArc` / `verifyVolume` are **synopsis-level only** (read `idea.input`/`idea.output`); they're blind to the actual `comicScript` manuscript, so they cannot tell you "you're missing pages / the draft is 90% done — here's what to finish."

**Outcome (user-confirmed decisions):** all four workstreams in one plan; target structure is **1 volume, 3–4 issues as acts** (no new data model — "issue" stays the unit, "volume"=season); a **new manuscript-completeness editor action** (leave Verify Arc/Volume as-is); the derive-from-manuscript action uses a **preview-and-confirm** flow like the importer review. Implementation runs in a **fresh git worktree off `main`** so it doesn't collide with another agent already working in this checkout.

## Step 0 — Worktree (do this first, before any edits)

Create an isolated worktree off the latest `main` and do all work there:

```
git -C /Users/adameivy/github.com/atomantic/PortOS fetch origin
git -C /Users/adameivy/github.com/atomantic/PortOS worktree add -b feat/importer-derive-manuscript ../PortOS-derive origin/main
```

Run `npm run install:all` in the worktree (submodules + deps). All file paths below are relative to the worktree root. Commit/push only when the user asks.

---

## Workstream 1 — Importer: split choice, arc + bible population

**Goal:** let the user choose single-volume-with-N-chapters vs N-volumes at import, reconcile seasons↔issues, and populate the bible on commit. Handle the volume strategy as a **review-UI remap + commit field** so we do NOT modify the `importer-arc-extract.md` prompt (avoids a prompt migration per the CLAUDE.md stage-prompt rule).

- **`client/src/pages/Importer.jsx` (ReviewPanel + commit path):**
  - Add a **Structure** control to `ReviewPanel` (near `ArcReviewSection`/`IssuesReviewSection`): radio **"Single volume (graphic novel)"** vs **"Multi-volume series"**, plus a chapter/issue count.
  - When "Single volume" is chosen: collapse `seasonsDraft` to one season (keep its title or default to the series name), and remap the extra extracted season titles/loglines into the issue/chapter drafts (`issuesDraft`) as titles/synopses — surfacing the user's "volume descriptions are better as issue descriptions" intuition automatically. Re-split issues to the chosen count using the existing even-distribution intent (mirror `splitComicScriptIssues`'s page-bundling — see below).
  - On commit, send the reconciled `seasons` + `issues` (existing `commitImport` payload already carries both).
- **`server/services/importer.js` (`commitImport`, ~line 1181–1205):** after writing `arc` + `seasons`, also patch top-level bible fields when present and not locked:
  - `series.logline` ← `arc.logline`
  - `series.premise` ← `arc.summary` (fallback `arc.protagonistArc`)
  - `series.issueCountTarget` ← number of issues being created
  - Use the existing `updateSeries` patch (it already supports these keys — see `series.js:298–312`). Guard each so a re-import never clobbers a non-empty/locked field (`replaceMode` may overwrite; additive preserves).
- **Per-issue synopsis seed:** in the commit issue-loop (`importer.js:1269–1281`), when a comic-script issue has no `logline`/`synopsis` (mechanical split), still seed `stages.idea.input` with the season/chapter description mapped in the review step, so Verify Arc has synopsis material. Keep `stages.comicScript` seeding unchanged.
- **Reconciliation guard:** in `analyzeImport` (`importer.js:642`), when `contentType==='comic-script'` and the mechanical split produced N issues, default the `seasonsPreview` the client shows to a **single season** (graphic-novel default) while still returning the LLM's multi-season proposal as the alternative the "Multi-volume" radio reveals. This makes single-volume the sane default without discarding the arc-extract's act breakdown.
- **Validation:** `importerCommitSchema` already accepts `seasons` (max 50) + `issues`; no schema change needed unless we add an explicit `volumeStrategy` field (optional — the remap can be done entirely client-side, so prefer no new field).

## Workstream 2 — Reusable "Derive arc / bible / structure from manuscript" (series page, preview & confirm)

**Goal:** a series-page action that reads the existing issue manuscripts and proposes arc + bible + a 1-volume/issues-as-acts restructure, shown as a preview the user confirms before anything is written. Reuse the existing back-gen primitive.

- **Service — `server/services/pipeline/arcPlanner.js`:**
  - Export a `collectIssueSourceText(seriesId)` equivalent. One already exists in `server/services/storyBuilder.js:436` (prefers `comicScript → teleplay → prose → idea`) but isn't exported — extract it into a shared spot (e.g. `arcPlanner.js` or a small `server/services/pipeline/` helper, referenced from both) rather than duplicating.
  - Add `deriveFromManuscript(seriesId, { providerOverride, modelOverride })` that: collects manuscript text, calls the existing `generateArcFromSource()` (`arcPlanner.js:306`) to get `{ arc, seasons }`, and **also** derives bible fields (`logline`, `premise`, `issueCountTarget`) + a proposed single-volume structure mapping each existing issue to one volume. Returns a **preview object** (no writes): `{ arc, bible, volume, issueMapping, runId, providerId, model }`.
  - Add `commitDerivedManuscript(seriesId, preview)` that applies on confirm: write bible fields via `updateSeries`; replace seasons with the single volume via `commitSeasonsWithRemap(series, { arc, seasons })` (honors per-field arc locks, per-season locks, and remaps/keeps child issues — `arcPlanner.js` already owns this); reassign every issue's `seasonId` to the retained volume; optionally backfill each issue's `idea.input` synopsis. Per-episode issue **scripts are never overwritten** (same contract as `resolveVerifyIssues`).
- **Routes — `server/routes/pipeline.js`** (mirror the `/arc/generate` preview+commit shape at `:1062`):
  - `POST /series/:id/arc/derive-from-manuscript` → returns preview; with `{ commit: true }` (or a separate confirm route) applies it.
- **Validation — `server/lib/validation.js`:** add `arcDeriveSchema` (provider/model overrides + optional `commit`), wired into the route via `validateRequest`.
- **Client API — `client/src/services/apiPipeline.js`:** add `derivePipelineArcFromManuscript(seriesId, opts)` next to `generatePipelineArcOverview` (`:353`). Re-export per the barrel/README maintenance rule.
- **Client UI — `client/src/components/pipeline/ArcCanvas.jsx`:** add a **"Derive from manuscript"** action near the arc header / Verify Arc, opening a preview panel (reuse the importer-review styling pattern: show proposed arc fields, bible, and the 1-volume/issues mapping with edit + Confirm/Cancel). On confirm, call the commit route and refresh series + issues via existing reactive-update patterns (`setState`, not full refetch where possible).

## Workstream 3 — Repair THIS series

No one-off script needed — Workstream 2 *is* the repair tool. On the existing series:
1. Run **Derive from manuscript** → preview proposes single volume + arc + bible from the 3 issues' `comicScript` content.
2. Confirm → collapses V1–V4 to one volume, reassigns the 3 issues, fills the bible.
3. Delete the now-empty V2/V3/V4 if `commitSeasonsWithRemap` leaves any (the existing `deletePipelineSeason(seriesId, seasonId, { reassignTo })` wrapper at `apiPipeline.js:344` handles reassign-then-delete).
4. Optionally re-split into 3–4 acts using the editable issue mapping in the preview.

Verify end-to-end on `https://null.taile8179.ts.net:5555/pipeline/series/ser-c22c6c9e-...` after implementing.

## Workstream 4 — Manuscript-completeness ("finish the draft") editor action

**Goal:** a new series-level action that ingests the actual `comicScript` manuscript across issues + the arc + canon, and returns categorized findings: **missing pages/beats, arc holes, character-development gaps**. Leave Verify Arc/Volume unchanged.

- **Prompt — `data.reference/prompts/stages/pipeline-manuscript-completeness.md`** (new file; `setup-data.js` auto-copies *missing* prompt files into installs, so **no migration needed** for a brand-new prompt). Register it in `data.reference/prompts/stage-config.json` (heavy tier, `returnsJson: true`) alongside `pipeline-arc-verify` (`:273`). The prompt takes the concatenated manuscript + arc + canon and returns `{ issues: [{ severity, category, location, problem, suggestion }] }`.
- **Service — `arcPlanner.js`:** `analyzeManuscriptCompleteness(seriesId, options)` — builds context from `collectIssueSourceText` (real script, not synopsis) + `buildArcBaseContext` + canon, runs the new prompt, shapes results with a `category`-aware variant of the existing `shapeVerifyIssues` (`:873`). Read-only (no writes).
- **Route — `server/routes/pipeline.js`:** `POST /series/:id/manuscript/completeness` (mirror `/arc/verify` at `:1174`).
- **Validation:** `manuscriptCompletenessSchema` in `validation.js` (provider/model overrides).
- **Client — `apiPipeline.js`:** `analyzePipelineManuscriptCompleteness(seriesId, opts)` + barrel/README; **`ArcCanvas.jsx`:** a **"Finish the draft"** button near Verify Arc that renders findings in the existing `VerifyResults`-style panel (grouped by category). These are advisory suggestions (no auto-resolve in v1).

## Cross-cutting

- **Schemas:** every new route input validated via `validation.js` (POST + PUT parity rule). New fields added to any sanitizer/payload get a matching Zod update in the same change.
- **Barrels/README:** any new `client/src/services` export re-exported from `api.js` + a README row; any new `server/lib` helper added to its `index.js` + README (boot test enforces this).
- **Migrations:** none required if we (a) keep `importer-arc-extract.md` unchanged and (b) only *add* the new `pipeline-manuscript-completeness.md`. If we end up modifying an existing shipped stage prompt, add a `scripts/migrations/NNN-*.js` per the CLAUDE.md stage-prompt rule (hash-gated update of installed copy) and update the drift constants in `scripts/setup-data.js`.
- **Tests:** unit-test the pure pieces — the importer single-volume remap/split helper, `deriveFromManuscript` preview shaping, and the completeness result shaper. Add route tests mirroring existing `pipeline` route tests. Run `cd server && npm test` and `cd client && npm test`.
- **Simplify:** run `/simplify` after the diff settles (judgment-gated), then commit/push when the user asks.

## Verification

1. **Unit/route tests:** `cd server && npm test`, `cd client && npm test` — all green.
2. **Importer choice (Workstream 1):** in the worktree, `npm run dev`; import a small comic script with PAGE markers; in review, pick "Single volume" + 3 chapters → confirm. Inspect `data/pipeline-series/<id>/index.json`: one season, `logline`/`premise`/`issueCountTarget` populated; 3 issues all under that season with `comicScript` (ready) + `idea.input` seeded.
3. **Derive from manuscript (Workstreams 2+3):** on `ser-c22c6c9e-...`, click "Derive from manuscript" → preview shows 1 volume + arc + bible; confirm → UI shows 1 volume, 3 issues reassigned, bible filled; extra empty volumes gone. Verify the verbatim issue scripts are untouched.
4. **Finish the draft (Workstream 4):** click "Finish the draft" → returns categorized findings (missing pages, arc holes, character gaps) computed from the real manuscript; confirm Verify Arc still works at synopsis level independently.
5. Confirm no nav-manifest/barrel boot failures (`npm start` warms providers + barrels).
