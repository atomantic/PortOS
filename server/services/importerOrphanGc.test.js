import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers } from '../lib/mockPathsDataRoot.js';

// Redirect every PATHS member under a per-worker temp root before the
// universe/series/issues stores capture PATHS.data at module init. Same
// pattern as importer.test.js.
const tempRoot = mkdtempSync(join(tmpdir(), 'orphan-gc-test-'));
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const redirectedPaths = Object.fromEntries(
    Object.keys(actual.PATHS).map((k) => [k, join(tempRoot, k)]),
  );
  return { ...actual, PATHS: redirectedPaths };
});

// Suppress live peer fan-out — createUniverse/createSeries can background
// auto-subscribe even for ephemeral fixtures (defense-in-depth).
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

const { sweepOrphanShells, ORPHAN_SHELL_MAX_AGE_MS } = await import('./importerOrphanGc.js');
const universeSvc = await import('./universeBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const issuesSvc = await import('./pipeline/issues.js');

// The update mutators forcibly re-stamp `updatedAt = now`, so backdating a
// record isn't reliable. Instead we pin the sweep's clock to the future, well
// past the grace window from the records' real (just-now) timestamps.
const FUTURE = Date.now() + ORPHAN_SHELL_MAX_AGE_MS + 60_000;

beforeEach(async () => {
  // Hard-delete any records left by a prior test so counts are deterministic.
  for (const s of await seriesSvc.listSeries({ includeDeleted: true })) {
    await seriesSvc.deleteSeries(s.id).catch(() => {});
  }
  for (const u of await universeSvc.listUniverses({ includeDeleted: true })) {
    await universeSvc.deleteUniverse(u.id).catch(() => {});
  }
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('sweepOrphanShells', () => {
  it('removes an aged-out, ephemeral, zero-issue/zero-canon universe + series', async () => {
    const uni = await universeSvc.createUniverse({ name: 'Abandoned U', ephemeral: true, importDraft: true });
    const ser = await seriesSvc.createSeries({ name: 'Abandoned S', universeId: uni.id, ephemeral: true, importDraft: true });

    const { deletedSeries, deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    expect(deletedSeries).toContain(ser.id);
    expect(deletedUniverses).toContain(uni.id);

    await expect(seriesSvc.getSeries(ser.id)).rejects.toThrow();
    await expect(universeSvc.getUniverse(uni.id)).rejects.toThrow();
  });

  it('spares a NON-ephemeral (committed) universe + series even when empty', async () => {
    const uni = await universeSvc.createUniverse({ name: 'Real U' });
    const ser = await seriesSvc.createSeries({ name: 'Real S', universeId: uni.id });

    const { deletedSeries, deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    expect(deletedSeries).not.toContain(ser.id);
    expect(deletedUniverses).not.toContain(uni.id);
  });

  it('spares an ephemeral-but-not-importDraft empty record (user-private, not an import shell)', async () => {
    // `ephemeral` is a general user-settable "keep local / don't sync" marker —
    // a deliberately-private empty universe/series carries it too. The GC must
    // key on `importDraft` (stamped only by analyzeImport), never `ephemeral`
    // alone, or it would silently delete the user's private records.
    const uni = await universeSvc.createUniverse({ name: 'Private U', ephemeral: true });
    const ser = await seriesSvc.createSeries({ name: 'Private S', universeId: uni.id, ephemeral: true });
    expect(uni.importDraft).not.toBe(true);
    expect(ser.importDraft).not.toBe(true);

    const { deletedSeries, deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    expect(deletedSeries).not.toContain(ser.id);
    expect(deletedUniverses).not.toContain(uni.id);
  });

  it('spares an ephemeral shell that is younger than the grace window', async () => {
    const uni = await universeSvc.createUniverse({ name: 'Fresh U', ephemeral: true, importDraft: true });
    const ser = await seriesSvc.createSeries({ name: 'Fresh S', universeId: uni.id, ephemeral: true, importDraft: true });

    // Sweep with the real clock — the records were created just now, so the
    // age gate must spare them.
    const { deletedSeries, deletedUniverses } = await sweepOrphanShells();
    expect(deletedSeries).not.toContain(ser.id);
    expect(deletedUniverses).not.toContain(uni.id);
  });

  it('spares an ephemeral series that still has issues, and its universe', async () => {
    const uni = await universeSvc.createUniverse({ name: 'WithIssues U', ephemeral: true, importDraft: true });
    const ser = await seriesSvc.createSeries({ name: 'WithIssues S', universeId: uni.id, ephemeral: true, importDraft: true });
    await issuesSvc.createIssue({ seriesId: ser.id, title: 'A', arcPosition: 1 });

    const { deletedSeries, deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    expect(deletedSeries).not.toContain(ser.id);
    // Universe must be spared too — it still has a live series.
    expect(deletedUniverses).not.toContain(uni.id);
  });

  it('spares an ephemeral universe that has canon entities', async () => {
    const uni = await universeSvc.createUniverse({
      name: 'WithCanon U',
      ephemeral: true, importDraft: true,
      characters: [{ name: 'Aria' }],
    });

    const { deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    expect(deletedUniverses).not.toContain(uni.id);
  });

  it('does not remove a shared universe when one of its ephemeral series is GC-able but a committed one survives', async () => {
    const uni = await universeSvc.createUniverse({ name: 'Shared U', ephemeral: true, importDraft: true });
    const orphanSer = await seriesSvc.createSeries({ name: 'Orphan S', universeId: uni.id, ephemeral: true, importDraft: true });
    const committedSer = await seriesSvc.createSeries({ name: 'Committed S', universeId: uni.id });

    const { deletedSeries, deletedUniverses } = await sweepOrphanShells({ now: FUTURE });
    // The orphan ephemeral series is swept...
    expect(deletedSeries).toContain(orphanSer.id);
    // ...but the universe stays because a committed series still lives in it.
    expect(deletedUniverses).not.toContain(uni.id);
    expect(deletedSeries).not.toContain(committedSer.id);
  });
});
