---
name: portos-add-module
description: Where new PortOS code lives and how to add a public module — the one-sentence summary header and the derived module catalog. Invoke before creating a new file in server/lib, client/src/lib, client/src/hooks, client/src/utils or a new client/src/services api module.
---

# Adding PortOS code and public modules

Moved from the root `AGENTS.md` Module Organization section (#16087). Root keeps the "search the catalog first" rule.

## Where new code lives

- Pure helpers → `server/lib/` or `client/src/lib/`
- React hooks → `client/src/hooks/` (`use…`) only when two or more modules import them. A hook with a single importer lives next to that owner (`components/<feature>/useX.js` beside the component, or the page's component directory, never `pages/`) with its test, so the catalog lists only reusable hooks; move it into `hooks/` when a second importer appears. A hook whose only importer is another co-located hook moves with that hook's owner.
- Formatting helpers (pure, no React) → `client/src/utils/`
- HTTP / socket / browser clients → `client/src/services/` (API wrappers `api*`)
- Express handlers → `server/routes/`, validated with `validateRequest` + the route family's domain `lib/<domain>Validation.js` schemas
- Domain orchestration → `server/services/`
- Persisted data → decide Postgres vs a `data/` file with `docs/STORAGE.md` *before* adding a `data/*.json`; app-native relational records are `db-primary`, and its "Adding a new data store?" checklist is required in review. Record the chosen class, federation stance and reason as a ``Storage: `<class>` …`` paragraph in the store module's header (after the summary sentence), never as a new section in `docs/STORAGE.md`. For file-backed storage, choose the backend under `docs/STORAGE.md` first, then use `fileUtils.js` / `collectionStore.js`; a growing collection is not a reason to bypass the database policy.

One concern per file; tests sit next to their source as `<name>.test.js`; names are camelCase with a domain prefix (`brainValidation.js`).

Use the shared boundaries: the clipboard helpers (insecure-origin support), `useSseProgress` for SSE, and the shared formatters for user-facing numbers and amounts (`client/src/AGENTS.md`).

## Adding a public module

Search first: `node scripts/lib-catalog.js <term> [--dir <dir>]` prints `path — summary — exported names` for every module in `server/lib/`, `client/src/lib/`, `client/src/hooks/`, `client/src/utils/` and `client/src/services/` whose path, exports or header matches all the terms. The catalog is derived on demand; nothing is checked in.

A new module in one of those directories opens with a comment whose first paragraph is a one-sentence summary of at most 200 characters, followed by any longer rationale in the same comment. `<dir>/moduleSummaries.test.js` fails on a missing or over-length summary. There are no barrels or catalog tables to update, so a new module needs no edit outside its own file and test; import modules directly.
