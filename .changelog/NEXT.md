# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.
- **Episode video model picker** — the pipeline's Episode Video stage now lets you choose which video model renders each scene, alongside the aspect-ratio and quality controls. Leave it on "Default model" to follow your video settings, or pin a specific model; the choice is remembered when you restart a render.

## Changed

- **[issue-748]** Extracted the pure command-arg builders and output parsers from `server/services/git.js` into focused `server/lib/git*` modules. Internal refactor with no behavior difference.
- **[issue-718]** The duplicated optimistic canon-patch handler in the universe canon and Nouns stage editors now lives in one shared `useCanonPatch` hook. Internal refactor with no behavior difference.
- **[issue-721]** Goal detail badges now use the shared pill component, keeping their look consistent with the rest of the app. Internal maintenance change with no behavior difference.
- **[issue-759]** The autofixer UI's large inline HTML document moved out of `autofixer/ui.js` into a sibling `ui.template.html`, leaving the route handler as logic only. Internal refactor with no behavior difference.
- **[issue-734]** The reference-watch scheduled task now guards its read/write default against silent drift when its prompt is revised. Internal maintenance change with no behavior difference.
- **[issue-722]** Prompt-template migrations now scan their files concurrently, so future multi-file updates apply faster.
- **[issue-720] Shared popover positioning** — the theme switcher and collection pickers now share one placement engine, so their pop-up menus stay anchored to their button and on-screen consistently. Internal maintenance change with no behavior difference.
- **`/claim --issues` marks issues in progress while it works them** — claiming an issue now assigns it to you (and labels it `in-progress`) before any code is written, so a `/claim --issues` running on another machine sees it as taken instead of grabbing it too; the marker is released if a claim is abandoned, and the issue is closed once its PR merges. Developer tooling only — no app-facing change.
- **`$claim` (Codex) and `/claim` (Claude Code) now share one procedure** — the Codex claim skill was collapsed to a thin adapter over the slash command's procedure, so Codex inherits `--issues` mode, the in-progress marker, and the multi-reviewer loop instead of running a stale copy that had drifted behind. Developer tooling only — no app-facing change.

## Fixed

- **[issue-729] Style-probe renders stay put across federated machines** — a universe's base style-probe images are now kept local to each machine, so syncing with an older peer no longer wipes them and a probe render no longer surfaces a phantom sync conflict.
- **[issue-717] No stray React warnings when you navigate away mid-action** — buttons that run an async task (save, generate, sync) no longer log an "update on an unmounted component" warning if you leave the page before the task finishes.
- **[issue-719] Steadier media galleries during live note/star sync** — incoming annotation broadcasts that match what a view already shows no longer trigger a needless re-render of the media cards.
- **[issue-766] Episode Video renders cleanly when a remembered model is gone** — if the video model you previously pinned for an episode has since been removed, the render now quietly falls back to your default model instead of failing partway through.
- **[issue-728] Imported stories no longer fake a "Ready" aesthetic or reader map** — when you start a Story Builder session from an import, only the steps the importer actually fills (idea, plot arc, characters, issues) open as "Ready" to review. The Universe Aesthetic and Reader Map steps now start "pending" instead of showing an empty step under a misleading "Ready" badge, so you generate them like you would in a from-scratch build.

## Removed
