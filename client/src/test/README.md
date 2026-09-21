# client/src/test/

Shared test helpers for the client suite. Deliberately **not** a barrel — these are
test-only utilities, kept out of the enforced browser barrel described in the root
`AGENTS.md` Module Organization section on purpose (see the comments atop
`pageNavTabAssertions.js` / `ariaRefAssertions.js`). Grep this table before writing
a new one.

| File | What it's for |
| --- | --- |
| `actWarnings.js` | React act(...) warning diagnostics — records the test active when a warning was observed, without claiming to identify where asynchronous work began. |
| `ariaRefAssertions.js` | Asserts a rendered tree's `aria-controls`/`aria-labelledby` IDREFs all resolve to a real element. |
| `classNameScan.js` | Shared string-literal scanner (comment-stripping + literal walk) for the class-string convention guards. |
| `dndKeyboardDrag.js` | Drives a real `@dnd-kit` keyboard drag under happy-dom, stubbing the layout happy-dom can't provide. |
| `downloadPreflightConfirm.js` | `clickStartDownload` — waits for the confirm button to be enabled (built on `enabledBarrier.js`) before clicking, then settles. |
| `enabledBarrier.js` | `awaitEnabled` / `findEnabledByLabelText` / `findEnabledByRole` — wait for a control to be enabled, not just present, before interacting. |
| `fakeAudioContext.js` | Minimal Web Audio fake for playback tests (jsdom/node have no Web Audio). |
| `formValidityPolyfill.js` | Fixes happy-dom's constraint-validation (`stepMismatch`) so implicit form submission behaves like a real browser. |
| `imageGenPageMocks.jsx` | Shared `vi.mock` scaffold + fixtures + `renderImageGenPage()` for the ImageGen page suites. |
| `mockEventSource.js` | Minimal `EventSource` stand-in for jsdom, with manual `emit`/`emitRaw`/`fail` control. |
| `pageLoadBarrier.js` | `awaitPageLoaded` — waits for a page's loading skeleton (by its accessible label) to be removed. |
| `pageNavTabAssertions.js` | Pins a tabbed page's rendered tab id/label list against drift from the nav manifest it was built from. |
| `settledInput.js` | `typeSettled`/`clearSettled`/`retypeSettled` — waits for a controlled input's value to actually reflect the typed text before it's read. |
| `setup.js` | Vitest setup (auto-loaded): jest-dom matchers, the storage/form-validity polyfills, and the suite-wide async timeout. |
| `storagePolyfill.js` | In-memory `Storage` polyfill installed when the test environment's real one is absent or unusable. |
| `stripComments.js` | Blanks block/line comments out of a source string for the tree-wide convention guards that grep source. |
| `swSandbox.js` | Evaluates the real `public/sw.js` in an isolated vm sandbox to exercise its event listeners directly. |
| `timeouts.js` | `ASYNC_UTIL_TIMEOUT_MS` / `TEST_TIMEOUT_MS` — the suite's async time budgets, defined once so the ordering can't drift apart. |
| `trackedFiles.js` | Shared git-tracked file walker for the repo-hygiene guards. |
| `videoGenPageMocks.jsx` | Shared `vi.mock` scaffold + fixtures + `renderVideoGenPage()` for the VideoGen page suites. |
| `voiceHotkeySpy.js` | Stand-in for the voice widget's app-global push-to-talk hotkey, for asserting a surface claimed/didn't leak a key. |
