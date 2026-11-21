import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { staticImportClosure } from '../../../lib/staticImportGraph.js';
import { SERVER_DIR, collectServerSources, readServerSource } from '../../guardSources.js';

const GC_ENTRY = join(SERVER_DIR, 'services', 'orphanedPartialGc.js');

describe('download-slot registration', () => {
  // `isAnyDownloadInFlight` can only answer for slots that have been
  // CONSTRUCTED, and a module's slot is constructed when the module is loaded.
  // So what a slot-claiming download path must still do is be reachable from
  // the GC — the one piece of wiring the shared predicate does not remove.
  // Assert it structurally rather than by convention.
  //
  // Timed out generously: this reads every non-test source under `server/`, the
  // same full-tree scan `importScoping.test.js` documents as slow on CI.
  it('reaches every module that creates a download slot', () => {
    const owners = collectServerSources()
      .filter((rel) => readServerSource(rel).includes('createDownloadSlot('))
      .map((rel) => join(SERVER_DIR, rel));
    // Positive control: a resolver gap must not make this guard look clean.
    expect(owners.length).toBeGreaterThanOrEqual(2);

    const reached = staticImportClosure(GC_ENTRY).files;
    for (const owner of owners) {
      // `downloadPreflight.js` declares the factory; the rest call it.
      if (owner.endsWith(join('lib', 'downloadPreflight.js'))) continue;
      expect(reached.has(owner), `${owner} creates a download slot but orphanedPartialGc.js never loads it, so its live transfers are unprotected`).toBe(true);
    }
  }, 60000);
});
