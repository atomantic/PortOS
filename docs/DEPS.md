# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

The documentation integrity check requires a row for every dependency under the workspace and dependency group that declares it. Remove the row when its declaration is removed. Run the check with `npm test --prefix server -- test/guards/repo.guard.test.js`.

**Last audited:** 2026-11-26.
**Verdict:** Current direct dependencies are listed below with their justification.

## Audit Methodology

Each dependency is classified into one of three tiers:

- **Tier 1 (ACCEPTABLE)** — large, widely-audited, foundational libraries. Kept without question.
- **Tier 2 (SUSPECT)** — smaller libraries that may be replaceable. Audited for actual usage.
- **Tier 3 (REMOVABLE)** — clear candidates for owned-code replacement.

Before removing a Tier 3 candidate, run a transitive-dep check (`npm ls <pkg>`). If a kept package already pulls the same major version, the candidate is downgraded to **KEEP (transitive)** — direct removal saves no supply chain attack surface.

## Quick Reference Table

| Package | Tier | Verdict | Where Used | Notes |
|---------|------|---------|------------|-------|
| **Server dependencies** | | | | |
| `@babel/parser` | 1 | KEEP | JavaScript parsing for server features and developer tools | Parses source without executing it, including for the complexity report and prompt-stage call-site generator |
| `@cantoo/pdf-lib` | 2 | KEEP | PDF generation for the volume / comic / prose / legacy-archive exports | Maintained MIT fork of `pdf-lib`, which has had no publish since 2022-05. Same public API (`PDFDocument`/`rgb`/`StandardFonts`); the swap was 4 import lines. On maintenance watch — see the detailed finding |
| `@novnc/novnc` | 1 | KEEP | PortDeck remote desktop viewer | Mature RFB/VNC protocol implementation; replacing it would require owning multiple security types and framebuffer encodings |
| `better-sqlite3-multiple-ciphers` | 2 | KEEP | `server/services/signalSnapshot.js` — read-only SQLCipher snapshot of the local Signal Desktop database | MIT build of better-sqlite3 with SQLCipher 4 compatibility. Ships prebuilds and sets `gypfile` false, so install does not compile it. `node:sqlite` cannot open SQLCipher, and a main-file copy misses committed WAL frames. A missing prebuild fails that sync closed |
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
| `playwright-core` | 1 | KEEP | `server/services/fableLoom/falVideoAutomation.js` — fal.ai scene video automation | Drives the PortOS-managed browser over CDP (`chromium.connectOverCDP`). `-core` rather than the full `playwright` package deliberately: the browser is provisioned separately by `npm run setup:browser`, so the bundled browser download would be dead weight |
| `pm2` | 1 | KEEP | app lifecycle and top-level scripts | Process manager. The server workspace owns the shared CLI and API installation |
| `sharp` | 1 | KEEP | image processing | Native, widely-audited |
| `socket.io` | 1 | KEEP | realtime | Foundational |
| `socket.io-client` | 1 | KEEP | server-to-client | Paired with socket.io |
| `three` | 1 | KEEP | code film rendering | Supplies the Three.js runtime for generated film pages |
| `ws` | 1 | KEEP | remote desktop + browser WebSockets | Foundational WebSocket transport; also used transitively by Socket.IO |
| `zod` | 1 | KEEP | input validation | Widely-audited |
| **Server devDependencies** | | | | |
| `vitest` | 1 | KEEP | test runner | |
| **Client dependencies** | | | | |
| `@react-three/fiber` | 1 | KEEP | CyberCity 3D | React renderer for Three |
| `@xterm/xterm` | 1 | KEEP | browser terminal | |
| `lucide-react` | 1 | KEEP | icons | Widely-used |
| `react` | 1 | KEEP | UI | |
| `react-dom` | 1 | KEEP | UI | |
| `react-router` | 1 | KEEP | routing | v8 dropped the `react-router-dom` alias package |
| `socket.io-client` | 1 | KEEP | realtime client | |
| `three` | 1 | KEEP | 3D | |
| **Client devDependencies** | | | | |
| `@biomejs/biome` | 1 | KEEP | linting across the repo | Client owns the single installation used for local and CI linting |
| `@tailwindcss/postcss` | 1 | KEEP | styling | |
| `tailwindcss` | 1 | KEEP | styling | |
| `@vitejs/plugin-react` | 1 | KEEP | build | |
| `vite` | 1 | KEEP | build | |
| `vitest` | 1 | KEEP | client test runner | happy-dom environment |
| `happy-dom` | 1 | KEEP | test DOM | Lightweight DOM environment for Vitest |
| `@testing-library/jest-dom` | 1 | KEEP | test matchers | |
| `@testing-library/react` | 1 | KEEP | component tests | |
| `@testing-library/user-event` | 1 | KEEP | interaction tests | |
| `playwright-core` | 1 | KEEP | browser test tooling | Drives the separately provisioned browser for client verification |
| **Browser dependencies** | | | | |
| _(none)_ | — | — | `browser/server.js` | Zero dependencies — Node built-ins only, plus in-repo imports from `server/lib/` and `scripts/lib/`. No Dependabot entry, and its lockfile is gitignored |

## Detailed Findings — Tier 2/3 Audits

### `@cantoo/pdf-lib` — KEEP (Tier 2)

- **Usage**: 4 import sites, all the same named import — `server/services/pipeline/volumePdf.js`, `comicPdf.js`, `proseExport.js`, and `server/services/legacyExport.js` (`import { PDFDocument, rgb, StandardFonts }`). ~40 call sites across them, all in the narrow high-level core: `PDFDocument.create`, `addPage`, `embedFont`, `drawText`, `drawImage`, `widthOfTextAtSize`, `save`, plus `rgb()` and 9 `StandardFonts` constants. No low-level `PDFDict`/`PDFRef` work, no form filling, no encryption, no incremental update.
- **Why the swap**: `pdf-lib@1.17.1` has had **no npm publish since 2022-05-12** — the pinned version and the latest published version are the same release. It is not deprecated and `npm audit` was clean, but it is a parser/serializer for a hostile binary format sitting on the export path for four user-facing pipelines. When a PDF advisory lands there is no upstream release to take. Migrating while audit is green is a planned change; migrating after an advisory is an emergency.
- **The fork**: `@cantoo/pdf-lib` (`github.com/cantoo-scribe/pdf-lib`), same MIT license, pinned `2.9.1`, published 2026-08. It preserves the `PDFDocument` / `rgb` / `StandardFonts` public API, so the migration was 4 import lines + 1 manifest line + the lockfile — no output, layout, font, or page-geometry change.
- **Transitive cost**: `server/package-lock.json` goes 380 → 385 packages (**+5 net**). In: the fork plus `color`, `color-string`, `is-arrayish`, `simple-swizzle`, `html-entities`, `node-html-better-parser`, and a top-level `pako`. Out: `pdf-lib` and its nested `pako` / `tslib` copies. `@pdf-lib/standard-fonts` and `@pdf-lib/upng` **stay** — the fork depends on them too — and so does the top-level `tslib`, which other packages pull. `npm audit` stays at 0 vulnerabilities.
- **Replacement complexity if owned in-tree instead**: Infeasible (300+ lines of font metrics, xref tables, and content-stream encoding) — which is why a maintained fork, not a rewrite, was the decision.
- **Regression cover**: two boundary tests assert real output bytes rather than helper behaviour, because a same-API fork can only regress below the helper layer — `proseExport.test.js` (`buildProsePdf` returns a `Uint8Array` starting `%PDF-` and ending `%%EOF`) and `comicPdf.test.js` (image XObject count scales with the number of embedded pages, catching a silently-dropped `drawImage` payload).
- **Grep caveat for the next audit**: `server/services/legacyExport.js` contains a byte sequence that makes `file(1)` classify it as `data`, so plain `grep -r` **silently skips it** — a repo-wide dependency sweep must use `grep -ra`. That is exactly how the fourth import site was missed when this migration was first scoped; it surfaced only as an `ERR_MODULE_NOT_FOUND` in the suite.
- **Re-audit trigger**: revisit if `@cantoo/pdf-lib` itself goes >12 months without a publish, or on any CVE against it. The fallback is the same shape as the swap in: another maintained fork, or upstream `pdf-lib` if it ever resumes releases.

## Heavy-Mode Notes

If `/do:depfree --heavy` is run, the following Tier 1 entries would drop to Tier 2/3 and become replacement candidates regardless of popularity:

- Many of the `@xterm/*`, `lucide-react` deps would be re-evaluated.
- `pm2` would NOT be replaced (foundational process manager).

This is intentionally NOT done in default mode — current dependency footprint is reasonable for the project's deployment context (single-user, Tailscale-private).

## Extreme-Mode Notes

`/do:depfree --extreme` (and the `better-dependency-freedom` scheduled audit with its removal bar set to **Extreme**) aims at zero dependencies: it forces the strongest model tier at maximum reasoning effort, drops the line ceiling in favor of a parity-test gate, and keeps only what cannot be owned responsibly — the Node runtime and npm, security-sensitive protocol implementations (the `pg` wire protocol and its authentication, TLS), native bindings (`node-pty`, `better-sqlite3-multiple-ciphers`, `sharp`), and the CI-required test runner. Under that bar the following Tier 1 entries become candidates, each needing a written replacement design and a parity suite before any call site switches:

- `express` — the used surface is routing, middleware chaining, static files, and body parsing over `node:http`.
- `socket.io` — the used surface is rooms, acks, and reconnection over WebSocket; a design must cover the client half too.
- `react` / `react-dom` — a product-level rewrite rather than a dependency swap; expected to be recorded `SKIPPED_INFEASIBLE` with a design sketch and a filed issue, which is the mode's required output for a package it cannot remove.
- `@xterm/*`, `lucide-react`, `three` — re-evaluated by used surface, not size.

An extreme run re-tests every `SKIPPED_INFEASIBLE` row here rather than honoring it, so this section is a forecast, not a decision log; the decision log is the tables above, which record the mode each row was reached under.

## Override Pins (`overrides`)

The authoritative current override pins are declared in the [server](../server/package.json) and [client](../client/package.json) manifests. Autofixer uses the server workspace’s Express dependency and lockfile.

These overrides force-bump transitive dependencies to address known upstream advisories. Check the manifests for the current package and workspace list and exact versions; revisit the overrides if `npm audit` flags new advisories.

`server/test/guards/repo/dependency-overrides.test.js` guards the pins themselves (cross-manifest version parity, a `MINIMUM_SAFE` floor per remediated advisory, that every workspace shipping a tracked lockfile is in the governed manifest list, that each tracked lockfile actually resolves the pinned version, and that every pin names a package its own workspace lockfile still contains — so a pin outliving its consumer fails rather than lingering as imaginary protection), but it does not read this document. When a floor moves because a *new* advisory covers the version already pinned — as `js-yaml@4.3.0` did under GHSA-5p4m-2wfm-xmqj — update the authoritative manifest pin and its `MINIMUM_SAFE` row; this document links readers to those sources.

**Check semver headroom before adding a pin.** A pin can only advance the installed version if it is below the top of its permitted range.

## Direct Dependency Pinning

**Every direct dependency and devDependency is an exact version — no `^`, `~`, `>=`, or `*`.** A caret range lets a fresh `npm install` (or any tree re-resolution: a Dependabot bump to a sibling package, `npm run setup`'s cwd-based `npm install --no-save` in `server/`, `scripts/ensure-deps.js`'s clean-reinstall path) float past a version nobody reviewed — the same argument that already makes an override pin exact, applied to the packages this repo depends on directly. Upgrades arrive as reviewable Dependabot PRs instead.

`server/test/guards/repo/dependency-overrides.test.js` enforces this across the server and client manifests, so a dependency added with a caret fails the suite rather than shipping.

## Install-Script Policy

`ignore-scripts=true` is pinned in **every** workspace's own `.npmrc` (root, `client/`, `server/`, `browser/`) — not just the repo root. The list is not maintained by hand: `discoverWorkspaces()` in `scripts/trusted-rebuilds.js` globs every top-level directory carrying a `package.json`, and the test asserts each discovered one has the setting — so a workspace added later is caught rather than silently unguarded. npm resolves the project `.npmrc` from the *local prefix* and never walks up the directory tree, so a root-only setting does not cover `cd client && npm install` or `npm ci --prefix server` (what CI runs). Deleting any workspace `.npmrc` silently re-grants every dependency in that workspace an install-time code-execution slot — the vector the Shai-Hulud worm used.

Packages that legitimately need an install script are named explicitly in the allowlist in `scripts/trusted-rebuilds.js`, the single source consumed by `scripts/setup.js` (behind `npm run setup`, `setup.sh` and `setup.ps1`), `scripts/ensure-deps.js`, `update.sh` / `update.ps1`, and CI. `scripts/trusted-rebuilds.test.js` fails if a workspace `.npmrc` loses the setting, or if a dependency appears with an install hook that nobody has explicitly decided about. Because CI caches `server/node_modules` between jobs, `scripts/trusted-rebuild-stamp.js` writes a mark into the tree in the same step that rebuilds it and checks that mark after a cache restore — a tree cached before the rebuild is otherwise indistinguishable from a good one, since the allowlisted packages all ship prebuilt bindings and import fine either way.

### Install-time dependency patches

None at present. If a patch is ever needed again, the hook point is `rebuildTrusted` in `scripts/trusted-rebuilds.js`, which every managed install path already calls after `npm install` because `ignore-scripts=true` rules out a postinstall hook.

## Inline Audit Policy

`audit=false` is pinned in the same four `.npmrc` files, enforced by the same discovered-workspace test. This turns off only the advisory lookup `npm install` performs *after* it has already resolved and written `node_modules` — it does not change what gets installed.

It is off because it is a hang risk on the path that matters least. The lookup only prints a summary, but npm **blocks** on it, and a request that stalls costs `fetch-timeout` (300s by default) times `fetch-retries` (2) before npm gives up. On 2026-09-03 the endpoint began completing the TLS handshake and then never sending a byte; a warm root install that takes 0.15s took **153.88s**, of which 0.22s was CPU and the rest was a socket wait. At the time, managed install paths ran three workspace installs in sequence (`update.sh`, `update.ps1`, `scripts/setup.js`, `scripts/ensure-deps.js`), so a self-update stalled for roughly ten minutes on a report written to `data/update.log`. PortOS is distributed software that self-updates on machines nobody is watching, so a third-party endpoint must not be able to wedge the update path for something advisory.

Nothing is lost. Dependency safety here is enforced statically rather than by a live network call: direct dependencies are pinned to exact versions and the `overrides` blocks are pinned too, both asserted by `server/test/guards/repo/dependency-overrides.test.js` — which deliberately replaced an `npm audit` shell-out because "audit needs the network and its output drifts". CI never ran `npm audit` either. Run `npm audit` directly when you want the report; the periodic dependency audits recorded in this document are where it belongs.
