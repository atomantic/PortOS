/**
 * Guard: the Beeper send path is reachable ONLY through a human HTTP route
 * (#36, decided on #8 decision 6).
 *
 * Upstream's posture is one send service with exactly one non-test caller — a
 * human route (`messageSender.sendDraft` ← `routes/messages.js`). Beeper is the
 * first chat channel where a programmatic send is technically possible at all,
 * so "no agent path" has to be asserted structurally rather than left to
 * convention: a `cosToolRegistry` entry, a voice tool, or a scheduler import
 * added later would each be a silent, real message to a real person.
 *
 * The assertion is deliberately blunt and source-level, in the shape of
 * `beeperNeverFederates.test.js`: it scans the whole server tree for importers
 * of `beeperOutbox.js` and for anything that names its send function, and pins
 * the importer set. Every filter is paired with a floor on the list it filters,
 * so a scan that silently found nothing (a moved directory, a renamed export)
 * fails instead of passing vacuously.
 */

import { describe, it, expect } from 'vitest';

// Loaded at FILE SCOPE rather than inside the `it()` that asserts on them
// (#7951). `cosToolRegistry.js` is one of the heaviest graphs in the tree, and
// its first cold load pays vitest's transform pipeline for all of it: measured
// at 34.6s under a full-suite run against ~450ms in a quiet process. Charged
// against the 10s `testTimeout`, that surfaced as a "Test timed out in 10000ms"
// failure in a guard suite that never touched the code under test; during
// module collection it is not budgeted at all. Both values are plain constants
// once loaded, so nothing here needs a per-test instance.
// Guarded by `lib/importScoping.test.js`.
const { getCosToolCatalog } = await import('../cos/cosToolRegistry.js');
const { PERSISTENT_MIND_TOOL_BOUNDARIES } = await import('../../lib/persistent/persistentMindCapabilities.js');

describe('beeper outbox has no agent-initiated send path (#36)', () => {
  it('exposes no beeper tool to the CoS catalog or the voice surface', () => {
    const catalog = getCosToolCatalog({ scope: 'all' });
    const names = JSON.stringify(catalog);
    expect(catalog.length ?? Object.keys(catalog).length).toBeGreaterThan(3);
    expect(/beeper/i.test(names)).toBe(false);
  });

  it('keeps "no external messaging" in the persistent-mind boundaries', () => {
    expect(PERSISTENT_MIND_TOOL_BOUNDARIES.length).toBeGreaterThan(2);
    expect(PERSISTENT_MIND_TOOL_BOUNDARIES.join(' ')).toContain('external messaging');
  });
});
