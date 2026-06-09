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

## Deferred cleanups

- [ ] Extract the shared gallery variant-write shape from the three routes in
  `server/routes/imageGen.js` — `/clean` (~`router.post('/:filename/clean'`),
  `runLightRegen`, and `/remove-watermark`. All three resolve a group-root
  `cleanedFrom`, strip `hidden`/`filename`/`id` off the source sidecar, write a
  `<base>_<suffix>.png` + matching `.metadata.json`, then
  `autoFileCleanedToSourceCollections`. Now a rule-of-three candidate; skipped
  here because folding it in would refactor two pre-existing routes outside the
  visible-watermark task's scope.
