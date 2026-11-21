# client/src/lib/ — shared client helpers

Pure / side-effect-free helpers used by pages, components, and hooks.
**Before adding a new helper here, search the catalog first** — if a similar module exists,
extend it. There is no barrel: import the module directly.

Hooks (state + lifecycle) live in `client/src/hooks/`. HTTP/socket clients live in
`client/src/services/`. Pure formatting helpers live in `client/src/utils/`.

**One pure module, one definition.** When the browser and the server need the same pure
logic, the client imports the `server/lib` leaf — `export { a, b } from '../../../server/lib/x.js'`
— it does not copy it. Import the leaf, and never the other
direction: nothing under `server/` may import from `client/`, because a client-only
dependency added to such a file breaks the server CI job. A server module the client
imports must reach no Node built-in and nothing outside `server/lib`; when the natural
home does (`storyBible.js` pulls `crypto`), split the pure part into its own leaf — or,
when the only impurity is an id the browser never mints, take it from `uuid.js`, which reads
the global WebCrypto and so keeps the leaf importable (browser code mints through `client/src/lib/uuid.js`).
`server/test/guards/modules/client-server-import-purity.test.js` and `server/test/guards/modules/server-imports-no-client.test.js`
enforce both halves.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir client/src/lib
```

Each module opens with a one-sentence summary comment (at most 200 characters) that the catalog
prints; `client/src/lib/moduleSummaries.test.js` enforces it.


For Music Video stages, search for `musicVideoStageProgress`, `musicVideoChecklists`,
`musicVideoPreviewSources`, or `musicVideoEstimates`. The `musicVideoStages.js` entry
point preserves the existing imports.
