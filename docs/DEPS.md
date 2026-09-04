# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

That "every dependency" claim is enforced by `docs/deps-doc.test.js` (run by `cd server && npm test`): adding a dependency to any workspace manifest without a row here fails the suite, and a Quick Reference row naming a package no manifest declares fails too unless its verdict records the removal (`REMOVED` / `REPLACED`).

**Last audited:** 2026-09-02 (scoped: `pdf-lib` → `@cantoo/pdf-lib`, issue #5672; parity sweep that added the missing `playwright-core` row and put this document under test — `docs/deps-doc.test.js`, issue #5708); prior 2026-08-04 (scoped audit of the `keyv`/`cacheable` supply-chain compromise); prior follow-up 2026-07-14 (issue #2547), prior full audit 2026-04-28 (default mode), tables corrected 2026-07-01 during a docs audit.
**Verdict:** All dependencies justified. The 2026-08-04 audit replaced the entire `eslint` stack with `@biomejs/biome`, dropping 110 net client packages including the `file-entry-cache → flat-cache → keyv` chain named in the August 2026 Shai-Hulud npm compromise (PortOS held safe versions throughout — see the detailed finding below). The same pass closed a latent hole where `ignore-scripts=true` was only active for repo-root installs, not for any workspace install or CI. Since the last full audit: `sax` was removed (replaced with an owned parser, issue #1824), `portos-ai-toolkit` was vendored in-tree (`server/lib/aiToolkit/`), and monolithic `googleapis` was replaced with scoped `@googleapis/*` packages. The 2026-07-14 follow-up bumped `kokoro-js` to its latest patch `1.2.1` (still on maintenance watch — no publish since 2025-05) and aligned the dual `pm2` pins (root + server both `7.0.4`). The 2026-09-02 follow-up replaced abandoned `pdf-lib` (no publish since 2022-05) with the maintained MIT fork `@cantoo/pdf-lib@2.9.1` — a same-public-API swap across the four export paths, done while `npm audit` was still clean rather than under advisory pressure.

## Audit Methodology

Each dependency is classified into one of three tiers:

- **Tier 1 (ACCEPTABLE)** — large, widely-audited, foundational libraries. Kept without question.
- **Tier 2 (SUSPECT)** — smaller libraries that may be replaceable. Audited for actual usage.
- **Tier 3 (REMOVABLE)** — clear candidates for owned-code replacement.

Before removing a Tier 3 candidate, run a transitive-dep check (`npm ls <pkg>`). If a kept package already pulls the same major version, the candidate is downgraded to **KEEP (transitive)** — direct removal saves no supply chain attack surface.

## Quick Reference Table

| Package | Tier | Verdict | Where Used | Notes |
|---------|------|---------|------------|-------|
| **Root deps** | | | | |
| `pm2` | 1 | KEEP | top-level scripts | Process manager, foundational. Declared in root `dependencies` (the root manifest has no devDependencies). Pinned `7.0.4` (aligned with server pin) |
| **Server deps** | | | | |
| `@cantoo/pdf-lib` | 2 | KEEP | PDF generation for the volume / comic / prose / legacy-archive exports | Maintained MIT fork of `pdf-lib`, which has had no publish since 2022-05. Same public API (`PDFDocument`/`rgb`/`StandardFonts`); the swap was 4 import lines. On maintenance watch — see the detailed finding |
| `pdf-lib` | — | REPLACED | PDF generation | 2026-09-02 → `@cantoo/pdf-lib` (issue #5672). Abandoned upstream: `1.17.1` is simultaneously the pinned and the latest published version, unchanged since 2022-05-12. Not deprecated and never flagged by `npm audit` — replaced ahead of an advisory, not in response to one |
| `@novnc/novnc` | 1 | KEEP | PortDeck remote desktop viewer | Mature RFB/VNC protocol implementation; replacing it would require owning multiple security types and framebuffer encodings |
| `@googleapis/calendar` | 1 | KEEP | Calendar integration | Scoped official Google SDK (replaced monolithic `googleapis`) |
| `@googleapis/gmail` | 1 | KEEP | Messages/Gmail integration | Scoped official Google SDK |
| `chokidar` | 1 | KEEP | server file watching | Mature cross-platform file-system watcher used by server services |
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `google-auth-library` | 1 | KEEP | Google OAuth | Pairs with `@googleapis/*` |
| `kokoro-js` | 2 | KEEP | `server/services/voice/tts-kokoro.js` | Only pure-JS in-process TTS; replacement = Python subprocess + pooling |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
| `playwright-core` | 1 | KEEP | `server/services/fableLoom/falVideoAutomation.js` — fal.ai scene video automation | Drives the PortOS-managed browser over CDP (`chromium.connectOverCDP`). `-core` rather than the full `playwright` package deliberately: the browser is provisioned separately by `npm run setup:browser`, so the bundled browser download would be dead weight |
| `pm2` | 1 | KEEP | app lifecycle | Process manager. Pinned `7.0.4` (aligned with root pin) |
| `sharp` | 1 | KEEP | image processing | Native, widely-audited |
| `socket.io` | 1 | KEEP | realtime | Foundational |
| `socket.io-client` | 1 | KEEP | server-to-client | Paired with socket.io |
| `undici` | 1 | KEEP | HTTP client | Node core team project |
| `ws` | 1 | KEEP | remote desktop + browser WebSockets | Foundational WebSocket transport; also used transitively by Socket.IO |
| `zod` | 1 | KEEP | input validation | Widely-audited |
| **Server devDeps** | | | | |
| `vitest` | 1 | KEEP | test runner | |
| `@vitest/coverage-v8` | 1 | KEEP | coverage | Paired with vitest |
| **Client deps** | | | | |
| `@dnd-kit/core` | 1 | KEEP | drag/drop | |
| `@dnd-kit/sortable` | 1 | KEEP | drag/drop | |
| `@react-three/drei` | 1 | KEEP | CyberCity 3D | Three.js helpers |
| `@react-three/fiber` | 1 | KEEP | CyberCity 3D | React renderer for Three |
| `@scalar/api-reference-react` | 2 | KEEP | Dev Tools → API Explorer | Interactive OpenAPI reference UI. Heaviest client dependency by far — 261/599 packages, 3.24 MB of dist assets. Kept for lack of a maintained lighter alternative; bounded by a budget test. See detailed finding |
| `@xterm/xterm` | 1 | KEEP | browser terminal | |
| `@xterm/addon-fit` | 1 | KEEP | xterm sizing | |
| `@xterm/addon-web-links` | 1 | KEEP | xterm links | |
| `lucide-react` | 1 | KEEP | icons | Widely-used |
| `react` | 1 | KEEP | UI | |
| `react-dom` | 1 | KEEP | UI | |
| `react-router` | 1 | KEEP | routing | v8 dropped the `react-router-dom` alias package |
| `recharts` | 1 | KEEP | charts | |
| `socket.io-client` | 1 | KEEP | realtime client | |
| `three` | 1 | KEEP | 3D | |
| `three-stdlib` | — | REMOVED (direct) | 3D avatars | 2026-09-02 → `three/examples/jsm/utils/SkeletonUtils.js` (issue #5683). The sole direct import was `SkeletonUtils.clone`, which `three` itself ships. Still in the tree transitively via `@react-three/drei`, so this is a manifest cleanup, not a supply-chain reduction — the win is one fewer pin to Dependabot-bump and the removal of a pinned-vs-`^` drift surface against drei's own request |
| **Client devDeps** | | | | |
| `@biomejs/biome` | 1 | KEEP | linting | Replaced the whole eslint stack 2026-08-04; native binary, 0 regular deps + 8 platform optionals (1 installed) |
| `eslint` | — | REMOVED | linting | 2026-08-04 → `@biomejs/biome`. 53 packages were reachable only via `eslint` itself (incl. the `file-entry-cache → flat-cache → keyv` chain); 110 net once the plugin subtrees and orphaned `typescript` go too. `minimatch` and `brace-expansion` left the tree with it (both now 0 occurrences in every lockfile), so neither needs an override pin — do not re-add one |
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
| `@testing-library/dom` | 1 | KEEP | DOM test utilities | Foundation for the client Testing Library stack |
| `@testing-library/react` | 1 | KEEP | component tests | |
| `@testing-library/user-event` | 1 | KEEP | interaction tests | |
| `rollup-plugin-visualizer` | 2 | KEEP | bundle-size analysis | Dev-only, opt-in |
| **Autofixer deps** | | | | |
| `express` | 1 | KEEP | `autofixer/ui.js` | Same framework and pin (`5.2.1`) as the server workspace, but a separate install prefix with its own lockfile — so it needs its own `overrides` block to inherit the server's express-tree pins |
| **Browser workspace** | | | | |
| _(none)_ | — | — | `browser/server.js` | Zero dependencies — Node built-ins only, plus one in-repo import from `server/lib/`. No Dependabot entry, and its lockfile is gitignored |

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

### `@scalar/api-reference-react` — KEEP (Tier 2)

- **Usage**: 1 import, in `client/src/components/api-explorer/ScalarReference.jsx`, which `client/src/pages/ApiExplorer.jsx` reaches through a `lazy()` dynamic import on one route (Dev Tools → API Explorer, the REST Reference tab). No other call site.
- **Measured footprint** (2026-09-02, fresh `npm run build --prefix client`):
  - **Packages**: 261 of the client's 599 installed packages (44%) are reachable ONLY via Scalar — computed by walking each top-level dependency's transitive closure in `client/package-lock.json` and subtracting every closure that does not include Scalar. Scalar's own subtree is 282. The exclusive set includes an entire second UI framework (`vue`, `radix-vue`, `@headlessui/vue`, `@floating-ui/vue`, `vue-sonner`, `@unhead/vue`) and the Vercel AI SDK (`ai`, `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@ai-sdk/vue`).
  - **Bundle**: 3.24 MB of dist assets against ~13.0 MB of built JS — `OperationBlock.vue-*.js` (2.21 MB, the single largest chunk in the app, roughly twice the whole three.js vendor bundle), `ScalarReference-*.js` (608 KB), `AgentScalarChatInterface.vue-*.js` (197 KB), `ScalarReference-*.css` (250 KB).
- **The AI SDK is a hard dependency, not an optional peer**: `@scalar/api-reference` depends on `@scalar/agent-chat`, whose own dependencies include `ai` and `@ai-sdk/vue`. `agent: { disabled: true }` in `ScalarReference.jsx` is a **runtime** config value, so Rollup cannot tree-shake on it — the agent chat interface is emitted as its own chunk regardless. Turning the feature off changes the UI, not the build.
- **What bounds the user-facing cost**: the `lazy()` import. None of this is in the initial payload; it downloads only when a developer opens the REST Reference tab.
- **Replacement complexity**: Complex, and every surveyed alternative is worse. `rapidoc` has had no publish since 2024-10 (trading a heavy maintained dependency for an unmaintained one), and `@stoplight/elements` is comparably large. Owning an OpenAPI renderer is a project of its own.
- **Decision**: KEEP, bounded by a test. What was missing here was measurement, not removal.
- **Regression cover**: `client/src/pages/ApiExplorer.bundle.test.js` sums the Scalar-attributable `client/dist/assets` files and asserts they stay under a **4.0 MB** budget (~23% headroom over the measured 3.24 MB). It skips itself when `client/dist` is absent, so the plain unit-test job stays green; CI runs it as its own step right after `npm run build --prefix client`, against a fresh build rather than a stale `dist/`. A companion assertion pins non-vacuity — it fails if no `ScalarReference-*.js` chunk is found, so a Vite chunk-naming change cannot turn the budget into a 0-byte pass. This is the only test in the client suite that looks at build output; every other one runs against source, so a version bump that doubles the chunk is otherwise completely unobserved.
- **Re-audit trigger**: revisit if the budget test fails (re-measure and decide deliberately — do not reflexively raise the number), if Scalar drops the `agent` config toggle, or if a maintained framework-free OpenAPI renderer appears.

### `kokoro-js` — KEEP (Tier 2)

- **Usage**: 1 dynamic import in `server/services/voice/tts-kokoro.js` (~80 LOC module). 3 call sites: `KokoroTTS.from_pretrained()`, `tts.generate(text, {voice, speed})`, `audio.toWav()`.
- **Maintenance**: pinned at `1.2.1` (latest; published 2025-05-03). **Maintenance watch** — no publish since ~May 2025, so the package is effectively stale even at latest. This is not disqualifying today (small, pure-JS, no CVEs), but re-evaluate on the trigger below.
- **Vulns**: None (npm audit clean).
- **Replacement complexity**: Moderate (~50–80 LOC) but requires Python subprocess + JSON IPC + process pooling + lifecycle management. Operational overhead exceeds the supply-chain risk.
- **Decision**: KEEP (on maintenance watch). The only pure-JS in-process TTS option; Web Speech API is cloud-dependent and Piper requires CLI install.
- **Re-audit trigger**: the >12-months-stale trigger already fired and was actioned by this audit (bumped to latest, put on watch). Re-evaluate on any of: a CVE reported, the model-load path breaking against a newer Transformers.js, or the package still showing no upstream publish at the next dependency audit — then revisit and migrate (see escape hatch below).
- **Piper escape hatch (if dropped later)**: Piper is **already implemented** as a peer backend — `server/services/voice/tts-piper.js` (`synthesizePiper(text, cfg, signal) → { wav, latencyMs }`, plus `listPiperVoices`), which `server/services/voice/tts.js` already dispatches to alongside `synthesizeKokoro`. Both backends share the same `(text, cfg, signal) → { wav, latencyMs }` contract, so dropping `kokoro-js` is a delete, not a rewrite: remove the `kokoro` branch (and the `tts-kokoro.js` module + its `kokoro-js` dependency) from the dispatcher in `tts.js` and let Piper be the default engine. The tradeoff Piper carries — and the reason it isn't the default today — is a native `piper` binary + ONNX voice download (vs. `kokoro-js`'s npm-only, in-process install).

### `eslint` (and the `keyv` / `flat-cache` / `file-entry-cache` chain) — REMOVED 2026-08-04

- **Trigger**: the August 2026 Shai-Hulud npm compromise hit `keyv`, `flat-cache`, and `file-entry-cache` (among ~430 packages). PortOS was **never exposed** — it held `keyv@4.5.4`, `flat-cache@4.0.1`, `file-entry-cache@8.0.0`, while the malicious releases were the *next major* in each line (`6.0.0` / `6.1.24` / `11.1.6`), unreachable from the `^4` / `^4.0.0` / `^8.0.0` ranges. npm has since unpublished all three, and no install hook ever existed in the tree.
- **Why they were here at all**: not direct dependencies. A single chain under one root — `eslint → file-entry-cache → flat-cache → keyv` — client workspace, devDependencies only. `eslint@10.8.0` (latest) hard-requires `file-entry-cache@^8.0.0`; no eslint release drops it. So the only way to shed them was to stop using eslint.
- **Semver headroom was already zero**: the highest published `file-entry-cache@8.x` *is* `8.0.0`, `flat-cache@4.x` *is* `4.0.1`, `keyv@4.x` *is* `4.5.4`. An `overrides` pin would have been a no-op — there was nowhere to float. Removal was therefore a **maintenance** win, not a security fix.
- **Resolution**: replaced eslint with `@biomejs/biome` (the Quick Reference row and `client/package.json` are the version's home — naming a pin here only drifts). Client lockfile **447 → 337 packages** (−110; the eslint tree out, 9 Biome entries in, only 1 platform binary installed). All four eslint-chain packages now report 0 occurrences in `client/package-lock.json`.
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

- `@googleapis/calendar` / `@googleapis/gmail` — narrow surface used; could be replaced with direct REST calls + owned auth.
- Many of the `@dnd-kit/*`, `@xterm/*`, `lucide-react`, `recharts` deps would be re-evaluated.
- `pm2` would NOT be replaced (foundational process manager).

This is intentionally NOT done in default mode — current dependency footprint is reasonable for the project's deployment context (single-user, Tailscale-private).

## Override Pins (`overrides`)

Defined in `package.json` (root + server + client + autofixer) — kept current to dodge known upstream advisories:

- `ws@8.21.3` (all three)
- `lodash@4.18.1`, `follow-redirects@1.16.0`, `js-yaml@4.3.1`, `ip-address@10.5.0` (root + server)
- `nanoid@3.3.18`, `socket.io-parser@4.2.7` (server + client)
- `path-to-regexp@8.4.2`, `body-parser@2.3.0`, `qs@6.15.3` (server + autofixer — the express-reachable subset; `autofixer/` mirrors only these three because a pin for a package absent from the tree reads as protection that does not exist)
- `tar@7.5.22` (server only)
- `engine.io@6.6.9` (server only)
- `postcss@8.5.26` (server only)
- `protobufjs@7.6.5` + `@protobufjs/utf8@1.1.2` (server only)
- `sharp@0.35.4` (server only, collapses the nested copy `@huggingface/transformers` requests)
- `three@0.185.1` (client only, keeps drei/fiber on one three copy)

These exist purely to force-bump transitive deps; revisit if `npm audit` flags new advisories.

**Keep this list in sync with the manifests** — a stale entry here reads as a pin that exists when it doesn't. `server/dependency-overrides.test.js` guards the pins themselves (cross-manifest version parity, a `MINIMUM_SAFE` floor per remediated advisory, that every workspace shipping a tracked lockfile is in the governed manifest list, that each tracked lockfile actually resolves the pinned version, and that every pin names a package its own workspace lockfile still contains — so a pin outliving its consumer fails rather than lingering as imaginary protection), but it does not read this document. When a floor moves because a *new* advisory covers the version already pinned — as `js-yaml@4.3.0` did under GHSA-5p4m-2wfm-xmqj — bump the pin, the `MINIMUM_SAFE` row, and this list together.

**Not every compromised package warrants a pin.** A pin only helps when the installed version is *below* the top of its permitted range — otherwise there is nothing to force. The August 2026 `keyv` / `flat-cache` / `file-entry-cache` compromise deliberately got **no** pin: each range was already at its ceiling (highest published `keyv@4.x` *is* `4.5.4`, etc.), so a pin would have been a no-op, and the packages were removed outright instead. Check headroom (`npm view <pkg>@<major> version`) before adding an entry here.

## Direct Dependency Pinning

**Every direct dependency and devDependency, in every manifest, is an exact version — no `^`, `~`, `>=`, or `*`.** A caret range lets a fresh `npm install` (or any tree re-resolution: a Dependabot bump to a sibling package, `npm run setup`'s `npm install --no-save --prefix server`, `scripts/ensure-deps.js`'s clean-reinstall path) float past a version nobody reviewed — the same argument that already makes an override pin exact, applied to the packages this repo depends on directly. Upgrades arrive as reviewable Dependabot PRs instead.

`server/dependency-overrides.test.js` enforces this across all four manifests, so a dependency added with a caret fails the suite rather than shipping.

## Install-Script Policy

`ignore-scripts=true` is pinned in **every** workspace's own `.npmrc` (root, `client/`, `server/`, `autofixer/`, `browser/`) — not just the repo root. The list is not maintained by hand: `discoverWorkspaces()` in `scripts/trusted-rebuilds.js` globs every top-level directory carrying a `package.json`, and the test asserts each discovered one has the setting — so a workspace added later is caught rather than silently unguarded. npm resolves the project `.npmrc` from the *local prefix* and never walks up the directory tree, so a root-only setting does not cover `cd client && npm install` or `npm ci --prefix server` (what CI runs). Deleting any workspace `.npmrc` silently re-grants every dependency in that workspace an install-time code-execution slot — the vector the Shai-Hulud worm used.

Packages that legitimately need an install script are named explicitly in the allowlist in `scripts/trusted-rebuilds.js`, the single source consumed by `npm run setup`, `scripts/ensure-deps.js`, `setup.ps1`, `update.sh` / `update.ps1`, and CI. `scripts/trusted-rebuilds.test.js` fails if a workspace `.npmrc` loses the setting, or if a dependency appears with an install hook that nobody has explicitly decided about. Because CI caches `server/node_modules` between jobs, `scripts/trusted-rebuild-stamp.js` writes a mark into the tree in the same step that rebuilds it and checks that mark after a cache restore — a tree cached before the rebuild is otherwise indistinguishable from a good one, since the allowlisted packages all ship prebuilt bindings and import fine either way.

## Inline Audit Policy

`audit=false` is pinned in the same five `.npmrc` files, enforced by the same discovered-workspace test. This turns off only the advisory lookup `npm install` performs *after* it has already resolved and written `node_modules` — it does not change what gets installed.

It is off because it is a hang risk on the path that matters least. The lookup only prints a summary, but npm **blocks** on it, and a request that stalls costs `fetch-timeout` (300s by default) times `fetch-retries` (2) before npm gives up. On 2026-09-03 the endpoint began completing the TLS handshake and then never sending a byte; a warm root install that takes 0.15s took **153.88s**, of which 0.22s was CPU and the rest was a socket wait. Every managed install path runs four workspace installs in sequence (`update.sh`, `update.ps1`, `setup.ps1`, `npm run setup`, `scripts/ensure-deps.js`), so a self-update stalled for roughly ten minutes on a report written to `data/update.log`. PortOS is distributed software that self-updates on machines nobody is watching, so a third-party endpoint must not be able to wedge the update path for something advisory.

Nothing is lost. Dependency safety here is enforced statically rather than by a live network call: direct dependencies are pinned to exact versions and the `overrides` blocks are pinned too, both asserted by `server/dependency-overrides.test.js` — which deliberately replaced an `npm audit` shell-out because "audit needs the network and its output drifts". CI never ran `npm audit` either. Run `npm audit` directly when you want the report; the periodic dependency audits recorded in this document are where it belongs.
