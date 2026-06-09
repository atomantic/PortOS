# Unreleased Changes

## Added

## Changed

- **2026-06-09 DevSecOps audit sweep** — a full-codebase audit landed as a set of focused PRs. Highlights: crash-safe (atomic) writes for a dozen state files (memory index/embeddings, backup scheduler, calendar/message accounts, activity logs); timeouts on local-LLM and provider model-list requests so a stalled endpoint can't hang the server; guards on background timer callbacks that could previously crash the process on a rejected write; the Templates page is now reachable from ⌘K and voice navigation; faster first loads on Goals, Brain, Chief of Staff, and CoS Memory (their 3D views now load on demand instead of riding in the main bundle); the bulky `googleapis` package replaced by the scoped Calendar/Gmail/auth packages (~190 MB less on disk); screen-reader labels on icon-only buttons and form fields across settings tabs; agent World-tab history now reloads when switching agents; and ~120 new tests covering previously untested services.
- **[issue-1081] Maintenance:** Split the pipeline API's single 2,500-line route file into domain-grouped sub-routers (audio, series, arcs, manuscript, covers, issues, editorial) — no behavior change, every endpoint keeps its exact path.
- **Docs:** Split the AI Toolkit and Dashboard Widgets sections out of the root `CLAUDE.md` into directory-scoped `server/lib/aiToolkit/CLAUDE.md` and `client/src/components/dashboard/CLAUDE.md` files (load on demand when working in those subtrees), leaving discovery pointers at root. Trims root context with no loss of guidance.

## Fixed

## Removed
