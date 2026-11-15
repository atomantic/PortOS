# client/src/utils/ — pure formatting & compute helpers

Lightweight, mostly-pure helpers used by pages, components, and hooks: formatters, time math,
small functional utilities, the OpenWorld scene-compute functions, and a few thin
browser-storage / file-read / module-loading helpers. **Before writing a helper here, search
the catalog first** — many domain patterns already have one. There is no barrel: import the
module directly.

State + lifecycle hooks live in `client/src/hooks/`. Shared client helpers with prompt/canon
logic (and server mirrors) live in `client/src/lib/`. HTTP/socket clients live in
`client/src/services/`.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir client/src/utils
```

Each module opens with a one-sentence summary comment (at most 200 characters) that the catalog
prints; `client/src/utils/moduleSummaries.test.js` enforces it.

## Notes

Provider helpers are split by the question each answers; `providers.js` is the compatibility
facade over all of them. Search the catalog for the question, then import the declaring module — that
is where each shared table is re-exported from its `server/lib` leaf.
