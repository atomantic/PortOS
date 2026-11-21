# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

That "every dependency" claim is enforced by `server/test/guards/repo/deps-doc.test.js` (run by `cd server && npm test`): every dependency needs a row under the workspace and dependency group that declares it. A row without a matching declaration fails unless its verdict records the removal (`REMOVED` / `REPLACED`).

**Last audited:** 2026-09-21 (routine sweep: 0 open Dependabot alerts, 0 vulnerabilities across root/server/client/autofixer, react/react-dom 19.3.0 held back by r3f peer cap #7370); prior 2026-09-12 (scoped: remove the redundant direct `google-auth-library`, issue #7013); prior 2026-09-11 (scoped: drop `@scalar/api-reference-react`, issue #7012); prior 2026-09-02 (scoped: `pdf-lib` → `@cantoo/pdf-lib`, issue #5672; parity sweep that added the missing `playwright-core` row and put this document under test — `server/test/guards/repo/deps-doc.test.js`, issue #5708); prior 2026-08-04 (scoped audit of the `keyv`/`cacheable` supply-chain compromise); prior follow-up 2026-07-14 (issue #2547), prior full audit 2026-04-28 (default mode), tables corrected 2026-07-01 during a docs audit.
**Verdict:** All remaining dependencies justified. The 2026-09-21 routine sweep verified that all direct dependencies are current, with 0 open Dependabot alerts on GitHub, clean audits across all workspaces, and react/react-dom 19.3.0 held back by @react-three/fiber's peer constraint (issue #7370). The 2026-09-12 follow-up removed the direct `google-auth-library@11.0.2` pin (issue #7013); At the time, Google OAuth switched to the copy pulled transitively by the scoped Calendar SDK. Issue #17210 later replaced that SDK with a REST adapter and pinned the existing OAuth version directly. The 2026-09-11 follow-up removed `@scalar/api-reference-react` (issue #7012) — the heaviest client dependency, ~half the lockfile and 3.24 MB of dist assets, including Vue 3 and the Vercel AI SDK advisory GHSA-866g-f22w-33x8. The REST Reference tab now lists OpenAPI operations natively. The 2026-08-04 audit replaced the client `eslint` lint stack with `@biomejs/biome`, dropping 110 net client packages including the `file-entry-cache → flat-cache → keyv` chain named in the August 2026 Shai-Hulud npm compromise (PortOS held safe versions throughout — see the detailed finding below). The same pass closed a latent hole where `ignore-scripts=true` was only active for repo-root installs, not for any workspace install or CI. Since the last full audit: `sax` was removed (replaced with an owned parser, issue #1824), `portos-ai-toolkit` was vendored in-tree (`server/lib/aiToolkit/`), and monolithic `googleapis` was replaced with scoped `@googleapis/*` packages. The 2026-07-14 follow-up bumped `kokoro-js` to its latest patch `1.2.1` (still on maintenance watch — no publish since 2025-05) and aligned the dual `pm2` pins (root + server both `7.0.4`). The 2026-09-02 follow-up replaced abandoned `pdf-lib` (no publish since 2022-05) with the maintained MIT fork `@cantoo/pdf-lib@2.9.1` — a same-public-API swap across the four export paths, done while `npm audit` was still clean rather than under advisory pressure.

## Audit Methodology

Each dependency is classified into one of three tiers:

- **Tier 1 (ACCEPTABLE)** — large, widely-audited, foundational libraries. Kept without question.
- **Tier 2 (SUSPECT)** — smaller libraries that may be replaceable. Audited for actual usage.
- **Tier 3 (REMOVABLE)** — clear candidates for owned-code replacement.

Before removing a Tier 3 candidate, run a transitive-dep check (`npm ls <pkg>`). If a kept package already pulls the same major version, the candidate is downgraded to **KEEP (transitive)** — direct removal saves no supply chain attack surface.

## Quick Reference Table

| Package | Tier | Verdict | Where Used | Notes |
|---------|------|---------|------------|-------|
| **Root dependencies** | | | | |
| `pm2` | 1 | KEEP | top-level scripts | Process manager, foundational. Declared in root `dependencies` (the root manifest has no devDependencies). Uses the same pin as the server |
| **Server dependencies** | | | | |
| `@babel/parser` | 1 | KEEP | JavaScript parsing for server features and developer tools | Parses source without executing it, including for the complexity report and prompt-stage call-site generator |
| `@cantoo/pdf-lib` | 2 | KEEP | PDF generation for the volume / comic / prose / legacy-archive exports | Maintained MIT fork of `pdf-lib`, which has had no publish since 2022-05. Same public API (`PDFDocument`/`rgb`/`StandardFonts`); the swap was 4 import lines. On maintenance watch — see the detailed finding |
| `pdf-lib` | — | REPLACED | PDF generation | 2026-09-02 → `@cantoo/pdf-lib` (issue #5672). Abandoned upstream: `1.17.1` is simultaneously the pinned and the latest published version, unchanged since 2022-05-12. Not deprecated and never flagged by `npm audit` — replaced ahead of an advisory, not in response to one |
| `@novnc/novnc` | 1 | KEEP | PortDeck remote desktop viewer | Mature RFB/VNC protocol implementation; replacing it would require owning multiple security types and framebuffer encodings |
| `@googleapis/calendar` | — | REPLACED | Calendar integration | Issue #17210 → `server/services/calendarApi.js`, a four-operation adapter for the fixed Calendar v3 origin. Removes the generated SDK, `googleapis-common`, and `url-template` |
| `@googleapis/gmail` | — | REPLACED | Messages/Gmail integration | Issue #12219 → `server/services/gmailApi.js`, a six-operation adapter for the fixed Gmail v1 origin using `OAuth2Client.request()` |
| `better-sqlite3-multiple-ciphers` | 2 | KEEP | `server/services/signalSnapshot.js` — read-only SQLCipher snapshot of the local Signal Desktop database | MIT build of better-sqlite3 with SQLCipher 4 compatibility. Ships prebuilds and sets `gypfile` false, so install does not compile it. `node:sqlite` cannot open SQLCipher, and a main-file copy misses committed WAL frames (#11149). A missing prebuild fails that sync closed |
| `chokidar` | 1 | KEEP | server file watching | Mature cross-platform file-system watcher used by server services |
| `compression` | — | REPLACED | server HTTP responses | Issue #17213 moved response compression to `node:zlib` in `server/lib/httpCompression.js` and removed four lockfile packages |
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `google-auth-library` | 1 | KEEP | Shared Calendar and Gmail OAuth | Issue #17210 pins the already-resolved `11.0.2` directly. The lazy-loaded `OAuth2Client` owns authorization, token exchange, refresh, and authenticated transport |
| `kokoro-js` | 2 | REMOVED | Former in-process TTS | Replaced by the in-tree Piper backend; existing settings migrate |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
| `playwright-core` | 1 | KEEP | `server/services/fableLoom/falVideoAutomation.js` — fal.ai scene video automation | Drives the PortOS-managed browser over CDP (`chromium.connectOverCDP`). `-core` rather than the full `playwright` package deliberately: the browser is provisioned separately by `npm run setup:browser`, so the bundled browser download would be dead weight |
| `pm2` | 1 | KEEP | app lifecycle | Process manager. Uses the same pin as the root |
| `sharp` | 1 | KEEP | image processing | Native, widely-audited |
| `socket.io` | 1 | KEEP | realtime | Foundational |
| `socket.io-client` | 1 | KEEP | server-to-client | Paired with socket.io |
| `trash` | — | REPLACED | Recoverable image/video history deletion (`server/lib/trashFiles.js`) | Issue #12246 → PortOS-owned adapters in `server/lib/nativeTrash.js` / `nativeTrashXdg.js` (ADR `docs/decisions/2026-10-18-native-trash-without-dependency.md`): `osascript` + `NSFileManager.trashItemAtURL` per file on macOS, Windows PowerShell 5.1 + shell32 `SHFileOperationW` with a fixed-drive pre-flight, freedesktop Trash 1.0 on `node:fs` for Linux. Removed the package's 57 lockfile entries, its ad-hoc-signed macOS binary and unsigned Windows executable |
| `three` | 1 | KEEP | code film rendering | Supplies the Three.js runtime for generated film pages |
| `undici` | 1 | KEEP | HTTP client | Node core team project |
| `ws` | 1 | KEEP | remote desktop + browser WebSockets | Foundational WebSocket transport; also used transitively by Socket.IO |
| `zod` | 1 | KEEP | input validation | Widely-audited |
| **Server devDependencies** | | | | |
| `eslint` | — | REMOVED | Former cyclomatic complexity reporter | The report now computes classic scores from the Babel AST |
| `vitest` | 1 | KEEP | test runner | |
| `@vitest/coverage-v8` | 1 | KEEP | coverage | Paired with vitest |
| **Client dependencies** | | | | |
| `@dnd-kit/core` | 1 | KEEP | drag/drop | |
| `@dnd-kit/sortable` | 1 | KEEP | drag/drop | |
| `@react-three/drei` | 1 | KEEP | CyberCity 3D | Three.js helpers |
| `@react-three/fiber` | 1 | KEEP | CyberCity 3D | React renderer for Three |
| `@scalar/api-reference-react` | — | REMOVED | Dev Tools → API Explorer | 2026-09-11 → native REST Reference tab (issue #7012). Was the heaviest client dep (~half the lockfile, 3.24 MB dist, Vue 3 + Vercel AI SDK). See detailed finding |
| `@xterm/xterm` | 1 | KEEP | browser terminal | |
| `@xterm/addon-fit` | — | REMOVED | xterm sizing | 2026-09-12 → in-tree terminal sizing helper (issue #7014) |
| `@xterm/addon-web-links` | — | REPLACED | xterm links | PortOS-owned link provider shared by the PTY and iTerm2 views (issue #17214) |
| `lucide-react` | 1 | KEEP | icons | Widely-used |
| `react` | 1 | KEEP | UI | |
| `react-dom` | 1 | KEEP | UI | |
| `react-router` | 1 | KEEP | routing | v8 dropped the `react-router-dom` alias package |
| `recharts` | 1 | KEEP | charts | |
| `socket.io-client` | 1 | KEEP | realtime client | |
| `three` | 1 | KEEP | 3D | |
| `three-stdlib` | — | REMOVED (direct) | 3D avatars | 2026-09-02 → `three/examples/jsm/utils/SkeletonUtils.js` (issue #5683). The sole direct import was `SkeletonUtils.clone`, which `three` itself ships. Still in the tree transitively via `@react-three/drei`, so this is a manifest cleanup, not a supply-chain reduction — the win is one fewer pin to Dependabot-bump and the removal of a pinned-vs-`^` drift surface against drei's own request |
| **Client devDependencies** | | | | |
| `@biomejs/biome` | 1 | KEEP | linting across the repo | Client owns the single installation used for local and CI linting |
| `eslint` | — | REMOVED (client) | linting | 2026-08-04 → `@biomejs/biome`. The server later used ESLint for its complexity report until #16999 |
| `@eslint/js` | — | REMOVED | linting | Removed with `eslint` |
| `@eslint-react/eslint-plugin` | — | REMOVED | linting | Removed with `eslint`; its 8 enabled rules map to Biome rules + one GritQL plugin |
| `eslint-plugin-react-hooks` | — | REMOVED | linting | Removed with `eslint`; `rules-of-hooks` → Biome `useHookAtTopLevel` |
| `typescript` | — | REMOVED | (none) | 2026-08-04. Was only here for `@eslint-react`'s peer dep; client has no tsconfig / `.ts` sources / `tsc` script |
| `@tailwindcss/postcss` | 1 | KEEP | styling | |
| `tailwindcss` | 1 | KEEP | styling | |
| `@vitejs/plugin-react` | 1 | KEEP | build | |
| `vite` | 1 | KEEP | build | |
| `vitest` | 1 | KEEP | client test runner | happy-dom environment |
| `happy-dom` | 1 | KEEP | test DOM | Paired with vitest. Replaced `jsdom` in #6144 — same suite, ~65% less time in `environment` |
| `@testing-library/jest-dom` | 1 | KEEP | test matchers | |
| `@testing-library/dom` | — | REMOVED (direct) | DOM test utilities | 2026-09-12 → imported through `@testing-library/react`; remains in the tree transitively, so this removes only the redundant direct pin |
| `@testing-library/react` | 1 | KEEP | component tests | |
| `@testing-library/user-event` | 1 | KEEP | interaction tests | |
| `playwright-core` | 1 | KEEP | browser test tooling | Drives the separately provisioned browser for client verification |
| `rollup-plugin-visualizer` | — | REMOVED | bundle-size analysis | `npm run build:analyze --prefix client` publishes `client/dist/bundle-report.json` with raw, gzip, and Brotli byte counts for each emitted file (#17212) |
| **Browser dependencies** | | | | |
| _(none)_ | — | — | `browser/server.js` | Zero dependencies — Node built-ins only, plus in-repo imports from `server/lib/` and `scripts/lib/`. No Dependabot entry, and its lockfile is gitignored |

## Detailed Findings — Tier 2/3 Audits

### `@cantoo/pdf-lib` — KEEP (Tier 2), replaced `pdf-lib` 2026-09-02 (issue #5672)

- **Usage**: 4 import sites, all the same named import — `server/services/pipeline/volumePdf.js`, `comicPdf.js`, `proseExport.js`, and `server/services/legacyExport.js` (`import { PDFDocument, rgb, StandardFonts }`). ~40 call sites across them, all in the narrow high-level core: `PDFDocument.create`, `addPage`, `embedFont`, `drawText`, `drawImage`, `widthOfTextAtSize`, `save`, plus `rgb()` and 9 `StandardFonts` constants. No low-level `PDFDict`/`PDFRef` work, no form filling, no encryption, no incremental update.
- **Why the swap**: `pdf-lib@1.17.1` has had **no npm publish since 2022-05-12** — the pinned version and the latest published version are the same release. It is not deprecated and `npm audit` was clean, but it is a parser/serializer for a hostile binary format sitting on the export path for four user-facing pipelines. When a PDF advisory lands there is no upstream release to take. Migrating while audit is green is a planned change; migrating after an advisory is an emergency.
- **The fork**: `@cantoo/pdf-lib` (`github.com/cantoo-scribe/pdf-lib`), same MIT license, pinned `2.9.1`, published 2026-08. It preserves the `PDFDocument` / `rgb` / `StandardFonts` public API, so the migration was 4 import lines + 1 manifest line + the lockfile — no output, layout, font, or page-geometry change.
- **Transitive cost**: `server/package-lock.json` goes 380 → 385 packages (**+5 net**). In: the fork plus `color`, `color-string`, `is-arrayish`, `simple-swizzle`, `html-entities`, `node-html-better-parser`, and a top-level `pako`. Out: `pdf-lib` and its nested `pako` / `tslib` copies. `@pdf-lib/standard-fonts` and `@pdf-lib/upng` **stay** — the fork depends on them too — and so does the top-level `tslib`, which other packages pull. `npm audit` stays at 0 vulnerabilities.
- **Replacement complexity if owned in-tree instead**: Infeasible (300+ lines of font metrics, xref tables, and content-stream encoding) — which is why a maintained fork, not a rewrite, was the decision.
- **Regression cover**: two boundary tests assert real output bytes rather than helper behaviour, because a same-API fork can only regress below the helper layer — `proseExport.test.js` (`buildProsePdf` returns a `Uint8Array` starting `%PDF-` and ending `%%EOF`) and `comicPdf.test.js` (image XObject count scales with the number of embedded pages, catching a silently-dropped `drawImage` payload).
- **Grep caveat for the next audit**: `server/services/legacyExport.js` contains a byte sequence that makes `file(1)` classify it as `data`, so plain `grep -r` **silently skips it** — a repo-wide dependency sweep must use `grep -ra`. That is exactly how the fourth import site was missed when this migration was first scoped; it surfaced only as an `ERR_MODULE_NOT_FOUND` in the suite.
- **Re-audit trigger**: revisit if `@cantoo/pdf-lib` itself goes >12 months without a publish, or on any CVE against it. The fallback is the same shape as the swap in: another maintained fork, or upstream `pdf-lib` if it ever resumes releases.

### `@scalar/api-reference-react` — REMOVED 2026-09-11 (issue #7012)

- **Usage (was)**: 1 import, in `client/src/components/api-explorer/ScalarReference.jsx`, which `client/src/pages/ApiExplorer.jsx` reached through a `lazy()` dynamic import on one route (Dev Tools → API Explorer, the REST Reference tab).
- **Measured footprint at removal** (2026-09-02, fresh `npm run build --prefix client`):
  - **Packages**: 261 of the client's 599 installed packages (44%) were reachable ONLY via Scalar. Scalar's own subtree was 282. The exclusive set included an entire second UI framework (`vue`, `radix-vue`, `@headlessui/vue`, `@floating-ui/vue`, `vue-sonner`, `@unhead/vue`) and the Vercel AI SDK (`ai`, `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@ai-sdk/vue`).
  - **Bundle**: 3.24 MB of dist assets against ~13.0 MB of built JS — `OperationBlock.vue-*.js` (2.21 MB), `ScalarReference-*.js` (608 KB), `AgentScalarChatInterface.vue-*.js` (197 KB), `ScalarReference-*.css` (250 KB).
- **Why it left**: `agent: { disabled: true }` was a runtime config value, so Rollup could not tree-shake the agent chat / AI SDK. An isolated Scalar/Swagger static page would have kept the same lockfile and advisory surface. The native catalog already listed HTTP operations; the REST tab now does the same for the Internal vs Exposed OpenAPI documents.
- **Replacement**: `RestReferenceView` in `client/src/pages/ApiExplorer.jsx` fetches `/api/api-docs/internal/openapi.json` or `/api/api-docs/openapi.json` and lists operations. No second UI framework.
- **Regression cover**: `client/src/pages/ApiExplorer.test.jsx` exercises the native REST reference, internal/exposed spec switching, search and stale-response handling. Production client builds remain in CI. The historical Scalar package/chunk absence pin and its separate post-build invocation were retired; current behavior is the regression boundary.
- **Re-audit trigger**: none — do not reintroduce Scalar or another OpenAPI SPA (rapidoc, Stoplight Elements) without a new depfree issue. The native list plus the raw JSON links is the reference UI.

### `kokoro-js` — REMOVED 2026-09-11

- **Decision**: retire the in-process backend in favor of the existing Piper CLI backend (#7011).
- **Dependencies**: removed kokoro-js and its exclusive tar/protobufjs overrides. Sharp remains a direct dependency used by image processing.
- **Upgrade**: migration 376 switches saved Kokoro settings to Piper, preserving the old settings and any customized Piper voice. Reads and saves also normalize restored legacy settings. Settings → Voice explains the change; choose a voice and use **Save & Reconcile** to install the binary/model. No models download during migration.
- **Character profiles**: historical Kokoro profiles and audio remain intact. Synthesis reports an actionable retirement error; select/promote a Piper preset to replace the binding rather than silently changing a character's voice.

### `google-auth-library` — REMOVED (direct) 2026-09-12 (issue #7013)

- **Usage (was)**: `server/services/googleAuth.js` imported `OAuth2Client` directly for the shared Calendar/Messages OAuth flow.
- **Resolution**: the service switched to `auth.OAuth2` from the existing `@googleapis/calendar` SDK. That export is the same `OAuth2Client` class supplied through `googleapis-common`, so authorization URLs, token exchange, credentials, and refresh-token persistence keep the existing behavior.
- **Transitive cost**: that change retained `google-auth-library@10.9.1` under `googleapis-common` (shared by the Calendar and Gmail SDKs) and removes the direct `11.0.2` copy plus its exclusive nested dependencies. This removes a redundant direct pin, not the transitive package itself.
- **Regression cover**: `server/test/guards/repo/deps-doc.test.js` and the Calendar route/account/sync suites pass; a direct module-load smoke check confirms that `auth.OAuth2` is constructible.


### `eslint` — removed from client lint and server complexity report

- **Trigger**: the August 2026 Shai-Hulud npm compromise hit `keyv`, `flat-cache`, and `file-entry-cache` (among ~430 packages). PortOS was **never exposed** — it held `keyv@4.5.4`, `flat-cache@4.0.1`, `file-entry-cache@8.0.0`, while the malicious releases were the *next major* in each line (`6.0.0` / `6.1.24` / `11.1.6`), unreachable from the `^4` / `^4.0.0` / `^8.0.0` ranges. npm has since unpublished all three, and no install hook ever existed in the tree.
- **Why they were here at all**: not direct dependencies. A single chain under one root — `eslint → file-entry-cache → flat-cache → keyv` — client workspace, devDependencies only. At the time, `eslint@10.8.0` required `file-entry-cache@^8.0.0`, so shedding that chain meant stopping use of eslint.
- **Semver headroom was already zero**: the highest published `file-entry-cache@8.x` *is* `8.0.0`, `flat-cache@4.x` *is* `4.0.1`, `keyv@4.x` *is* `4.5.4`. An `overrides` pin would have been a no-op — there was nowhere to float. Removal was therefore a **maintenance** win, not a security fix.
- **Resolution**: replaced eslint with `@biomejs/biome` (the Quick Reference row and `client/package.json` are the version's home — naming a pin here only drifts). Client lockfile **447 → 337 packages** (−110; the eslint tree out, 9 Biome entries in, only 1 platform binary installed). All four eslint-chain packages now report 0 occurrences in `client/package-lock.json`.
- **Server removal**: the server briefly used ESLint to report classic cyclomatic complexity. The report now uses the existing `@babel/parser` dependency, and both lint commands use the client Biome installation (#16999).
- **`typescript` went with it.** It was a client devDependency solely to satisfy `@eslint-react/eslint-plugin`'s peer dep — the client has no `tsconfig`, zero `.ts`/`.tsx` sources, no `tsc` script, and nothing peer-depends on it. Removing it also retires the `.github/dependabot.yml` ignore rule that pinned it below TS7 (and issue #3351, which tracked waiting on typescript-eslint for TS7 support — now moot).
- **Rule parity was proven with fixtures, not inferred from a clean run** — a linter with no rules also reports "0 problems". Every rule the old config enforced fires under Biome; `npm run lint` covers the same **1859 files** with 0 problems. `exhaustive-deps` was already `off` (documented, deliberate), which is what made this a half-day swap instead of a risky one.
- **The `crypto.randomUUID` ban survives as a GritQL plugin** (`client/lint-no-random-uuid.grit`). This rule is load-bearing: `crypto.randomUUID` is undefined on insecure origins, and PortOS is routinely reached over plain HTTP via Tailscale. It matches on the CST node kind rather than code snippets, so it catches `crypto.`, `globalThis.crypto.`, `window.`, `self.`, optional chaining, bare `typeof` references, and assignment targets — and, matching the old ESLint rule exactly, *not* `crypto['randomUUID']`. Exemptions for `src/lib/uuid.js` and `src/**/*.test.{js,jsx}` are expressed as **negated globs**, because a Biome override's `plugins` list is *additive*: `plugins: []` does NOT disable an inherited plugin. Do not "simplify" that back.
- **Deliberately scoped**: Biome's formatter and `assist` are disabled (enabling them would rewrite all 1859 files in one unreviewable diff), and the rule set uses `preset: "none"` with an explicit list rather than Biome's broader `recommended` — keeping this a tooling swap, not a smuggled lint-policy change. Adopting more Biome rules is a separate decision.
- **Config is `biome.jsonc`, not `biome.json`** — the latter rejects comments, failing with a misleading "expected an object, received an array", and the rationale comments inherited from `eslint.config.js` are worth keeping.

### `sax` — REMOVED (issue #1824)

- **History**: was used by `server/services/claudeChangelog.js` and the Apple Health XML import; originally kept as "transitive via pm2→needle" (the 2026-04 audit above).
- **Resolution**: replaced with an owned streaming parser (`server/services/appleHealthXmlParser.js`) in issue #1824, and pm2 7.x no longer pulls it. No longer in `server/package.json`.

## Heavy-Mode Notes

If `/do:depfree --heavy` is run, the following Tier 1 entries would drop to Tier 2/3 and become replacement candidates regardless of popularity:

- Many of the `@dnd-kit/*`, `@xterm/*`, `lucide-react`, `recharts` deps would be re-evaluated.
- `pm2` would NOT be replaced (foundational process manager).

This is intentionally NOT done in default mode — current dependency footprint is reasonable for the project's deployment context (single-user, Tailscale-private).

## Extreme-Mode Notes

`/do:depfree --extreme` (and the `better-dependency-freedom` scheduled audit with its removal bar set to **Extreme**) aims at zero dependencies: it forces the strongest model tier at maximum reasoning effort, drops the line ceiling in favor of a parity-test gate, and keeps only what cannot be owned responsibly — the Node runtime and npm, security-sensitive protocol implementations (the `pg` wire protocol and its authentication, TLS), native bindings (`node-pty`, `better-sqlite3-multiple-ciphers`, `sharp`), and the CI-required test runner. Under that bar the following Tier 1 entries become candidates, each needing a written replacement design and a parity suite before any call site switches:

- `express` — the used surface is routing, middleware chaining, static files, and body parsing over `node:http`.
- `socket.io` — the used surface is rooms, acks, and reconnection over WebSocket; a design must cover the client half too.
- `react` / `react-dom` — a product-level rewrite rather than a dependency swap; expected to be recorded `SKIPPED_INFEASIBLE` with a design sketch and a filed issue, which is the mode's required output for a package it cannot remove.
- `@googleapis/*` — direct REST calls plus owned OAuth signing.
- `chokidar`, `@dnd-kit/*`, `@xterm/*`, `lucide-react`, `recharts`, `three` — re-evaluated by used surface, not size.

An extreme run re-tests every `SKIPPED_INFEASIBLE` row here rather than honoring it, so this section is a forecast, not a decision log; the decision log is the tables above, which record the mode each row was reached under.

## Override Pins (`overrides`)

The authoritative current override pins are declared in the [`package.json`](../package.json) manifests for [root](../package.json), [server](../server/package.json), and [client](../client/package.json). Autofixer uses the server workspace’s Express dependency and lockfile. The retired Kokoro dependency tree no longer needs the `tar` or `protobufjs` override pins.

These overrides force-bump transitive dependencies to address known upstream advisories. Check the manifests for the current package and workspace list and exact versions; revisit the overrides if `npm audit` flags new advisories.

`server/test/guards/repo/dependency-overrides.test.js` guards the pins themselves (cross-manifest version parity, a `MINIMUM_SAFE` floor per remediated advisory, that every workspace shipping a tracked lockfile is in the governed manifest list, that each tracked lockfile actually resolves the pinned version, and that every pin names a package its own workspace lockfile still contains — so a pin outliving its consumer fails rather than lingering as imaginary protection), but it does not read this document. When a floor moves because a *new* advisory covers the version already pinned — as `js-yaml@4.3.0` did under GHSA-5p4m-2wfm-xmqj — update the authoritative manifest pin and its `MINIMUM_SAFE` row; this document links readers to those sources.

**Not every compromised package warrants a pin.** A pin only helps when the installed version is *below* the top of its permitted range — otherwise there is nothing to force. The former client tree affected by the August 2026 `keyv` / `flat-cache` / `file-entry-cache` compromise deliberately got **no** pin: each range was already at its ceiling, so a pin would have been a no-op, and that client tree was removed instead. Check headroom (`npm view <pkg>@<major> version`) before adding an entry here.

## Direct Dependency Pinning

**Every direct dependency and devDependency, in every manifest, is an exact version — no `^`, `~`, `>=`, or `*`.** A caret range lets a fresh `npm install` (or any tree re-resolution: a Dependabot bump to a sibling package, `npm run setup`'s cwd-based `npm install --no-save` in `server/`, `scripts/ensure-deps.js`'s clean-reinstall path) float past a version nobody reviewed — the same argument that already makes an override pin exact, applied to the packages this repo depends on directly. Upgrades arrive as reviewable Dependabot PRs instead.

`server/test/guards/repo/dependency-overrides.test.js` enforces this across all four manifests, so a dependency added with a caret fails the suite rather than shipping.

## Install-Script Policy

`ignore-scripts=true` is pinned in **every** workspace's own `.npmrc` (root, `client/`, `server/`, `browser/`) — not just the repo root. The list is not maintained by hand: `discoverWorkspaces()` in `scripts/trusted-rebuilds.js` globs every top-level directory carrying a `package.json`, and the test asserts each discovered one has the setting — so a workspace added later is caught rather than silently unguarded. npm resolves the project `.npmrc` from the *local prefix* and never walks up the directory tree, so a root-only setting does not cover `cd client && npm install` or `npm ci --prefix server` (what CI runs). Deleting any workspace `.npmrc` silently re-grants every dependency in that workspace an install-time code-execution slot — the vector the Shai-Hulud worm used.

Packages that legitimately need an install script are named explicitly in the allowlist in `scripts/trusted-rebuilds.js`, the single source consumed by `scripts/setup.js` (behind `npm run setup`, `setup.sh` and `setup.ps1`), `scripts/ensure-deps.js`, `update.sh` / `update.ps1`, and CI. `scripts/trusted-rebuilds.test.js` fails if a workspace `.npmrc` loses the setting, or if a dependency appears with an install hook that nobody has explicitly decided about. Because CI caches `server/node_modules` between jobs, `scripts/trusted-rebuild-stamp.js` writes a mark into the tree in the same step that rebuilds it and checks that mark after a cache restore — a tree cached before the rebuild is otherwise indistinguishable from a good one, since the allowlisted packages all ship prebuilt bindings and import fine either way.

### Install-time dependency patches

None at present. PortOS carried two from 2026-09/10 to 2026-10-21, both against packages that only PM2 pulled in through `proxy-agent`: an FTP LIST-date fallback for `get-uri` (#9444, #9462, with `basic-ftp` and `ip-address` overrides) and a recursion bound for `braces` (#9906, below). PM2 7.1.0 dropped `proxy-agent` and vendored `chokidar`, so none of those packages resolve in any lockfile and the patches, their overrides, their tests and the `patches` field of the trusted-rebuild stamp were removed with that bump. A tree stamped before the removal reads as stale and is rebuilt. If a patch is ever needed again, the hook point is `rebuildTrusted` in `scripts/trusted-rebuilds.js`, which every managed install path already calls after `npm install` because `ignore-scripts=true` rules out a postinstall hook.

### PM2 brace recursion advisory (#9906)

The upstream [braces advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) never got a patched braces release. PM2 7.1.0 (2026-10-21) vendors chokidar with a bounded brace expansion and drops the `braces` dependency, so no lockfile resolves `braces` any more; the local depth patch PortOS carried from 2026-10-03 (`scripts/lib/bracesDepthPatch.js`) went with it. If a future dependency reintroduces `braces` 3.x, check first whether the dependency can be moved off it before restoring the patch from history.

## Inline Audit Policy

`audit=false` is pinned in the same five `.npmrc` files, enforced by the same discovered-workspace test. This turns off only the advisory lookup `npm install` performs *after* it has already resolved and written `node_modules` — it does not change what gets installed.

It is off because it is a hang risk on the path that matters least. The lookup only prints a summary, but npm **blocks** on it, and a request that stalls costs `fetch-timeout` (300s by default) times `fetch-retries` (2) before npm gives up. On 2026-09-03 the endpoint began completing the TLS handshake and then never sending a byte; a warm root install that takes 0.15s took **153.88s**, of which 0.22s was CPU and the rest was a socket wait. Every managed install path runs four workspace installs in sequence (`update.sh`, `update.ps1`, `scripts/setup.js`, `scripts/ensure-deps.js`), so a self-update stalled for roughly ten minutes on a report written to `data/update.log`. PortOS is distributed software that self-updates on machines nobody is watching, so a third-party endpoint must not be able to wedge the update path for something advisory.

Nothing is lost. Dependency safety here is enforced statically rather than by a live network call: direct dependencies are pinned to exact versions and the `overrides` blocks are pinned too, both asserted by `server/test/guards/repo/dependency-overrides.test.js` — which deliberately replaced an `npm audit` shell-out because "audit needs the network and its output drifts". CI never ran `npm audit` either. Run `npm audit` directly when you want the report; the periodic dependency audits recorded in this document are where it belongs.
