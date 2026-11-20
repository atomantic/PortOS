# client/src/services/ — HTTP, sockets, and browser-facing clients

API wrappers, Socket.IO client, and browser-facing clients (voice, DOM, UI dispatch).
**Before adding a new HTTP call inline, search the catalog first** — almost every backend
domain already has a service file.

Import directly from the domain module (`import { specificFn } from '.../services/apiX.js'`).
The former `api.js` all-domain barrel was retired (#17007) so lazy routes only download the API
wrappers they actually use; `client/src/services/index.test.js` forbids re-introducing a
multi-domain `services/api.js` barrel.

**App-shell and Dashboard code stay clear of large page modules.** Anything statically reachable
from `main.jsx` (`App.jsx`, `Layout`, the sidebar and ⌘K, their hooks) or `pages/Dashboard.jsx` /
`components/dashboard/` never imports `apiMusicVideo.js` or `apiPipeline.js`; the sidebar reads
their name lists from `apiNavNames.js`. `client/src/entryClosure.test.js` fails on a regression
and prints the import chain.

**App-shell code never imports the voice stack either.** Voice is off by default, so
`voiceClient.js`, `voiceFastPath.js`, `domIndex.js` and the audio helpers load with the voice
widget, on demand. The shell's only voice import is `components/voice/VoiceWidgetGate.jsx`,
which owns the voice config and exposes `useVoiceEnabled()`; the same test guards it.

## Discovery rule

```
node scripts/lib-catalog.js <term> --dir client/src/services
```

Each module opens with a one-sentence summary comment (at most 200 characters) that the catalog
prints; `client/src/services/moduleSummaries.test.js` enforces it.

The `request()` helper in `apiCore.js` toasts errors by default. Pass `{ silent: true }`
when the caller owns its own error UI (custom catch + toast, or `useAsyncAction` which
toasts on throw). **Custom catch ⇒ `silent: true`** — otherwise toasts fire twice.

