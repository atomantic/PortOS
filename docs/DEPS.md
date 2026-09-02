# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

**Last audited:** 2026-08-04 (scoped audit of the `keyv`/`cacheable` supply-chain compromise); prior follow-up 2026-07-14 (issue #2547), prior full audit 2026-04-28 (default mode), tables corrected 2026-07-01 during a docs audit.
**Verdict:** All dependencies justified. The 2026-08-04 audit replaced the entire `eslint` stack with `@biomejs/biome`, dropping 110 net client packages including the `file-entry-cache → flat-cache → keyv` chain named in the August 2026 Shai-Hulud npm compromise (PortOS held safe versions throughout — see the detailed finding below). The same pass closed a latent hole where `ignore-scripts=true` was only active for repo-root installs, not for any workspace install or CI. Since the last full audit: `sax` was removed (replaced with an owned parser, issue #1824), `portos-ai-toolkit` was vendored in-tree (`server/lib/aiToolkit/`), and monolithic `googleapis` was replaced with scoped `@googleapis/*` packages. The 2026-07-14 follow-up bumped `kokoro-js` to its latest patch `1.2.1` (still on maintenance watch — no publish since 2025-05) and aligned the dual `pm2` pins (root + server both `7.0.4`).

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
| `@novnc/novnc` | 1 | KEEP | PortDeck remote desktop viewer | Mature RFB/VNC protocol implementation; replacing it would require owning multiple security types and framebuffer encodings |
| `@googleapis/calendar` | 1 | KEEP | Calendar integration | Scoped official Google SDK (replaced monolithic `googleapis`) |
| `@googleapis/gmail` | 1 | KEEP | Messages/Gmail integration | Scoped official Google SDK |
| `chokidar` | 1 | KEEP | server file watching | Mature cross-platform file-system watcher used by server services |
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `google-auth-library` | 1 | KEEP | Google OAuth | Pairs with `@googleapis/*` |
| `kokoro-js` | 2 | KEEP | `server/services/voice/tts-kokoro.js` | Only pure-JS in-process TTS; replacement = Python subprocess + pooling |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pdf-lib` | 1 | KEEP | PDF generation/manipulation | |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
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
| `@scalar/api-reference-react` | 1 | KEEP | Dev Tools → API Explorer | Interactive OpenAPI reference UI rendering |
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
| `three-stdlib` | 1 | KEEP | CyberCity 3D | Community-maintained Three.js utilities used by the client renderer |
| **Client devDeps** | | | | |
| `@biomejs/biome` | 1 | KEEP | linting | Replaced the whole eslint stack 2026-08-04; native binary, 0 regular deps + 8 platform optionals (1 installed) |
| `eslint` | — | REMOVED | linting | 2026-08-04 → `@biomejs/biome`. 53 packages were reachable only via `eslint` itself (incl. the `file-entry-cache → flat-cache → keyv` chain); 110 net once the plugin subtrees and orphaned `typescript` go too |
| `@eslint/js` | — | REMOVED | linting | Removed with `eslint` |
| `@eslint-react/eslint-plugin` | — | REMOVED | linting | Removed with `eslint`; its 8 enabled rules map to Biome rules + one GritQL plugin |
| `eslint-plugin-react-hooks` | — | REMOVED | linting | Removed with `eslint`; `rules-of-hooks` → Biome `useHookAtTopLevel` |
| `typescript` | — | REMOVED | (none) | 2026-08-04. Was only here for `@eslint-react`'s peer dep; client has no tsconfig / `.ts` sources / `tsc` script |
| `@tailwindcss/postcss` | 1 | KEEP | styling | |
| `tailwindcss` | 1 | KEEP | styling | |
| `@vitejs/plugin-react` | 1 | KEEP | build | |
| `vite` | 1 | KEEP | build | |
| `vitest` | 1 | KEEP | client test runner | jsdom environment |
| `jsdom` | 1 | KEEP | test DOM | Paired with vitest |
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
- **Resolution**: replaced eslint with `@biomejs/biome@2.5.7`. Client lockfile **447 → 337 packages** (−110; the eslint tree out, 9 Biome entries in, only 1 platform binary installed). All four eslint-chain packages now report 0 occurrences in `client/package-lock.json`.
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
- `brace-expansion@5.0.9` (client only)
- `minimatch@3 → brace-expansion@1.1.18` (client only, scoped)
- `three@0.185.1` (client only, keeps drei/fiber on one three copy)

These exist purely to force-bump transitive deps; revisit if `npm audit` flags new advisories.

**Keep this list in sync with the manifests** — a stale entry here reads as a pin that exists when it doesn't. `server/dependency-overrides.test.js` guards the pins themselves (cross-manifest version parity, a `MINIMUM_SAFE` floor per remediated advisory, that every workspace shipping a tracked lockfile is in the governed manifest list, and that each tracked lockfile actually resolves the pinned version), but it does not read this document. When a floor moves because a *new* advisory covers the version already pinned — as `js-yaml@4.3.0` did under GHSA-5p4m-2wfm-xmqj — bump the pin, the `MINIMUM_SAFE` row, and this list together.

**Not every compromised package warrants a pin.** A pin only helps when the installed version is *below* the top of its permitted range — otherwise there is nothing to force. The August 2026 `keyv` / `flat-cache` / `file-entry-cache` compromise deliberately got **no** pin: each range was already at its ceiling (highest published `keyv@4.x` *is* `4.5.4`, etc.), so a pin would have been a no-op, and the packages were removed outright instead. Check headroom (`npm view <pkg>@<major> version`) before adding an entry here.

## Install-Script Policy

`ignore-scripts=true` is pinned in **every** workspace's own `.npmrc` (root, `client/`, `server/`, `autofixer/`, `browser/`) — not just the repo root. The list is not maintained by hand: `discoverWorkspaces()` in `scripts/trusted-rebuilds.js` globs every top-level directory carrying a `package.json`, and the test asserts each discovered one has the setting — so a workspace added later is caught rather than silently unguarded. npm resolves the project `.npmrc` from the *local prefix* and never walks up the directory tree, so a root-only setting does not cover `cd client && npm install` or `npm ci --prefix server` (what CI runs). Deleting any workspace `.npmrc` silently re-grants every dependency in that workspace an install-time code-execution slot — the vector the Shai-Hulud worm used.

Packages that legitimately need an install script are named explicitly in the allowlist in `scripts/trusted-rebuilds.js`, the single source consumed by `npm run setup`, `scripts/ensure-deps.js`, `setup.ps1`, `update.sh` / `update.ps1`, and CI. `scripts/trusted-rebuilds.test.js` fails if a workspace `.npmrc` loses the setting, or if a dependency appears with an install hook that nobody has explicitly decided about. Because CI caches `server/node_modules` between jobs, `scripts/trusted-rebuild-stamp.js` writes a mark into the tree in the same step that rebuilds it and checks that mark after a cache restore — a tree cached before the rebuild is otherwise indistinguishable from a good one, since the allowlisted packages all ship prebuilt bindings and import fine either way.
