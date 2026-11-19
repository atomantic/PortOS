# client/src/services/ — HTTP, sockets, and browser-facing clients

API wrappers, Socket.IO client, and browser-facing clients (voice, DOM, UI dispatch).
**Before adding a new HTTP call inline, search the catalog first** — almost every backend
domain already has a service file.

`api.js` is a barrel that re-exports everything from the `apiX.js` files; callers can
either `import * as api from '.../services/api'` or `import { specificFn } from '.../services/apiX'`.

**App-shell code never imports the barrel.** Anything statically reachable from `main.jsx`
(`App.jsx`, `Layout`, the sidebar and ⌘K, their hooks) imports the specific `apiX.js` module,
because one barrel import puts every API wrapper on every cold load. The same holds for the
large page modules `apiMusicVideo.js` and `apiPipeline.js`; the sidebar reads their name lists
from `apiNavNames.js`. `client/src/entryClosure.test.js` fails on a regression and prints the
import chain. Lazy pages may keep using the barrel.

**The landing Dashboard closure follows the same rule.** `pages/Dashboard.jsx` and every
`components/dashboard/` widget load on the first paint, so the same ban applies to them: each
is a root in `entryClosure.test.js` and must not reach `api.js` statically (#16813).

**App-shell code never imports the voice stack either.** Voice is off by default, so
`voiceClient.js`, `voiceFastPath.js`, `domIndex.js` and the audio helpers load with the voice
widget, on demand. The shell's only voice import is `components/voice/VoiceWidgetGate.jsx`,
which owns the voice config and exposes `useVoiceEnabled()`; the same test guards it.

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

