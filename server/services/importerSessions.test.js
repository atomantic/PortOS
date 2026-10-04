import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots,
} from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-importer-sessions-store-') }));

const {
  deriveImportId, getImportSession, recordImportProgress, withImportLock, IMPORT_SESSION_MAX,
} = await import('./importerSessions.js');

const STORE = join(lazyTempDataRoot('portos-importer-sessions-store-'), 'importer-sessions.json');
const idFor = (n) => `imp-${n.toString(16).padStart(32, '0')}`;

beforeEach(() => {
  rmSync(STORE, { force: true });
  mkdirSync(join(STORE, '..'), { recursive: true });
});
afterAll(cleanupTempDataRoots);

describe('deriveImportId', () => {
  it('is stable across line endings and surrounding whitespace, so a re-paste lands on the same session', () => {
    const id = deriveImportId({ seriesId: 'ser-1', source: 'Line one.\nLine two.' });
    expect(id).toMatch(/^imp-[0-9a-f]{32}$/);
    expect(deriveImportId({ seriesId: 'ser-1', source: '  Line one.\r\nLine two.\n\n' })).toBe(id);
  });

  it('separates a different manuscript, and the same manuscript in a different series', () => {
    const id = deriveImportId({ seriesId: 'ser-1', source: 'Text A' });
    expect(deriveImportId({ seriesId: 'ser-1', source: 'Text B' })).not.toBe(id);
    expect(deriveImportId({ seriesId: 'ser-2', source: 'Text A' })).not.toBe(id);
  });
});

describe('session store', () => {
  it('upserts progress, keeping what an earlier step recorded', async () => {
    const id = idFor(1);
    await recordImportProgress(id, { seriesId: 'ser-1', universeId: 'uni-1', status: 'arc-persisted' });
    await recordImportProgress(id, { status: 'committed', createdIssueIds: ['iss-1'] });

    expect(await getImportSession(id)).toMatchObject({
      id, seriesId: 'ser-1', universeId: 'uni-1', status: 'committed', createdIssueIds: ['iss-1'],
    });
  });

  it('keeps only the newest sessions, evicting the oldest first', async () => {
    const seeded = Object.fromEntries(Array.from({ length: IMPORT_SESSION_MAX }, (_, i) => [idFor(i), {
      seriesId: 'ser-1', status: 'committed', createdIssueIds: ['iss-1'],
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }]));
    writeFileSync(STORE, JSON.stringify({ version: 1, sessions: seeded }));

    await recordImportProgress(idFor(IMPORT_SESSION_MAX), { seriesId: 'ser-1', status: 'arc-persisted' });

    expect(await getImportSession(idFor(0))).toBeNull();
    expect(await getImportSession(idFor(1))).not.toBeNull();
    expect(await getImportSession(idFor(IMPORT_SESSION_MAX))).not.toBeNull();
    expect(Object.keys(JSON.parse(readFileSync(STORE, 'utf8')).sessions)).toHaveLength(IMPORT_SESSION_MAX);
  });

  it('reads a file from another schema version as empty rather than half-reading it', async () => {
    writeFileSync(STORE, JSON.stringify({
      version: 2, sessions: { [idFor(1)]: { seriesId: 'ser-1', status: 'committed' } },
    }));
    expect(await getImportSession(idFor(1))).toBeNull();
  });

  it('refuses to overwrite a file it cannot parse', async () => {
    writeFileSync(STORE, '{ not json');
    await expect(recordImportProgress(idFor(1), { seriesId: 'ser-1', status: 'committed' })).rejects.toThrow();
    expect(readFileSync(STORE, 'utf8')).toBe('{ not json');
  });

  it('rejects a malformed import id instead of keying the file by it', async () => {
    await expect(recordImportProgress('../escape', { seriesId: 'ser-1', status: 'committed' })).rejects.toThrow(/Invalid import id/);
    expect(await getImportSession('../escape')).toBeNull();
  });
});

describe('withImportLock', () => {
  it('runs one import id at a time, in call order, even when an earlier run fails', async () => {
    const order = [];
    const run = (label, ms, fail = false) => withImportLock(idFor(9), async () => {
      order.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${label}`);
      if (fail) throw new Error('boom');
    });

    const results = await Promise.allSettled([run('a', 20, true), run('b', 0)]);

    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});
