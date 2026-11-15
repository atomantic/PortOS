# client/src/services/ — HTTP, sockets, and browser-facing clients

API wrappers, Socket.IO client, and browser-facing clients (voice, DOM, UI dispatch).
**Before adding a new HTTP call inline, search the catalog first** — almost every backend
domain already has a service file.

`api.js` is a barrel that re-exports everything from the `apiX.js` files; callers can
either `import * as api from '.../services/api'` or `import { specificFn } from '.../services/apiX'`.

When you add a new `apiX.js`, re-export it from `api.js`; `index.test.js` fails if it is missing.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir client/src/services
```

Each module opens with a one-sentence summary comment (at most 200 characters) that the catalog
prints; `client/src/services/moduleSummaries.test.js` enforces it.

The `request()` helper in `apiCore.js` toasts errors by default. Pass `{ silent: true }`
when the caller owns its own error UI (custom catch + toast, or `useAsyncAction` which
toasts on throw). **Custom catch ⇒ `silent: true`** — otherwise toasts fire twice.

