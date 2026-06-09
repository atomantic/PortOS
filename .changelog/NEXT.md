# Unreleased Changes

## Added

## Changed

- **[issue-1081] Maintenance:** Split the pipeline API's single 2,500-line route file into domain-grouped sub-routers (audio, series, arcs, manuscript, covers, issues, editorial) — no behavior change, every endpoint keeps its exact path.
- **Docs:** Split the AI Toolkit and Dashboard Widgets sections out of the root `CLAUDE.md` into directory-scoped `server/lib/aiToolkit/CLAUDE.md` and `client/src/components/dashboard/CLAUDE.md` files (load on demand when working in those subtrees), leaving discovery pointers at root. Trims root context with no loss of guidance.

## Fixed

## Removed
