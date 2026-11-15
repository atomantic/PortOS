# client/src/hooks/ — shared React hooks

State + lifecycle + side-effect hooks. **Before writing a `useX` hook, search the catalog first** — many domain patterns already
have one. There is no barrel: import the hook directly.

Pure helpers (no React state) live in `client/src/lib/`. HTTP/socket clients live in
`client/src/services/`. Formatting helpers live in `client/src/utils/`.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir client/src/hooks
```

Each module opens with a one-sentence summary comment (at most 200 characters) that the catalog
prints; `client/src/hooks/moduleSummaries.test.js` enforces it.

