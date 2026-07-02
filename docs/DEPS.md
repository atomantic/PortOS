# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

**Last audited:** 2026-04-28 (default mode); tables corrected 2026-07-01 during a docs audit.
**Verdict:** All dependencies justified. Since the last full audit: `sax` was removed (replaced with an owned parser, issue #1824), `portos-ai-toolkit` was vendored in-tree (`server/lib/aiToolkit/`), and monolithic `googleapis` was replaced with scoped `@googleapis/*` packages.

## Audit Methodology

Each dependency is classified into one of three tiers:

- **Tier 1 (ACCEPTABLE)** — large, widely-audited, foundational libraries. Kept without question.
- **Tier 2 (SUSPECT)** — smaller libraries that may be replaceable. Audited for actual usage.
- **Tier 3 (REMOVABLE)** — clear candidates for owned-code replacement.

Before removing a Tier 3 candidate, run a transitive-dep check (`npm ls <pkg>`). If a kept package already pulls the same major version, the candidate is downgraded to **KEEP (transitive)** — direct removal saves no supply chain attack surface.

## Quick Reference Table

| Package | Tier | Verdict | Where Used | Notes |
|---------|------|---------|------------|-------|
| **Root devDeps** | | | | |
| `pm2` | 1 | KEEP | top-level scripts | Process manager, foundational |
| **Server deps** | | | | |
| `@googleapis/calendar` | 1 | KEEP | Calendar integration | Scoped official Google SDK (replaced monolithic `googleapis`) |
| `@googleapis/gmail` | 1 | KEEP | Messages/Gmail integration | Scoped official Google SDK |
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `google-auth-library` | 1 | KEEP | Google OAuth | Pairs with `@googleapis/*` |
| `kokoro-js` | 2 | KEEP | `server/services/voice/tts-kokoro.js` | Only pure-JS in-process TTS; replacement = Python subprocess + pooling |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pdf-lib` | 1 | KEEP | PDF generation/manipulation | |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
| `pm2` | 1 | KEEP | app lifecycle | Process manager |
| `sharp` | 1 | KEEP | image processing | Native, widely-audited |
| `socket.io` | 1 | KEEP | realtime | Foundational |
| `socket.io-client` | 1 | KEEP | server-to-client | Paired with socket.io |
| `undici` | 1 | KEEP | HTTP client | Node core team project |
| `zod` | 1 | KEEP | input validation | Widely-audited |
| **Server devDeps** | | | | |
| `vitest` | 1 | KEEP | test runner | |
| `@vitest/coverage-v8` | 1 | KEEP | coverage | Paired with vitest |
| **Client deps** | | | | |
| `@dnd-kit/core` | 1 | KEEP | drag/drop | |
| `@dnd-kit/sortable` | 1 | KEEP | drag/drop | |
| `@dnd-kit/utilities` | 1 | KEEP | drag/drop helpers | |
| `@react-three/drei` | 1 | KEEP | CyberCity 3D | Three.js helpers |
| `@react-three/fiber` | 1 | KEEP | CyberCity 3D | React renderer for Three |
| `@xterm/xterm` | 1 | KEEP | browser terminal | |
| `@xterm/addon-fit` | 1 | KEEP | xterm sizing | |
| `@xterm/addon-web-links` | 1 | KEEP | xterm links | |
| `lucide-react` | 1 | KEEP | icons | Widely-used |
| `react` | 1 | KEEP | UI | |
| `react-dom` | 1 | KEEP | UI | |
| `react-router-dom` | 1 | KEEP | routing | |
| `recharts` | 1 | KEEP | charts | |
| `socket.io-client` | 1 | KEEP | realtime client | |
| `three` | 1 | KEEP | 3D | |
| **Client devDeps** | | | | |
| `@eslint/js` | 1 | KEEP | linting | |
| `eslint` | 1 | KEEP | linting | |
| `eslint-plugin-react` | 1 | KEEP | linting | |
| `eslint-plugin-react-hooks` | 1 | KEEP | linting | |
| `@tailwindcss/postcss` | 1 | KEEP | styling | |
| `tailwindcss` | 1 | KEEP | styling | |
| `@vitejs/plugin-react` | 1 | KEEP | build | |
| `vite` | 1 | KEEP | build | |
| `vitest` | 1 | KEEP | client test runner | jsdom environment |
| `jsdom` | 1 | KEEP | test DOM | Paired with vitest |
| `@testing-library/jest-dom` | 1 | KEEP | test matchers | |
| `@testing-library/react` | 1 | KEEP | component tests | |
| `@testing-library/user-event` | 1 | KEEP | interaction tests | |
| `rollup-plugin-visualizer` | 2 | KEEP | bundle-size analysis | Dev-only, opt-in |

## Detailed Findings — Tier 2/3 Audits

### `kokoro-js` — KEEP (Tier 2)

- **Usage**: 1 dynamic import in `server/services/voice/tts-kokoro.js` (~80 LOC module). 3 call sites: `KokoroTTS.from_pretrained()`, `tts.generate(text, {voice, speed})`, `audio.toWav()`.
- **Maintenance**: pinned at 1.2.0. Active upstream.
- **Vulns**: None (npm audit clean).
- **Replacement complexity**: Moderate (~50–80 LOC) but requires Python subprocess + JSON IPC + process pooling + lifecycle management. Operational overhead exceeds the supply-chain risk.
- **Decision**: KEEP. The only pure-JS in-process TTS option; Web Speech API is cloud-dependent and Piper requires CLI install.
- **Re-audit trigger**: if maintenance lapses (no publish for >12 months) or a CVE is reported, revisit and migrate to Piper subprocess.

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

Defined in `package.json` (root + server + client) — kept current to dodge known upstream advisories:

- `path-to-regexp@8.4.2`
- `lodash@4.18.1`
- `basic-ftp@6.0.1`
- `follow-redirects@1.16.0`
- `brace-expansion@5.0.5` (root/client; server pins `5.0.6`)
- `js-yaml@4.2.0`
- `qs@6.15.2` (server only)
- `socket.io-parser@4.2.6`
- `protobufjs@7.6.3` + `@protobufjs/utf8@1.1.1`
- `ws@8.21.0`
- `ip-address@10.2.0`
- `picomatch@4.0.4`
- `postcss@8.5.15`
- `systeminformation@5.31.6`
- `minimatch@3 → brace-expansion@1.1.15` (client only, scoped)
- `three@0.184.0` (client only, keeps drei/fiber on one three copy)

These exist purely to force-bump transitive deps; revisit if `npm audit` flags new advisories.
