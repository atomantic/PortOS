# Unreleased Changes

## Added

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

## Changed

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

## Removed
