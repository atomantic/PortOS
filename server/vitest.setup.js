/**
 * Global Vitest setup — peer fan-out firewall.
 *
 * WHY: `createUniverse` / `createSeries` / `createIssue` fire a non-awaited
 * `autoSubscribeRecordToAllPeers` call after creation — through the
 * `recordEvents.js` subscription adapter, which is a no-op until a suite
 * loads `peerSync.js` (whose module-load registration wires in the real
 * implementation).  The real path reads `data/instances.json` via
 * `getPeers()` and then issues live HTTP POSTs to any registered peers
 * (e.g. the user's `null` sync machine).  Without a global guard, any suite
 * that loads the peer-sync graph would create spurious records on live peers.
 *
 * Forcing `getPeers → []` is sufficient to stop the fan-out on its own:
 * `autoSubscribeRecordToAllPeers` early-returns the moment the target list is
 * empty, before any `subscribePeer`/HTTP work — so even a *registered* real
 * adapter issues no network calls.  A suite only needs the additional
 * `peerSync.js` mock (per the AGENTS.md convention) when it imports the
 * peer-sync graph and wants to keep the registration side effect out
 * entirely; suites that never load `peerSync.js` get a no-op adapter for free.
 *
 * WHAT: This file is loaded by Vitest as a `setupFiles` entry (see
 * `vitest.config.js`).  It registers a global `vi.mock` for
 * `services/instances.js` that forces `getPeers` to return `[]` while
 * preserving all other real exports via `importActual`.  Uses the shared
 * `mockNoPeers` helper from `lib/mockPathsDataRoot.js` — the same factory
 * the existing point-fix mocks use — so the behavior is identical.
 *
 * SCOPE: The mock is applied before every test file.  All test files that
 * already call `vi.mock('./instances.js', …)` (or `vi.mock('../instances.js',
 * …)`) at their own file level will have their per-suite factory win over this
 * global one — Vitest resolves both to the same module path and the last
 * registered factory for a module wins per-suite.  Those existing point-fix
 * mocks therefore remain harmless and do not need to be removed.
 *
 * OPT-OUT (rare — only needed when a suite tests the real `instances.js`
 * implementation, such as `instances.test.js`):
 *
 *   Option A — cancel the global mock so the real module is used; mock its
 *   own dependencies instead to make behaviour deterministic:
 *
 *     vi.unmock('./instances.js');   // path relative to the test file; hoisted
 *
 *   Option B — keep the mock but replace getPeers with a vi.fn() so the suite
 *   can control per-test return values (used by syncOrchestrator, peerSync, …):
 *
 *     vi.mock('./instances.js', () => ({ getPeers: vi.fn(), … }));
 *
 *   Both forms are standard Vitest patterns; no helper or flag is needed.
 *   See `server/services/instances.test.js` (Option A) and the sharing/
 *   suites (Option B) for working examples.
 */

import { vi, afterAll } from 'vitest';
import { rmSync } from 'fs';
import { mockNoPeers } from './lib/mockPathsDataRoot.js';
import './test/admissionSetup.js';

// The server intentionally logs expected error paths, lifecycle transitions,
// and fallback decisions. With console interception disabled (see the config),
// `--silent=passed-only` cannot suppress those lines: PR #5296 emitted 15,355
// log lines for a completely green run. CI sets this opt-in flag so reporter
// output stays useful; local runs retain every log for debugging. Tests that
// assert logging still work because vi.spyOn records calls to these no-ops.
if (process.env.PORTOS_TEST_QUIET === '1') {
  for (const method of ['log', 'info', 'warn', 'error']) {
    console[method] = () => {};
  }
}

// Path is relative to the project root (server/) as required by Vitest
// setupFiles resolution — it resolves to the same module as any
// `./instances.js` or `../instances.js` reference used in test files.
vi.mock('./services/instances.js', async (importOriginal) => {
  const actual = await importOriginal();
  return mockNoPeers(actual);
});

// Wipe the shared git fixture templates (`lib/gitTestRepo.js`) after each
// test file (#9000). Vitest isolates the module graph per file, so every file
// that uses the helper builds its own template, and the helper's
// `process.on('exit')` hook never fires when the pool tears a worker down.
// Without this, one `portos-git-template-*` dir leaked per file per run.
// Read from globalThis rather than importing the helper, so files that never
// touch git don't pay for its import graph.
afterAll(() => {
  const dirs = globalThis.__portosGitTemplateDirs;
  if (!Array.isArray(dirs)) return;
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});
