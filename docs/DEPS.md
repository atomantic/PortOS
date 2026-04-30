# Dependency Audit (DEPS.md)

Living reference of every third-party dependency in PortOS, why it's kept, and what the current verdict is. Updated by `/do:depfree` runs.

**Last audited:** 2026-04-28 (default mode)
**Verdict:** All dependencies justified. 0 removals.

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
| `express` | 1 | KEEP | `server/index.js` + routes | Framework |
| `googleapis` | 1 | KEEP | Google integrations | Official Google SDK |
| `kokoro-js` | 2 | KEEP | `server/services/voice/tts-kokoro.js` | Only pure-JS in-process TTS; replacement = Python subprocess + pooling |
| `node-pty` | 1 | KEEP | shell/terminal services | Native PTY binding (N-API) |
| `pg` | 1 | KEEP | Postgres access | Official `pg` driver |
| `pm2` | 1 | KEEP | app lifecycle | Process manager |
| `portos-ai-toolkit` | 1 | KEEP | provider mgmt, prompts | Owned by author (separate repo) |
| `sax` | 3 → KEEP (transitive) | KEEP | `claudeChangelog.js`, `appleHealthXml.js` | Pulled by `pm2 → needle@2.4.0 → sax@1.4.4` (deduped) — direct removal saves nothing |
| `socket.io` | 1 | KEEP | realtime | Foundational |
| `socket.io-client` | 1 | KEEP | server-to-client | Paired with socket.io |
| `ws` | 1 | KEEP | raw WebSocket | Widely-audited |
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

## Detailed Findings — Tier 2/3 Audits

### `kokoro-js` — KEEP (Tier 2)

- **Usage**: 1 dynamic import in `server/services/voice/tts-kokoro.js` (~80 LOC module). 3 call sites: `KokoroTTS.from_pretrained()`, `tts.generate(text, {voice, speed})`, `audio.toWav()`.
- **Maintenance**: 1.2.1 published 2025-05-03. Active.
- **Vulns**: None (npm audit clean).
- **Replacement complexity**: Moderate (~50–80 LOC) but requires Python subprocess + JSON IPC + process pooling + lifecycle management. Operational overhead exceeds the supply-chain risk.
- **Decision**: KEEP. The only pure-JS in-process TTS option; Web Speech API is cloud-dependent and Piper requires CLI install.
- **Re-audit trigger**: if maintenance lapses (no publish for >12 months) or a CVE is reported, revisit and migrate to Piper subprocess.

### `sax` — KEEP (Transitive)

- **Direct usage**: 2 files — `server/services/claudeChangelog.js` (Atom feed parsing, ~5 events) and `server/services/appleHealthXml.js` (streaming Apple Health export, 3 event types on shallow `<record>` elements).
- **Initial verdict**: REMOVE. ~100 LOC of owned regex+state-machine parser would suffice for both use cases.
- **Transitive check**: `npm ls sax` →
  ```
  portos-server@1.7.1
  ├─┬ pm2@5.4.3
  │ └─┬ needle@2.4.0
  │   └── sax@1.4.4 deduped
  └── sax@1.4.4
  ```
- **Reversal reason**: same major version (1.4.4) deduped via pm2→needle. Removing the direct dep leaves the package in `node_modules` with identical attack surface. No consolidation target (no other XML parser kept).
- **Decision**: KEEP (transitive).
- **Re-audit trigger**: if `pm2`/`needle` drops sax (check on each pm2 major bump), revisit and replace with owned code.

## Heavy-Mode Notes

If `/do:depfree --heavy` is run, the following Tier 1 entries would drop to Tier 2/3 and become replacement candidates regardless of popularity:

- `googleapis` — narrow surface used; could be replaced with direct REST calls + owned auth.
- Many of the `@dnd-kit/*`, `@xterm/*`, `lucide-react`, `recharts` deps would be re-evaluated.
- `pm2` would NOT be replaced (foundational process manager) but its transitive `needle`/`sax` chain would still be considered "out of scope" since pm2 itself is kept.

This is intentionally NOT done in default mode — current dependency footprint is reasonable for the project's deployment context (single-user, Tailscale-private).

## Override Pins (`overrides`)

Defined in `package.json` (root + server + client) — kept current to dodge known upstream advisories:

- `path-to-regexp@8.4.2`
- `lodash@4.18.1`
- `basic-ftp@5.3.0`
- `follow-redirects@1.16.0`
- `brace-expansion@5.0.5`
- `socket.io-parser@4.2.6`
- `minimatch@3 → brace-expansion@1.1.12` (client only, scoped)

These exist purely to force-bump transitive deps; revisit if `npm audit` flags new advisories.
