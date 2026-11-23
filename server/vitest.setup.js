/**
 * Global Vitest setup — peer fan-out firewall.
 *
 * `createUniverse` / `createSeries` / `createIssue` fire a non-awaited
 * `autoSubscribeRecordToAllPeers` that, once `peerSync.js` is loaded, issues live
 * HTTP POSTs to registered peers. Forcing `getPeers → []` stops it (it
 * early-returns on an empty list): a global `vi.mock` of `services/instances.js`
 * via the shared `mockNoPeers`. A suite's own file-level mock wins.
 * OPT-OUT for suites testing the real module: `vi.unmock('./instances.js')`, or
 * `vi.mock('./instances.js', () => ({ getPeers: vi.fn(), … }))` for per-test control.
 */

import { vi, afterAll, afterEach } from 'vitest';
import { mockNoPeers } from './lib/mockPathsDataRoot.js';
import { drainDetachedWrites } from './lib/fileWriteQueue.js';
import './test/admissionSetup.js';

// A per-file environment override must not silently bypass registry isolation.
// The configured node environment owns cleanup even for skipped/failed imports.
if (!process.env.PORTOS_MEDIA_MODELS_FILE) {
  throw new Error('Server tests require the configured media registry environment or an explicit registry fixture');
}

// With console interception off (see the config) `--silent=passed-only` can't suppress
// expected logs; CI sets this flag to keep output useful. vi.spyOn on the no-ops still records.
if (process.env.PORTOS_TEST_QUIET === '1') {
  for (const method of ['log', 'info', 'warn', 'error']) {
    console[method] = () => {};
  }
}

// Relative to the project root (server/) as Vitest setupFiles resolution requires.
vi.mock('./services/instances.js', async (importOriginal) => {
  const actual = await importOriginal();
  return mockNoPeers(actual);
});

// A settings save queues its ledger row (#12018); running after each test keeps temp-root teardown from racing it.
afterEach(() => drainDetachedWrites());

// Wipe shared git fixture templates (`lib/gitTestRepo.js`) after each file (#9000):
// the helper's `process.on('exit')` never fires when the pool kills a worker.
afterAll(async () => {
  await globalThis.__portosCleanupGitTemplates?.();
  // Prefer the release path once a supervisor exists. A compiler timeout
  // already failed the case that needed containment; other holds still throw.
  if (globalThis.__portosReleaseGitSupervisor) await globalThis.__portosReleaseGitSupervisor();
  else await globalThis.__portosGitSupervisorCleanup?.();
});
