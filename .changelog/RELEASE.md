# Release v2.121.0 - Snappy Flamingo

Released: 2026-11-16

## Highlights

- **Snappier Music Video board:** Shot edits, take decisions, auto-arrange, project field saves, film look and media mode updates, take imports, and review actions now patch the board directly from the server reply instead of reloading the entire project.
- **Make it vertical:** Export library clips in blurred-fill 9:16, 4:5, and 1:1 aspect ratios, with concurrent export coalescing and backup lease tracking.
- **Higgsfield reference routing & tier controls:** Toggle Higgsfield shots between the frame and reference routes from the shot card, render start-frame shots with clip references on the reference route, and run production renders or failure retries at your chosen draft or final tier.
- **Larger casts and faster pickers:** The 24-item cap on music video subjects and references is lifted, and long canon pickers now include a name filter.

## Added

- Blurred-fill 9:16, 4:5, and 1:1 vertical export ("Make it vertical") for library clips.
- Shot card toggle for selecting the Higgsfield frame route, plus automatic reference-route rendering for Higgsfield shots that combine a start frame with clip references.
- Draft and final tier selection for production runs and failure retries.
- Name filter for long canon pickers, and removal of the 24-item cap on music video subjects and references.
- Shared comparison sheets are now recognized as references for all featured characters in sequence takes.

## Changed

- Music Video project lists return summaries when unpaged, linked catalog records load once per request, and shot/project/review edits return incremental board patches so the UI updates immediately without full reloads.
- Take prompt lines are stored once per project, and reviewed revisions store compact records without duplicating take history.
- Take decision buttons show a saving state until the reply arrives and ignore duplicate presses while in flight.
- Pregate test selection now includes suites that import or mock a changed source file, and guard timing budgets calibrate to the host machine.

## Fixed

- Duplicated "Render shots as one take" panels no longer appear on the scene board.
- Reject unused takes now returns the edit result to the board so subsequent shot edits cannot restore stale takes, and color-matched takes refresh the shot's take list immediately.
- Confirmed frame cast fingerprints stay accurate from stored shot data, and the shot editor holds prompt previews until the active view settles.
- Animatic frame capture handles slow frames and hidden browser tabs cleanly without prematurely rejecting settled previews.
- Claim agents keep their issue until every slice ships and continue past a merged slice instead of reporting incomplete.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.120.0...v2.121.0
