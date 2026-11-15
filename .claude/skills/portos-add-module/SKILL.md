---
name: portos-add-module
description: Where new PortOS code lives and how to add a public module — catalog READMEs, index.js barrels, the union merge driver, and barrel name collisions. Invoke before creating a new file in server/lib, client/src/lib, client/src/hooks, client/src/utils or a new client/src/services api module.
---

# Adding PortOS code and public modules

Moved from the root `AGENTS.md` Module Organization section (#16087). Root keeps the "search the catalog first" rule.

## Where new code lives

- Pure helpers → `server/lib/` or `client/src/lib/`
- React hooks → `client/src/hooks/` (`use…`)
- Formatting helpers (pure, no React) → `client/src/utils/`
- HTTP / socket / browser clients → `client/src/services/` (API wrappers `api*`)
- Express handlers → `server/routes/`, validated with `validateRequest` + `lib/validation.js` schemas
- Domain orchestration → `server/services/`
- Persisted data → decide Postgres vs a `data/` file with `docs/STORAGE.md` *before* adding a `data/*.json`; app-native relational records are `db-primary`, and its "Adding a new data store?" checklist is required in review. For file-backed storage, choose the backend under `docs/STORAGE.md` first, then use `fileUtils.js` / `collectionStore.js`; a growing collection is not a reason to bypass the database policy.

One concern per file; tests sit next to their source as `<name>.test.js`; names are camelCase with a domain prefix (`brainValidation.js`).

Use the shared boundaries: the clipboard helpers (insecure-origin support), `useSseProgress` for SSE, and the shared formatters for user-facing numbers and amounts (`client/src/AGENTS.md`).

## Adding a public module

A new file in `server/lib/`, `client/src/lib/`, `client/src/hooks/`, `client/src/utils/`, or a new `apiX.js` in `client/src/services/` **must** be re-exported from that directory's `index.js` barrel (`api.js` for services) and get a one-line row in its `README.md` (alphabetical in `server/lib/`). `server/lib/index.test.js` and its client counterparts enforce this.

Catalogs and barrels merge with git's `union` driver (`.gitattributes`): right for parallel insertions, wrong for an edit or deletion beside one, so after a rebase `scripts/catalog-merge-union.test.js` flags doubled or resurrected rows; keep one. Never give a file with real code paths the `union` attribute; the guard rejects any `.js` that isn't a pure re-export barrel.

When two modules in one directory export the same name, the barrel uses `export * as <name>` (callers write `brainValidation.settingsUpdateInputSchema`); catch-alls like `validation.js` stay flat, and a collision test fails on two flat exports sharing a name. Deep imports keep working; the barrel is for discovery (example: `server/lib/aiToolkit/index.js`).
